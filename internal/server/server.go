// Package server exposes the vault over a local HTTP API and serves the UI.
package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/justinkadima/collector/internal/config"
	"github.com/justinkadima/collector/internal/index"
	"github.com/justinkadima/collector/internal/vault"
)

type Server struct {
	store *config.Store
	web   fs.FS
	token string

	mu        sync.RWMutex // guards v, idx, watcher replacement
	v         *vault.Vault
	idx       *index.Index
	watcher   *fsnotify.Watcher
	watchDone chan struct{}

	writtenMu sync.Mutex
	written   map[string]writtenFile // what our own writes left on disk

	subsMu sync.Mutex
	subs   map[chan []byte]struct{}

	httpSrv *http.Server
	ln      net.Listener
}

func New(store *config.Store, web fs.FS, token string) *Server {
	if token == "" {
		token = randomToken()
	}
	return &Server{
		store:   store,
		web:     web,
		token:   token,
		written: map[string]writtenFile{},
		subs:    map[chan []byte]struct{}{},
	}
}

func randomToken() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}

func (s *Server) Token() string { return s.token }

// Listen starts the HTTP server on a random localhost port and returns its URL.
func (s *Server) Listen(port int) (string, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return "", err
	}
	s.ln = ln
	s.httpSrv = &http.Server{Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := s.httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Printf("http: %v", err)
		}
	}()
	return fmt.Sprintf("http://%s/?t=%s", ln.Addr().String(), s.token), nil
}

func (s *Server) Close() error {
	s.stopWatching()
	s.mu.Lock()
	if s.idx != nil {
		s.idx.Close()
		s.idx = nil
	}
	s.mu.Unlock()
	if s.httpSrv != nil {
		return s.httpSrv.Close()
	}
	return nil
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	auth := s.requireToken

	mux.HandleFunc("GET /api/bootstrap", auth(s.handleBootstrap))
	mux.HandleFunc("POST /api/workspace", auth(s.handleOpenWorkspace))
	mux.HandleFunc("POST /api/workspace/pick", auth(s.handlePickFolder))
	mux.HandleFunc("GET /api/tree", auth(s.handleTree))
	mux.HandleFunc("GET /api/page", auth(s.handleGetPage))
	mux.HandleFunc("PUT /api/page", auth(s.handleSavePage))
	mux.HandleFunc("POST /api/page", auth(s.handleCreate))
	mux.HandleFunc("POST /api/rename", auth(s.handleRename))
	mux.HandleFunc("POST /api/move", auth(s.handleMove))
	mux.HandleFunc("POST /api/delete", auth(s.handleDelete))
	mux.HandleFunc("GET /api/db", auth(s.handleGetDB))
	mux.HandleFunc("POST /api/db", auth(s.handleSetView))
	mux.HandleFunc("POST /api/db/row", auth(s.handleAddRow))
	mux.HandleFunc("POST /api/prop", auth(s.handleSetProp))
	mux.HandleFunc("GET /api/search", auth(s.handleSearch))
	mux.HandleFunc("GET /api/pages", auth(s.handlePages))
	mux.HandleFunc("GET /api/agenda", auth(s.handleAgenda))
	mux.HandleFunc("GET /api/recent", auth(s.handleRecent))
	mux.HandleFunc("GET /api/backlinks", auth(s.handleBacklinks))
	mux.HandleFunc("GET /api/resolve", auth(s.handleResolve))
	mux.HandleFunc("GET /api/events", auth(s.handleEvents))
	mux.HandleFunc("GET /api/config", auth(s.handleGetConfig))
	mux.HandleFunc("POST /api/config", auth(s.handleSetConfig))
	mux.HandleFunc("POST /api/reveal", auth(s.handleReveal))
	mux.HandleFunc("POST /api/open-external", auth(s.handleOpenExternal))
	mux.HandleFunc("POST /api/attach", auth(s.handleAttach))
	mux.HandleFunc("POST /api/upload", auth(s.handleUpload))
	mux.HandleFunc("POST /api/bookmark", auth(s.handleBookmark))
	mux.HandleFunc("POST /api/open-file", auth(s.handleOpenFile))
	mux.HandleFunc("POST /api/export", auth(s.handleExport))
	mux.HandleFunc("GET /files", auth(s.handleFile))

	fileServer := http.FileServer(http.FS(s.web))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		fileServer.ServeHTTP(w, r)
	})
	return withLogging(mux)
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.URL.Path != "/api/events" {
			log.Printf("%s %s", r.Method, r.URL.Path)
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireToken(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tok := r.Header.Get("X-Collector-Token")
		if tok == "" {
			tok = r.URL.Query().Get("t")
		}
		if tok != s.token {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next(w, r)
	}
}

// ---- workspace lifecycle ----

type bootstrapResp struct {
	Workspace        string            `json:"workspace"`
	NeedsWorkspace   bool              `json:"needsWorkspace"`
	Tree             *vault.Node       `json:"tree,omitempty"`
	RecentWorkspaces []string          `json:"recentWorkspaces"`
	RecentPages      []index.Hit       `json:"recentPages"`
	Icons            map[string]string `json:"icons,omitempty"`
	PageCount        int               `json:"pageCount"`
	Theme            string            `json:"theme"`
	SidebarWidth     int               `json:"sidebarWidth"`
}

func (s *Server) bootstrap() bootstrapResp {
	cfg := s.store.Get()
	out := bootstrapResp{
		RecentWorkspaces: cfg.Recent,
		Theme:            cfg.Theme,
		SidebarWidth:     cfg.SidebarWidth,
	}
	if out.RecentWorkspaces == nil {
		out.RecentWorkspaces = []string{}
	}
	s.mu.RLock()
	v, ix := s.v, s.idx
	s.mu.RUnlock()
	if v == nil || ix == nil {
		out.NeedsWorkspace = true
		return out
	}
	out.Workspace = v.Root()
	if tree, err := v.Tree(); err == nil {
		out.Tree = tree
	}
	if recent, err := ix.Recent(10); err == nil {
		out.RecentPages = recent
	}
	out.Icons = ix.Icons()
	if n, err := ix.Count(); err == nil {
		out.PageCount = n
	}
	return out
}

// OpenWorkspace points the app at a folder, building the index and watcher.
func (s *Server) OpenWorkspace(root string) (bootstrapResp, error) {
	root = expandPath(root)
	abs, err := filepath.Abs(root)
	if err != nil {
		return bootstrapResp{}, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return bootstrapResp{}, fmt.Errorf("cannot open %s: %w", abs, err)
	}
	if !st.IsDir() {
		return bootstrapResp{}, fmt.Errorf("%s is not a folder", abs)
	}

	s.mu.Lock()
	if s.v != nil && s.v.Root() == abs && s.idx != nil {
		s.mu.Unlock()
		return s.bootstrap(), nil
	}
	s.stopWatchingLocked()
	if s.idx != nil {
		s.idx.Close()
		s.idx = nil
	}
	v, err := vault.New(abs)
	if err != nil {
		s.mu.Unlock()
		return bootstrapResp{}, err
	}
	ix, err := index.Open(v.IndexPath())
	if err != nil {
		s.mu.Unlock()
		return bootstrapResp{}, err
	}
	pages, err := v.AllPages()
	if err == nil {
		err = ix.ReplaceAll(pages)
	}
	if err != nil {
		ix.Close()
		s.mu.Unlock()
		return bootstrapResp{}, err
	}
	s.v, s.idx = v, ix
	s.startWatchingLocked(v)
	s.mu.Unlock()

	s.store.AddRecent(abs)
	return s.bootstrap(), nil
}

func expandPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return p
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		if home, err := os.UserHomeDir(); err == nil {
			return filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}

// ---- fs watching ----

func (s *Server) startWatchingLocked(v *vault.Vault) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("watcher: %v", err)
		return
	}
	if err := addRecursive(w, v.Root()); err != nil {
		log.Printf("watch %s: %v", v.Root(), err)
	}
	done := make(chan struct{})
	s.watcher, s.watchDone = w, done
	go s.watchLoop(v, w, done)
}

func (s *Server) stopWatching() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopWatchingLocked()
}

func (s *Server) stopWatchingLocked() {
	if s.watchDone != nil {
		close(s.watchDone)
		s.watchDone = nil
	}
	if s.watcher != nil {
		s.watcher.Close()
		s.watcher = nil
	}
}

func addRecursive(w *fsnotify.Watcher, root string) error {
	return filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		name := d.Name()
		if p != root && (strings.HasPrefix(name, ".") || ignoredDir(name)) {
			return filepath.SkipDir
		}
		return w.Add(p)
	})
}

func ignoredDir(name string) bool {
	switch name {
	case ".collector", ".not1", ".git", ".obsidian", ".trash", "node_modules", ".idea", ".vscode", "__pycache__":
		return true
	}
	return false
}

// watchLoop debounces filesystem events and refreshes the index. External
// edits (another editor, git checkout, Obsidian) show up without a restart.
func (s *Server) watchLoop(v *vault.Vault, w *fsnotify.Watcher, done chan struct{}) {
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	pending := map[string]struct{}{}

	for {
		select {
		case <-done:
			return
		case ev, ok := <-w.Events:
			if !ok {
				return
			}
			if ev.Op&(fsnotify.Create|fsnotify.Rename) != 0 {
				if st, err := os.Stat(ev.Name); err == nil && st.IsDir() && !ignoredDir(filepath.Base(ev.Name)) {
					_ = addRecursive(w, ev.Name)
				}
			}
			if rel, ok := v.RelOf(ev.Name); ok {
				if strings.HasPrefix(rel, "../") {
					continue
				}
				if parts := strings.Split(rel, "/"); len(parts) > 0 && strings.HasPrefix(parts[0], ".") {
					continue
				}
				pending[rel] = struct{}{}
			}
		case err, ok := <-w.Errors:
			if !ok {
				return
			}
			log.Printf("watcher: %v", err)
		case <-ticker.C:
			if len(pending) == 0 {
				continue
			}
			rels := make([]string, 0, len(pending))
			for r := range pending {
				rels = append(rels, r)
			}
			pending = map[string]struct{}{}
			s.applyExternalChanges(v, rels)
		}
	}
}

func (s *Server) applyExternalChanges(v *vault.Vault, rels []string) {
	sort.Strings(rels)
	changed := make([]string, 0, len(rels))
	touched := make([]string, 0, 1)
	s.mu.Lock()
	ix := s.idx
	if ix == nil || s.v != v {
		s.mu.Unlock()
		return
	}
	for _, rel := range rels {
		if hiddenRel(rel) {
			continue
		}
		abs, absErr := v.Abs(rel)
		var st os.FileInfo
		var err error
		if absErr == nil {
			st, err = os.Stat(abs)
		} else {
			err = absErr
		}
		switch {
		case err != nil:
			if s.wroteRecently(rel) {
				break
			}
			if err := ix.Remove(rel); err == nil {
				changed = append(changed, rel)
			}
		case st.IsDir():
			if s.wroteRecently(rel) {
				break
			}
			changed = append(changed, rel)
		case strings.EqualFold(filepath.Ext(rel), ".md"):
			p, rerr := v.Read(rel)
			if rerr != nil {
				break
			}
			// Our own write is recognised by its bytes: what comes back off the
			// disk is what we just put there, and the index already has it.
			if s.wroteThis(rel, p.Hash, p.ModTime) {
				break
			}
			// A sync client re-materialises a file without changing a byte of
			// it, and an editor can save a document it did not edit: the stamp
			// moves and the page does not. Take the new stamp, say "touch", and
			// leave whatever the reader has open exactly where it is.
			if old, ok, _ := ix.Stamp(rel); ok && old.Hash != "" && old.Hash == p.Hash {
				if old.ModTime != p.ModTime || old.Size != p.Size {
					if err := ix.Touch(rel, p.Hash, p.ModTime, p.Size); err == nil {
						touched = append(touched, rel)
					}
				}
				break
			}
			if err := ix.Upsert(p); err == nil {
				changed = append(changed, rel)
			}
		default:
			if s.wroteRecently(rel) {
				break
			}
			changed = append(changed, rel)
		}
	}
	if len(changed) > 0 {
		_ = ix.Reindex()
	}
	s.mu.Unlock()

	if len(changed) > 0 {
		s.broadcast(map[string]any{"type": "fs", "paths": changed})
	}
	if len(touched) > 0 {
		s.broadcast(map[string]any{"type": "touch", "paths": touched})
	}
}

// hiddenRel reports paths nobody edits: dotfiles and the temp files a write
// leaves behind. They are not pages and never worth announcing.
func hiddenRel(rel string) bool {
	for _, part := range strings.Split(rel, "/") {
		if strings.HasPrefix(part, ".") {
			return true
		}
	}
	return false
}

// writtenFile is a file this server just wrote: its bytes, its stamp, and when.
// The bytes make the record exact — a file that still holds what we put there is
// ours whatever the clock says, and one that holds anything else is news even if
// it arrived a moment after we saved. The stamp is part of it because an
// identical rewrite by another writer (a sync client putting the same bytes
// back) must not be mistaken for ours: its stamp is different, and the reader's
// editor deserves to be told the file moved.
type writtenFile struct {
	hash    string
	modTime int64
	size    int64
	at      time.Time
}

func (s *Server) markWritten(paths ...string) {
	s.mu.RLock()
	v := s.v
	s.mu.RUnlock()
	s.writtenMu.Lock()
	defer s.writtenMu.Unlock()
	now := time.Now()
	for _, p := range paths {
		if p == "" {
			continue
		}
		rec := writtenFile{at: now}
		if v != nil {
			if abs, err := v.Abs(p); err == nil {
				if raw, err := os.ReadFile(abs); err == nil {
					rec.hash = vault.HashBytes(raw)
					if st, err := os.Stat(abs); err == nil {
						rec.modTime = st.ModTime().UnixMilli()
						rec.size = st.Size()
					}
				}
			}
		}
		s.written[p] = rec
		// Writing a page bumps the mtime of its folder, which the watcher
		// reports as a separate change. Mark the folder too so our own writes
		// don't come back as an external edit.
		if dir := path.Dir(p); dir != "." && dir != "/" {
			if _, ok := s.written[dir]; !ok {
				s.written[dir] = writtenFile{at: now}
			}
		}
	}
	for p, rec := range s.written {
		if now.Sub(rec.at) > 10*time.Second {
			delete(s.written, p)
		}
	}
}

// wroteThis reports whether this is the file we put there ourselves: the same
// bytes, still carrying the stamp our write gave them.
func (s *Server) wroteThis(p, hash string, modTime int64) bool {
	s.writtenMu.Lock()
	defer s.writtenMu.Unlock()
	rec, ok := s.written[p]
	if !ok {
		return false
	}
	if rec.hash == "" || rec.hash != hash || rec.modTime != modTime || time.Since(rec.at) > 10*time.Second {
		return false
	}
	delete(s.written, p)
	return true
}

// wroteRecently is for paths with no digest of their own: folders and
// attachments, where a name is all we have.
func (s *Server) wroteRecently(p string) bool {
	s.writtenMu.Lock()
	defer s.writtenMu.Unlock()
	rec, ok := s.written[p]
	if !ok {
		return false
	}
	if rec.hash != "" || time.Since(rec.at) > 1500*time.Millisecond {
		delete(s.written, p)
		return false
	}
	return true
}

// ---- SSE ----

func (s *Server) broadcast(v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	s.subsMu.Lock()
	defer s.subsMu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- b:
		default:
		}
	}
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")

	ch := make(chan []byte, 16)
	s.subsMu.Lock()
	s.subs[ch] = struct{}{}
	s.subsMu.Unlock()
	defer func() {
		s.subsMu.Lock()
		delete(s.subs, ch)
		s.subsMu.Unlock()
	}()

	fmt.Fprint(w, ": connected\n\n")
	fl.Flush()

	ping := time.NewTicker(25 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			if _, err := fmt.Fprintf(w, "data: %s\n\n", msg); err != nil {
				return
			}
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

// ---- files & native helpers ----

func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	rel := r.URL.Query().Get("path")
	s.mu.RLock()
	v := s.v
	s.mu.RUnlock()
	if v == nil {
		http.NotFound(w, r)
		return
	}
	abs, err := v.FilePath(rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeFile(w, r, abs)
}

func (s *Server) handlePickFolder(w http.ResponseWriter, r *http.Request) {
	p, cancelled, err := pickFolder()
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": p, "cancelled": cancelled})
}

func pickFolder() (string, bool, error) {
	switch runtime.GOOS {
	case "darwin":
		out, err := exec.Command("osascript", "-e",
			`POSIX path of (choose folder with prompt "Choose a folder to open as a collector workspace")`).Output()
		if err != nil {
			return "", true, nil // user cancelled
		}
		return strings.TrimRight(strings.TrimSpace(string(out)), "/"), false, nil
	case "linux":
		if _, err := exec.LookPath("zenity"); err == nil {
			out, err := exec.Command("zenity", "--file-selection", "--directory").Output()
			if err != nil {
				return "", true, nil
			}
			return strings.TrimSpace(string(out)), false, nil
		}
	}
	return "", false, fmt.Errorf("no native folder picker on %s; type a path instead", runtime.GOOS)
}

func (s *Server) handleReveal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	s.mu.RLock()
	v := s.v
	s.mu.RUnlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	abs := v.Root()
	if in.Path != "" {
		if p, err := v.FilePath(in.Path); err == nil {
			abs = p
		}
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "-R", abs)
	case "windows":
		cmd = exec.Command("explorer", "/select,", abs)
	default:
		cmd = exec.Command("xdg-open", filepath.Dir(abs))
	}
	if err := cmd.Start(); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleOpenExternal(w http.ResponseWriter, r *http.Request) {
	var in struct {
		URL string `json:"url"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	u := strings.TrimSpace(in.URL)
	ok := strings.HasPrefix(u, "http://") || strings.HasPrefix(u, "https://") ||
		strings.HasPrefix(u, "mailto:") || strings.HasPrefix(u, "x-apple.")
	if !ok {
		writeErr(w, fmt.Errorf("refusing to open %q", u))
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	if err := cmd.Start(); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- small helpers ----

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	code := "error"
	switch {
	case errors.Is(err, vault.ErrNotFound):
		status, code = http.StatusNotFound, "not_found"
	case errors.Is(err, vault.ErrConflict):
		status, code = http.StatusConflict, "conflict"
	case errors.Is(err, vault.ErrInvalid):
		status, code = http.StatusBadRequest, "invalid"
	}
	writeJSON(w, status, map[string]string{"error": err.Error(), "code": code})
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 32<<20))
	if err := dec.Decode(dst); err != nil {
		return fmt.Errorf("bad request body: %w", err)
	}
	return nil
}

// cleanRel normalises a client-supplied vault path.
func cleanRel(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	p = strings.TrimPrefix(path.Clean("/"+p), "/")
	if p == "." {
		return ""
	}
	return p
}
