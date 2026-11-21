package server

import (
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"

	"not1/internal/config"
	"not1/internal/index"
	"not1/internal/vault"
)

func (s *Server) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.bootstrap())
}

func (s *Server) handleOpenWorkspace(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	if strings.TrimSpace(in.Path) == "" {
		writeErr(w, vault.ErrInvalid)
		return
	}
	out, err := s.OpenWorkspace(in.Path)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error(), "code": "open_failed"})
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleTree(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	v, ix := s.v, s.idx
	s.mu.RUnlock()
	if v == nil {
		writeJSON(w, http.StatusOK, map[string]any{"tree": nil})
		return
	}
	tree, err := v.Tree()
	if err != nil {
		writeErr(w, err)
		return
	}
	out := map[string]any{"tree": tree}
	if ix != nil {
		// Icons travel with the tree so a rename or a new page never leaves a
		// stale glyph behind.
		out["icons"] = ix.Icons()
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleGetPage(w http.ResponseWriter, r *http.Request) {
	rel := cleanRel(r.URL.Query().Get("path"))
	s.mu.RLock()
	v, ix := s.v, s.idx
	s.mu.RUnlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	p, err := v.Read(rel)
	if err != nil {
		writeErr(w, err)
		return
	}
	out := map[string]any{"page": p, "backlinks": []index.LinkRef{}}
	if ix != nil {
		if refs, err := ix.Backlinks(p.Path, p.Title); err == nil && refs != nil {
			out["backlinks"] = refs
		}
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleSavePage(w http.ResponseWriter, r *http.Request) {
	var in vault.WriteInput
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	in.Path = cleanRel(in.Path)
	s.mu.Lock()
	v, ix := s.v, s.idx
	s.mu.Unlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	old := in.Path
	p, err := v.Write(in)
	if err != nil {
		writeErr(w, err)
		return
	}
	if ix != nil {
		if old != p.Path {
			_ = ix.Remove(old)
		}
		_ = ix.Upsert(p)
		_ = ix.Reindex()
	}
	if old != p.Path {
		if v.SyncDBSource(old, p.Path) {
			if ix != nil {
				s.reindexAll(v, ix)
			}
		}
	}
	s.markWritten(old, p.Path)
	writeJSON(w, http.StatusOK, map[string]any{
		"page":      p,
		"renamed":   old != p.Path,
		"prevPath":  old,
		"backlinks": s.backlinks(p),
	})
}

func (s *Server) backlinks(p vault.Page) []index.LinkRef {
	s.mu.RLock()
	ix := s.idx
	s.mu.RUnlock()
	if ix == nil {
		return []index.LinkRef{}
	}
	refs, err := ix.Backlinks(p.Path, p.Title)
	if err != nil || refs == nil {
		return []index.LinkRef{}
	}
	return refs
}

func (s *Server) handleCreate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Dir   string `json:"dir"`
		Title string `json:"title"`
		Kind  string `json:"kind"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	s.mu.Lock()
	v, ix := s.v, s.idx
	s.mu.Unlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	p, err := v.Create(cleanRel(in.Dir), in.Title, in.Kind)
	if err != nil {
		writeErr(w, err)
		return
	}
	if in.Kind == "database" {
		// A database page looks at the folder that shares its name, so the
		// page and its rows sit side by side in the tree.
		src := strings.TrimSuffix(path.Base(p.Path), ".md")
		p, err = v.PatchMeta(p.Path, map[string]string{
			"type":           "database",
			"source":         src,
			"fields":         "status:select, due:date",
			"options-status": "todo, doing, done",
			"view":           "table",
			"sort":           "",
			"filter":         "",
		}, nil)
		if err != nil {
			writeErr(w, err)
			return
		}
	}
	if ix != nil && in.Kind != "folder" {
		_ = ix.Upsert(p)
	}
	if in.Kind != "folder" {
		s.markWritten(p.Path)
	}
	writeJSON(w, http.StatusOK, map[string]any{"page": p})
}

func (s *Server) handleRename(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
		Name string `json:"name"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	rel := cleanRel(in.Path)
	s.mu.Lock()
	v, ix := s.v, s.idx
	s.mu.Unlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	isDir := false
	if abs, err := v.Abs(rel); err == nil {
		if st, err := os.Stat(abs); err == nil {
			isDir = st.IsDir()
		}
	}
	p, err := v.Rename(rel, in.Name)
	if err != nil {
		writeErr(w, err)
		return
	}
	s.markWritten(rel, p.Path)
	if ix != nil {
		if isDir {
			s.reindexAll(v, ix)
		} else {
			_ = ix.Remove(rel)
			_ = ix.Upsert(p)
			_ = ix.Reindex()
		}
	}
	if !isDir {
		if v.SyncDBSource(rel, p.Path) && ix != nil {
			s.reindexAll(v, ix)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"page": p, "isDir": isDir, "prevPath": rel})
}

func (s *Server) handleMove(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
		Dir  string `json:"dir"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	rel := cleanRel(in.Path)
	s.mu.Lock()
	v, ix := s.v, s.idx
	s.mu.Unlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	p, err := v.Move(rel, cleanRel(in.Dir))
	if err != nil {
		writeErr(w, err)
		return
	}
	s.markWritten(rel, p.Path)
	if ix != nil {
		_ = ix.Remove(rel)
		_ = ix.Upsert(p)
	}
	writeJSON(w, http.StatusOK, map[string]any{"page": p, "prevPath": rel})
}

func (s *Server) handleDelete(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path string `json:"path"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	rel := cleanRel(in.Path)
	if rel == "" {
		writeErr(w, vault.ErrInvalid)
		return
	}
	s.mu.Lock()
	v, ix := s.v, s.idx
	s.mu.Unlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	isDir := false
	if abs, err := v.Abs(rel); err == nil {
		if st, err := os.Stat(abs); err == nil {
			isDir = st.IsDir()
		}
	}
	if err := v.Delete(rel); err != nil {
		writeErr(w, err)
		return
	}
	s.markWritten(rel)
	if ix != nil {
		if isDir {
			s.reindexAll(v, ix)
		} else {
			_ = ix.Remove(rel)
			_ = ix.Reindex()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "isDir": isDir})
}

func (s *Server) reindexAll(v *vault.Vault, ix *index.Index) {
	pages, err := v.AllPages()
	if err != nil {
		return
	}
	_ = ix.ReplaceAll(pages)
}

// handlePages backs the [[ link picker: a flat, recency-ordered page list.
func (s *Server) handlePages(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	s.mu.RLock()
	ix := s.idx
	s.mu.RUnlock()
	if ix == nil {
		writeJSON(w, http.StatusOK, map[string]any{"pages": []index.PageRef{}})
		return
	}
	pages, err := ix.PageRefs(r.URL.Query().Get("q"), limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	if pages == nil {
		pages = []index.PageRef{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"pages": pages})
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query().Get("q")
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	s.mu.RLock()
	ix := s.idx
	s.mu.RUnlock()
	if ix == nil {
		writeJSON(w, http.StatusOK, map[string]any{"results": []index.Hit{}})
		return
	}
	hits, err := ix.Search(q, limit)
	if err != nil {
		writeErr(w, err)
		return
	}
	if hits == nil {
		hits = []index.Hit{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": hits})
}

func (s *Server) handleRecent(w http.ResponseWriter, r *http.Request) {
	s.mu.RLock()
	ix := s.idx
	s.mu.RUnlock()
	if ix == nil {
		writeJSON(w, http.StatusOK, map[string]any{"results": []index.Hit{}})
		return
	}
	hits, err := ix.Recent(20)
	if err != nil {
		writeErr(w, err)
		return
	}
	if hits == nil {
		hits = []index.Hit{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": hits})
}

func (s *Server) handleBacklinks(w http.ResponseWriter, r *http.Request) {
	rel := cleanRel(r.URL.Query().Get("path"))
	s.mu.RLock()
	v, ix := s.v, s.idx
	s.mu.RUnlock()
	if v == nil || ix == nil {
		writeJSON(w, http.StatusOK, map[string]any{"backlinks": []index.LinkRef{}})
		return
	}
	title := strings.TrimSuffix(path.Base(rel), ".md")
	refs, err := ix.Backlinks(rel, title)
	if err != nil {
		writeErr(w, err)
		return
	}
	if refs == nil {
		refs = []index.LinkRef{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"backlinks": refs})
}

func (s *Server) handleResolve(w http.ResponseWriter, r *http.Request) {
	target := r.URL.Query().Get("target")
	s.mu.RLock()
	ix := s.idx
	s.mu.RUnlock()
	if ix == nil {
		writeJSON(w, http.StatusOK, map[string]any{"found": false})
		return
	}
	if p, ok := ix.Resolve(target); ok {
		writeJSON(w, http.StatusOK, map[string]any{"found": true, "path": p})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"found": false})
}

func (s *Server) handleGetConfig(w http.ResponseWriter, r *http.Request) {
	cfg := s.store.Get()
	writeJSON(w, http.StatusOK, cfg)
}

func (s *Server) handleSetConfig(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Theme        *string `json:"theme"`
		SidebarWidth *int    `json:"sidebarWidth"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	s.store.Set(func(c *config.Config) {
		if in.Theme != nil && (*in.Theme == "light" || *in.Theme == "dark") {
			c.Theme = *in.Theme
		}
		if in.SidebarWidth != nil && *in.SidebarWidth >= 180 && *in.SidebarWidth <= 520 {
			c.SidebarWidth = *in.SidebarWidth
		}
	})
	writeJSON(w, http.StatusOK, s.store.Get())
}

// ------------------------------------------------------------- databases

func (s *Server) handleGetDB(w http.ResponseWriter, r *http.Request) {
	rel := cleanRel(r.URL.Query().Get("path"))
	s.mu.RLock()
	v := s.v
	s.mu.RUnlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	db, err := v.DatabaseOf(rel)
	if err != nil {
		writeErr(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"database": db, "rows": db.Rows})
}

func (s *Server) handleSetView(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path    string            `json:"path"`
		View    *string           `json:"view"`
		GroupBy *string           `json:"groupBy"`
		Sort    *string           `json:"sort"`
		SortDir *string           `json:"sortDir"`
		Filter  *string           `json:"filter"`
		Source  *string           `json:"source"`
		Fields  *string           `json:"fields"`
		Options map[string]string `json:"options"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	rel := cleanRel(in.Path)
	s.mu.Lock()
	v, ix := s.v, s.idx
	s.mu.Unlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	kv := map[string]string{}
	if in.View != nil {
		switch strings.ToLower(*in.View) {
		case "table", "board", "list":
			kv["view"] = strings.ToLower(*in.View)
		}
	}
	if in.GroupBy != nil {
		kv["group-by"] = strings.TrimSpace(*in.GroupBy)
	}
	if in.Sort != nil {
		kv["sort"] = strings.TrimSpace(*in.Sort)
	}
	if in.SortDir != nil {
		if strings.EqualFold(*in.SortDir, "desc") {
			kv["sort-dir"] = "desc"
		} else {
			kv["sort-dir"] = ""
		}
	}
	if in.Filter != nil {
		kv["filter"] = strings.TrimSpace(*in.Filter)
	}
	if in.Source != nil {
		kv["source"] = strings.TrimSpace(*in.Source)
	}
	if in.Fields != nil {
		kv["fields"] = strings.TrimSpace(*in.Fields)
	}
	for k, v := range in.Options {
		if k = strings.TrimSpace(k); k != "" {
			kv["options-"+k] = strings.TrimSpace(v)
		}
	}
	db, err := v.SetView(rel, kv)
	if err != nil {
		writeErr(w, err)
		return
	}
	if ix != nil {
		if p, err := v.Read(rel); err == nil {
			_ = ix.Upsert(p)
		}
	}
	s.markWritten(rel)
	writeJSON(w, http.StatusOK, map[string]any{"database": db})
}

func (s *Server) handleSetProp(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Path  string `json:"path"`
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	rel := cleanRel(in.Path)
	s.mu.Lock()
	v, ix := s.v, s.idx
	s.mu.Unlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	p, err := v.SetProp(rel, in.Key, in.Value)
	if err != nil {
		writeErr(w, err)
		return
	}
	if ix != nil {
		_ = ix.Upsert(p)
	}
	s.markWritten(rel)
	writeJSON(w, http.StatusOK, map[string]any{"page": p})
}

func (s *Server) handleAddRow(w http.ResponseWriter, r *http.Request) {
	var in struct {
		DB    string            `json:"db"`
		Title string            `json:"title"`
		Props map[string]string `json:"props"`
	}
	if err := readJSON(r, &in); err != nil {
		writeErr(w, err)
		return
	}
	dbRel := cleanRel(in.DB)
	s.mu.Lock()
	v, ix := s.v, s.idx
	s.mu.Unlock()
	if v == nil {
		writeErr(w, vault.ErrNotFound)
		return
	}
	p, err := v.AddRow(dbRel, in.Title, in.Props)
	if err != nil {
		writeErr(w, err)
		return
	}
	if ix != nil {
		_ = ix.Upsert(p)
	}
	s.markWritten(p.Path)
	writeJSON(w, http.StatusOK, map[string]any{"page": p})
}
