// Package vault reads and writes a folder of markdown files.
//
// Markdown files are the source of truth: there is no proprietary database of
// pages. The folder can be opened in Obsidian, edited in vim, put in git, etc.
package vault

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

var (
	ErrNotFound = errors.New("not found")
	ErrConflict = errors.New("file changed on disk")
	ErrInvalid  = errors.New("invalid path")
)

// Directories never shown in the tree or indexed.
var ignoredDirs = map[string]bool{
	".not1": true, ".git": true, ".obsidian": true, ".trash": true,
	"node_modules": true, ".idea": true, ".vscode": true, "__pycache__": true,
}

type Vault struct {
	root string
	mu   sync.RWMutex
}

type Node struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	Dir      bool    `json:"dir"`
	ModTime  int64   `json:"modTime,omitempty"` // milliseconds
	Children []*Node `json:"children,omitempty"`
}

type Page struct {
	Path    string            `json:"path"`
	Title   string            `json:"title"`
	Icon    string            `json:"icon"`
	Tags    []string          `json:"tags"`
	Pinned  bool              `json:"pinned"`
	Created int64             `json:"created"`
	Updated int64             `json:"updated"`
	ModTime int64             `json:"modTime"`
	Size    int64             `json:"size"`
	Body    string            `json:"body"`
	Type    string            `json:"type,omitempty"`
	Props   map[string]string `json:"props,omitempty"`
}

func New(root string) (*Vault, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	if !st.IsDir() {
		return nil, fmt.Errorf("%s is not a directory", abs)
	}
	return &Vault{root: abs}, nil
}

func (v *Vault) Root() string { return v.root }

// DatabaseIcon marks a database that has no icon of its own. It is a sentinel,
// not a design choice: the frontend swaps it for a stroke database glyph so it
// sits next to the file icons. Nothing writes it into frontmatter.
const DatabaseIcon = "▦"

// MetaDir holds the per-vault cache. Hidden so other tools ignore it.
func (v *Vault) MetaDir() string { return filepath.Join(v.root, ".not1") }

func (v *Vault) IndexPath() string { return filepath.Join(v.MetaDir(), "index.db") }

// resolve turns a vault-relative slash path into an absolute path, refusing
// traversal and anything inside a hidden/ignored directory.
func (v *Vault) resolve(rel string) (string, string, error) {
	rel = strings.ReplaceAll(rel, "\\", "/")
	rel = strings.TrimPrefix(rel, "/")
	rel = path.Clean(rel)
	if rel == "." || rel == "" {
		return v.root, "", nil
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return "", "", ErrInvalid
		}
		if strings.HasPrefix(part, ".") {
			return "", "", ErrInvalid
		}
		if ignoredDirs[part] {
			return "", "", ErrInvalid
		}
	}
	return filepath.Join(v.root, filepath.FromSlash(rel)), rel, nil
}

func (v *Vault) Tree() (*Node, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	root := &Node{Name: filepath.Base(v.root), Path: "", Dir: true}
	if err := v.walk(v.root, "", root, 0); err != nil {
		return nil, err
	}
	return root, nil
}

func (v *Vault) walk(abs, rel string, parent *Node, depth int) error {
	if depth > 24 {
		return nil
	}
	entries, err := os.ReadDir(abs)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		childRel := name
		if rel != "" {
			childRel = rel + "/" + name
		}
		if e.IsDir() {
			if ignoredDirs[name] {
				continue
			}
			n := &Node{Name: name, Path: childRel, Dir: true}
			if err := v.walk(filepath.Join(abs, name), childRel, n, depth+1); err != nil {
				continue
			}
			parent.Children = append(parent.Children, n)
			continue
		}
		if !strings.EqualFold(filepath.Ext(name), ".md") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		parent.Children = append(parent.Children, &Node{
			Name:    strings.TrimSuffix(name, filepath.Ext(name)),
			Path:    childRel,
			ModTime: info.ModTime().UnixMilli(),
		})
	}
	sort.SliceStable(parent.Children, func(i, j int) bool {
		a, b := parent.Children[i], parent.Children[j]
		if a.Dir != b.Dir {
			return a.Dir
		}
		return strings.ToLower(a.Name) < strings.ToLower(b.Name)
	})
	return nil
}

func (v *Vault) Read(rel string) (Page, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()
	return v.readLocked(rel)
}

func (v *Vault) readLocked(rel string) (Page, error) {
	abs, clean, err := v.resolve(rel)
	if err != nil {
		return Page{}, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return Page{}, ErrNotFound
	}
	if st.IsDir() {
		return Page{}, ErrNotFound
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return Page{}, err
	}
	meta, body := splitFrontmatter(string(raw))
	p := Page{
		Path:    clean,
		Title:   titleOf(clean),
		Icon:    meta.Icon,
		Tags:    meta.Tags,
		Pinned:  meta.Pinned,
		Created: meta.Created,
		Updated: meta.Updated,
		ModTime: st.ModTime().UnixMilli(),
		Size:    st.Size(),
		Body:    body,
		Type:    strings.ToLower(meta.Props["type"]),
		Props:   meta.Props,
	}
	// Created/Updated travel as nanoseconds (they come from frontmatter), while
	// ModTime is milliseconds so that the browser can compare it exactly.
	if p.Created == 0 {
		p.Created = st.ModTime().UnixNano()
	}
	if p.Updated == 0 {
		p.Updated = st.ModTime().UnixNano()
	}
	return p, nil
}

type WriteInput struct {
	Path     string   `json:"path"`
	Title    string   `json:"title"`
	Icon     string   `json:"icon"`
	Tags     []string `json:"tags"`
	Body     string   `json:"body"`
	Expect   int64    `json:"expectMod"` // 0 = force
	NoRename bool     `json:"noRename"`
}

// Write saves a page, renaming its file if the title changed (the filename is
// the canonical title, like Obsidian). It returns the page as stored, whose
// Path may differ from the requested one after a rename.
func (v *Vault) Write(in WriteInput) (Page, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	abs, rel, err := v.resolve(in.Path)
	if err != nil {
		return Page{}, err
	}
	exists := false
	if s, err := os.Stat(abs); err == nil {
		exists = true
		if s.IsDir() {
			return Page{}, ErrInvalid
		}
		if in.Expect > 0 && s.ModTime().UnixMilli() != in.Expect {
			return Page{}, ErrConflict
		}
	}
	if !strings.EqualFold(filepath.Ext(rel), ".md") {
		return Page{}, ErrInvalid
	}

	var prev Meta
	var prevBody string
	if exists {
		if raw, err := os.ReadFile(abs); err == nil {
			prev, prevBody = splitFrontmatter(string(raw))
		}
	}

	// Rename to match the title.
	if in.Title != "" && !in.NoRename {
		want := sanitizeName(in.Title)
		cur := titleOf(rel)
		if want != "" && want != cur {
			dir := path.Dir(rel)
			target := want + ".md"
			if dir != "." && dir != "" {
				target = dir + "/" + target
			}
			if target != rel {
				target = v.uniqueRel(dir, want, ".md", rel)
				if exists {
					if err := os.Rename(abs, v.abs(target)); err != nil {
						return Page{}, err
					}
				}
				rel = target
				abs = v.abs(target)
			}
		}
	}

	meta := prev
	meta.Icon = in.Icon
	meta.Tags = in.Tags
	if meta.Created == 0 {
		meta.Created = time.Now().UnixNano()
	}
	meta.Updated = time.Now().UnixNano()
	// Drop frontmatter keys that were edited externally into body duplicates?
	// Not needed: we rewrite the whole document.
	_ = prevBody

	body := strings.TrimRight(in.Body, "\n")
	if body != "" {
		body += "\n"
	}
	content := meta.render() + "\n" + body

	if err := v.writeAtomic(abs, content); err != nil {
		return Page{}, err
	}
	return v.readLocked(rel)
}

// writeAtomic replaces a file's contents via a temp file in the same
// directory, so an interrupted write never truncates the original.
func (v *Vault) writeAtomic(abs, content string) error {
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(abs), ".not1-*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	if _, err := tmp.WriteString(content); err != nil {
		tmp.Close()
		os.Remove(tmpName)
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName)
		return err
	}
	if err := os.Rename(tmpName, abs); err != nil {
		os.Remove(tmpName)
		return err
	}
	return nil
}

func (v *Vault) Create(dir, title, kind string) (Page, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	dirRel, err := v.cleanDir(dir)
	if err != nil {
		return Page{}, err
	}
	if kind == "folder" {
		name := sanitizeName(title)
		if name == "" {
			name = "New folder"
		}
		rel := name
		if dirRel != "" {
			rel = dirRel + "/" + name
		}
		rel = v.uniqueRel(dirRel, name, "", "")
		if err := os.MkdirAll(v.abs(rel), 0o755); err != nil {
			return Page{}, err
		}
		return Page{Path: rel, Title: name}, nil
	}

	name := sanitizeName(title)
	if name == "" {
		name = "Untitled"
	}
	rel := v.uniqueRel(dirRel, name, ".md", "")
	abs := v.abs(rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return Page{}, err
	}
	now := time.Now().UnixNano()
	meta := Meta{Created: now, Updated: now}
	if err := os.WriteFile(abs, []byte(meta.render()+"\n"), 0o644); err != nil {
		return Page{}, err
	}
	return v.readLocked(rel)
}

func (v *Vault) Rename(rel, newName string) (Page, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	abs, clean, err := v.resolve(rel)
	if err != nil {
		return Page{}, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return Page{}, ErrNotFound
	}
	isDir := st.IsDir()
	name := sanitizeName(newName)
	if name == "" {
		return Page{}, ErrInvalid
	}
	dir := path.Dir(clean)
	if dir == "." {
		dir = ""
	}
	ext := ""
	if !isDir {
		ext = ".md"
	}
	if isDir && dir == "" && ignoredDirs[name] {
		return Page{}, ErrInvalid
	}
	target := v.uniqueRel(dir, name, ext, clean)
	if target == clean {
		return v.readPageOrDir(clean, isDir)
	}
	if err := os.Rename(abs, v.abs(target)); err != nil {
		return Page{}, err
	}
	return v.readPageOrDir(target, isDir)
}

func (v *Vault) Move(rel, newDir string) (Page, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	abs, clean, err := v.resolve(rel)
	if err != nil {
		return Page{}, err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return Page{}, ErrNotFound
	}
	if st.IsDir() {
		return Page{}, ErrInvalid
	}
	dirRel, err := v.cleanDir(newDir)
	if err != nil {
		return Page{}, err
	}
	if dirRel == path.Dir(clean) || (dirRel == "" && path.Dir(clean) == ".") {
		return v.readLocked(clean)
	}
	base := titleOf(clean)
	target := v.uniqueRel(dirRel, base, ".md", clean)
	if err := os.MkdirAll(v.abs(dirRel), 0o755); err != nil {
		return Page{}, err
	}
	if err := os.Rename(abs, v.abs(target)); err != nil {
		return Page{}, err
	}
	return v.readLocked(target)
}

func (v *Vault) Delete(rel string) error {
	v.mu.Lock()
	defer v.mu.Unlock()

	abs, clean, err := v.resolve(rel)
	if err != nil {
		return err
	}
	if clean == "" {
		return ErrInvalid
	}
	if _, err := os.Stat(abs); err != nil {
		return ErrNotFound
	}
	trash := filepath.Join(v.MetaDir(), "trash", time.Now().UTC().Format("20060102-150405"))
	dst := filepath.Join(trash, filepath.FromSlash(clean))
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if err := os.Rename(abs, dst); err != nil {
		return err
	}
	// Remove now-empty parent directories, up to the vault root.
	for d := filepath.Dir(abs); d != v.root && strings.HasPrefix(d, v.root); d = filepath.Dir(d) {
		if err := os.Remove(d); err != nil {
			break
		}
	}
	return nil
}

// AllPages walks the vault and parses every markdown file. Used to build the
// search index (and at startup to pick up external edits).
func (v *Vault) AllPages() ([]Page, error) {
	tree, err := v.Tree()
	if err != nil {
		return nil, err
	}
	var out []Page
	var walk func(n *Node)
	walk = func(n *Node) {
		for _, c := range n.Children {
			if c.Dir {
				walk(c)
				continue
			}
			if p, err := v.Read(c.Path); err == nil {
				out = append(out, p)
			}
		}
	}
	walk(tree)
	return out, nil
}

// Files walks the vault and returns relative paths of non-markdown assets
// (images, pdfs, ...) so they can be listed/attached later.
func (v *Vault) Assets() []string {
	var out []string
	_ = filepath.WalkDir(v.root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		name := d.Name()
		if d.IsDir() {
			if p != v.root && (ignoredDirs[name] || strings.HasPrefix(name, ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasPrefix(name, ".") || strings.EqualFold(filepath.Ext(name), ".md") {
			return nil
		}
		if rel, err := filepath.Rel(v.root, p); err == nil {
			out = append(out, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func (v *Vault) readPageOrDir(rel string, isDir bool) (Page, error) {
	if isDir {
		return Page{Path: rel, Title: path.Base(rel)}, nil
	}
	return v.readLocked(rel)
}

func (v *Vault) cleanDir(rel string) (string, error) {
	_, clean, err := v.resolve(rel)
	if err != nil {
		return "", err
	}
	clean = strings.TrimSuffix(strings.ReplaceAll(clean, "\\", "/"), "/")
	if clean == "." {
		clean = ""
	}
	if clean != "" {
		if st, err := os.Stat(v.abs(clean)); err != nil || !st.IsDir() {
			return "", ErrNotFound
		}
	}
	return clean, nil
}

func (v *Vault) abs(rel string) string {
	if rel == "" || rel == "." {
		return v.root
	}
	return filepath.Join(v.root, filepath.FromSlash(rel))
}

// uniqueRel returns a vault-relative path in dir that does not exist yet.
// exclude is ignored when checking (so renaming a file to its own name works).
func (v *Vault) uniqueRel(dir, name, ext, exclude string) string {
	build := func(n string) string {
		f := n + ext
		if dir == "" || dir == "." {
			return f
		}
		return dir + "/" + f
	}
	candidate := build(name)
	for i := 2; i < 1000; i++ {
		// A case-only rename ("Notes" -> "notes") stats as the same file on
		// macOS, so compare case-insensitively as well.
		if candidate == exclude || strings.EqualFold(candidate, exclude) {
			return candidate
		}
		if _, err := os.Stat(v.abs(candidate)); err != nil {
			return candidate
		}
		candidate = build(fmt.Sprintf("%s %d", name, i))
	}
	return candidate
}

func titleOf(rel string) string {
	base := path.Base(strings.ReplaceAll(rel, "\\", "/"))
	return strings.TrimSuffix(base, path.Ext(base))
}

func sanitizeName(s string) string {
	s = strings.TrimSpace(s)
	s = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\n', '\r', '\t', 0:
			return ' '
		}
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
	s = strings.Join(strings.Fields(s), " ")
	s = strings.Trim(s, ". ")
	if len([]rune(s)) > 120 {
		s = string([]rune(s)[:120])
	}
	return s
}

// Abs validates a vault-relative path and returns the absolute path.
func (v *Vault) Abs(rel string) (string, error) {
	abs, _, err := v.resolve(rel)
	return abs, err
}

// FilePath validates a vault-relative path and returns the absolute path of an
// existing file (used to serve images and attachments).
func (v *Vault) FilePath(rel string) (string, error) {
	abs, err := v.Abs(rel)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		return "", ErrNotFound
	}
	return abs, nil
}

// RelOf converts an absolute path inside the vault to a vault-relative path.
func (v *Vault) RelOf(abs string) (string, bool) {
	rel, err := filepath.Rel(v.root, abs)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", false
	}
	return filepath.ToSlash(rel), true
}
