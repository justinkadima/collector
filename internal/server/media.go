package server

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"collector/internal/vault"
)

// Attachments live in one folder at the vault root, so a page can link to them
// with a relative path and the vault stays portable. Nothing is stored twice:
// the file is the attachment, the markdown line is the reference.
const attachDir = "attachments"

// mediaKind classifies by extension; the renderer and the picker filters agree
// with this list.
func mediaKind(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg", ".avif", ".heic", ".tiff":
		return "image"
	case ".mp4", ".webm", ".mov", ".m4v", ".mkv", ".ogv":
		return "video"
	case ".mp3", ".wav", ".m4a", ".ogg", ".oga", ".flac", ".aac", ".opus":
		return "audio"
	}
	return "file"
}

var nonSlug = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)

// attachName turns "Screenshot 2026-11-21 at 19.53.56.png" into something that
// survives a URL and a shell.
func attachName(original string) string {
	base := filepath.Base(original)
	ext := filepath.Ext(base)
	stem := strings.TrimSuffix(base, ext)
	stem = strings.Trim(nonSlug.ReplaceAllString(stem, "-"), "-.")
	if stem == "" {
		stem = "file"
	}
	if len(stem) > 60 {
		stem = stem[:60]
	}
	return stem + strings.ToLower(ext)
}

// copyAttachment copies src into <vault>/attachments and returns the vault
// relative path. Names are de-duplicated rather than overwritten, because the
// same screenshot often gets attached twice.
func copyAttachment(v *vault.Vault, src string) (string, error) {
	st, err := os.Stat(src)
	if err != nil || st.IsDir() {
		return "", vault.ErrNotFound
	}
	dir := filepath.Join(v.Root(), attachDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	name := attachName(src)
	ext := filepath.Ext(name)
	stem := strings.TrimSuffix(name, ext)
	dest := filepath.Join(dir, name)
	for i := 2; ; i++ {
		if _, err := os.Stat(dest); errors.Is(err, os.ErrNotExist) {
			break
		}
		dest = filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, i, ext))
	}
	in, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.CreateTemp(dir, ".incoming-*")
	if err != nil {
		return "", err
	}
	tmp := out.Name()
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return "", err
	}
	if err := out.Close(); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		return "", err
	}
	rel, ok := v.RelOf(dest)
	if !ok {
		return "", vault.ErrInvalid
	}
	return rel, nil
}

// relFromPage rewrites a vault-relative path as a path relative to the page, so
// the markdown line survives a vault move and still resolves in other editors.
func relFromPage(pageRel, vaultRel string) string {
	dir := path.Dir(pageRel)
	if dir == "." || dir == "/" {
		return vaultRel
	}
	if pageRel == "" {
		return vaultRel
	}
	up := strings.Count(dir, "/") + 1
	return strings.Repeat("../", up) + vaultRel
}

type attachResp struct {
	Path string `json:"path"` // vault relative
	Href string `json:"href"` // relative to the page's folder
	Name string `json:"name"`
	Kind string `json:"kind"`
	Size int64  `json:"size"`
}

func (s *Server) attachResponse(page, vaultRel string) attachResp {
	name := path.Base(vaultRel)
	out := attachResp{
		Path: vaultRel,
		Href: relFromPage(page, vaultRel),
		Name: name,
		Kind: mediaKind(name),
	}
	if s.v != nil {
		if abs, err := s.v.FilePath(vaultRel); err == nil {
			if st, err := os.Stat(abs); err == nil {
				out.Size = st.Size()
			}
		}
	}
	return out
}

// handleAttach opens the OS file chooser for a kind, copies the pick into the
// vault and hands back the path to write into the page.
func (s *Server) handleAttach(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Page string `json:"page"`
		Kind string `json:"kind"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	page := cleanRel(in.Page)
	s.mu.RLock()
	v := s.v
	s.mu.RUnlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	src, cancelled, err := pickFile(in.Kind)
	if err != nil {
		writeErr(w, err)
		return
	}
	if cancelled || src == "" {
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
		return
	}
	rel, err := copyAttachment(v, src)
	if err != nil {
		writeErr(w, err)
		return
	}
	s.markWritten(rel)
	writeJSON(w, http.StatusOK, map[string]any{"attachment": s.attachResponse(page, rel)})
}

// handleUpload takes bytes directly (drag and drop) and stores them the same way
// as the picker does.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	page := cleanRel(r.URL.Query().Get("page"))
	name := r.URL.Query().Get("name")
	if name == "" {
		name = "dropped-file"
	}
	s.mu.RLock()
	v := s.v
	s.mu.RUnlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	dir := filepath.Join(v.Root(), attachDir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeErr(w, err)
		return
	}
	final := attachName(name)
	ext := filepath.Ext(final)
	stem := strings.TrimSuffix(final, ext)
	dest := filepath.Join(dir, final)
	for i := 2; ; i++ {
		if _, err := os.Stat(dest); errors.Is(err, os.ErrNotExist) {
			break
		}
		dest = filepath.Join(dir, fmt.Sprintf("%s-%d%s", stem, i, ext))
	}
	out, err := os.Create(dest)
	if err != nil {
		writeErr(w, err)
		return
	}
	if _, err := io.Copy(out, http.MaxBytesReader(w, r.Body, 1<<30)); err != nil {
		out.Close()
		os.Remove(dest)
		writeErr(w, vault.ErrInvalid)
		return
	}
	if err := out.Close(); err != nil {
		os.Remove(dest)
		writeErr(w, err)
		return
	}
	rel, ok := v.RelOf(dest)
	if !ok {
		writeErr(w, vault.ErrInvalid)
		return
	}
	s.markWritten(rel)
	writeJSON(w, http.StatusOK, map[string]any{"attachment": s.attachResponse(page, rel)})
}

// handleBookmark reads a page's <title> and description so a pasted URL can be
// stored as text rather than a card that only exists in the app. Best effort:
// offline, it just returns the URL's host as the title.
func (s *Server) handleBookmark(w http.ResponseWriter, r *http.Request) {
	var in struct {
		URL string `json:"url"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	raw := strings.TrimSpace(in.URL)
	if raw != "" && !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		writeErr(w, vault.ErrInvalid)
		return
	}
	out := map[string]any{"url": u.String(), "site": strings.TrimPrefix(u.Host, "www."), "title": "", "description": ""}
	if title, desc, err := fetchTitle(u.String()); err == nil {
		out["title"], out["description"] = title, desc
	}
	if out["title"] == "" {
		out["title"] = out["site"]
	}
	writeJSON(w, http.StatusOK, out)
}

var (
	titleRe = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	descRe  = regexp.MustCompile(`(?is)<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']`)
	spaceRe = regexp.MustCompile(`\s+`)
)

func fetchTitle(rawURL string) (string, string, error) {
	req, err := http.NewRequest("GET", rawURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("User-Agent", "Mozilla/5.0 (compatible; collector/1.0)")
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	client := &http.Client{Timeout: 6 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return "", "", errors.New(resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 256<<10))
	if err != nil {
		return "", "", err
	}
	html := string(body)
	title := ""
	if m := titleRe.FindStringSubmatch(html); m != nil {
		title = cleanText(m[1])
	}
	desc := ""
	if m := descRe.FindStringSubmatch(html); m != nil {
		desc = cleanText(m[1])
	}
	if len(desc) > 200 {
		desc = desc[:200]
	}
	if len(title) > 160 {
		title = title[:160]
	}
	return title, desc, nil
}

// cleanText unescapes the entities that actually show up in <title> and folds
// whitespace, without pulling in an HTML parser.
func cleanText(s string) string {
	s = strings.NewReplacer("&amp;", "&", "&lt;", "<", "&gt;", ">", "&quot;", `"`, "&#39;", "'", "&#x27;", "'", "&nbsp;", " ").Replace(s)
	s = spaceRe.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}

// handleOpenFile opens an attachment in the OS default app, the way a
// double-click in Finder would. Only paths inside the vault are accepted.
func (s *Server) handleOpenFile(w http.ResponseWriter, r *http.Request) {
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
	abs, err := v.FilePath(cleanRel(in.Path))
	if err != nil {
		writeErr(w, err)
		return
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", abs)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", abs)
	default:
		cmd = exec.Command("xdg-open", abs)
	}
	if err := cmd.Start(); err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// pickFile asks the OS for a file. Cancelling is not an error.
func pickFile(kind string) (string, bool, error) {
	switch runtime.GOOS {
	case "darwin":
		script := `POSIX path of (choose file with prompt "Choose a file to add to this page"`
		switch kind {
		case "image":
			script += ` of type {"public.image"}`
		case "video":
			script += ` of type {"public.movie"}`
		case "audio":
			script += ` of type {"public.audio"}`
		}
		script += ")"
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			return "", true, nil
		}
		return strings.TrimSpace(string(out)), false, nil
	case "linux":
		args := []string{"--file-selection", "--title=Choose a file to add to this page"}
		switch kind {
		case "image":
			args = append(args, "--file-filter=Images | *.png *.jpg *.jpeg *.gif *.webp *.svg *.avif")
		case "video":
			args = append(args, "--file-filter=Video | *.mp4 *.webm *.mov *.mkv")
		case "audio":
			args = append(args, "--file-filter=Audio | *.mp3 *.wav *.m4a *.ogg *.flac")
		}
		if _, err := exec.LookPath("zenity"); err != nil {
			return "", false, fmt.Errorf("no file picker available (install zenity)")
		}
		out, err := exec.Command("zenity", args...).Output()
		if err != nil {
			return "", true, nil
		}
		return strings.TrimSpace(string(out)), false, nil
	}
	return "", false, fmt.Errorf("file picker is not supported on %s", runtime.GOOS)
}
