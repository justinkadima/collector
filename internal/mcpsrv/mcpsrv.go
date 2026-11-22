// Package mcpsrv exposes a vault over the Model Context Protocol, so an agent
// (Claude Desktop, an editor, a script) can search, read and write the same
// markdown files the app edits.
//
// It is a *server*: the vault is the data, MCP is the door. Nothing here is
// stored outside the vault — an MCP write is a normal page write, so the running
// app picks it up through its file watcher within a second.
package mcpsrv

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"not1/internal/index"
	"not1/internal/vault"
)

// Version is the version reported to MCP clients.
var Version = "0.6"

type server struct {
	v  *vault.Vault
	ix *index.Index
}

// Sync rebuilds the index from the vault. It runs once at startup because the
// index is a cache: the vault may have been edited by an editor or synced from
// another machine while not1 was closed, and search must not lie about it.
func Sync(v *vault.Vault, ix *index.Index) error {
	pages, err := v.AllPages()
	if err != nil {
		return err
	}
	return ix.ReplaceAll(pages)
}

// New builds the MCP server around an open vault and its index.
func New(v *vault.Vault, ix *index.Index) *mcp.Server {
	s := &server{v: v, ix: ix}
	srv := mcp.NewServer(&mcp.Implementation{
		Name:    "not1",
		Version: Version,
	}, &mcp.ServerOptions{
		Instructions: "This server is a markdown notes vault. One page is one .md file; " +
			"the filename is the title and metadata lives in YAML frontmatter. " +
			"Start with search_pages or list_pages, read a page before editing it, " +
			"and prefer append_to_page over update_page so you cannot lose text. " +
			"Paths are vault-relative, e.g. 'Projects/Roadmap.md'.",
	})

	mcp.AddTool(srv, &mcp.Tool{
		Name: "vault_info",
		Description: "Describe the open vault: its absolute path, how many pages it holds, " +
			"and the most recently edited pages. Use this once at the start to orient yourself.",
	}, s.vaultInfo)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "search_pages",
		Description: "Full-text search across page bodies and titles. Returns each hit's path, " +
			"title and a highlighted snippet. This is the fastest way to find something.",
	}, s.searchPages)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "list_pages",
		Description: "List pages, optionally limited to one folder. Cheaper than search when you " +
			"want an overview of what exists.",
	}, s.listPages)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "read_page",
		Description: "Read one page: its frontmatter fields (icon, tags, type, ...), its markdown " +
			"body, its backlinks, and modTime. Pass modTime back to update_page to prove you " +
			"edited the version you read.",
	}, s.readPage)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "create_page",
		Description: "Create a new page. The title becomes the filename, so it must be a valid " +
			"file name; the optional body is markdown. Returns the page with its final path.",
	}, s.createPage)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "append_to_page",
		Description: "Append markdown to the end of an existing page, separated by a blank line. " +
			"This is the safe way to add notes: it cannot overwrite what is already there.",
	}, s.appendToPage)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "update_page",
		Description: "Rewrite a page's body and/or metadata (title, icon, tags). Omit a field to " +
			"leave it alone. Pass the modTime from read_page to fail instead of clobbering a " +
			"concurrent edit; omit it to force.",
	}, s.updatePage)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "delete_page",
		Description: "Move a page to the vault's trash folder (<vault>/.not1/trash/). Nothing is " +
			"ever unlinked, so this is recoverable.",
	}, s.deletePage)

	mcp.AddTool(srv, &mcp.Tool{
		Name: "query_database",
		Description: "Read a database page (one with type: database) as rows and typed fields, " +
			"respecting its stored filter and sort. Rows are ordinary pages; each row's " +
			"frontmatter keys are its cells.",
	}, s.queryDatabase)

	return srv
}

/* ------------------------------------------------------------------- inputs */

type emptyIn struct{}

type searchIn struct {
	Query string `json:"query" jsonschema:"words to look for; FTS syntax is accepted"`
	Limit int    `json:"limit,omitempty" jsonschema:"maximum hits, default 20, max 100"`
}

type listIn struct {
	Dir   string `json:"dir,omitempty" jsonschema:"only pages under this folder, e.g. 'Projects'"`
	Limit int    `json:"limit,omitempty" jsonschema:"maximum pages, default 200"`
}

type readIn struct {
	Path string `json:"path" jsonschema:"vault-relative page path, e.g. 'Projects/Roadmap.md'"`
}

type createIn struct {
	Title string `json:"title" jsonschema:"page title; becomes the filename"`
	Dir   string `json:"dir,omitempty" jsonschema:"folder to create it in, e.g. 'Projects'"`
	Body  string `json:"body,omitempty" jsonschema:"initial markdown body"`
	Icon  string `json:"icon,omitempty" jsonschema:"optional emoji shown next to the title"`
}

type appendIn struct {
	Path     string `json:"path" jsonschema:"vault-relative page path"`
	Markdown string `json:"markdown" jsonschema:"markdown to append"`
}

type updateIn struct {
	Path    string   `json:"path" jsonschema:"vault-relative page path"`
	Body    *string  `json:"body,omitempty" jsonschema:"replacement markdown body; omit to keep"`
	Title   *string  `json:"title,omitempty" jsonschema:"new title; renames the file"`
	Icon    *string  `json:"icon,omitempty" jsonschema:"new emoji"`
	Tags    []string `json:"tags,omitempty" jsonschema:"replacement tag list"`
	ModTime int64    `json:"modTime,omitempty" jsonschema:"modTime from read_page; 0 forces the write"`
}

type deleteIn struct {
	Path string `json:"path" jsonschema:"vault-relative page path"`
}

type dbIn struct {
	Path string `json:"path" jsonschema:"vault-relative path of the database page"`
}

/* ------------------------------------------------------------------ outputs */

type pageOut struct {
	Path      string   `json:"path"`
	Title     string   `json:"title"`
	Icon      string   `json:"icon,omitempty"`
	Tags      []string `json:"tags,omitempty"`
	Type      string   `json:"type,omitempty"`
	Props     any      `json:"props,omitempty"`
	Body      string   `json:"body"`
	ModTime   int64    `json:"modTime"`
	Updated   string   `json:"updated,omitempty"`
	Backlinks []string `json:"backlinks,omitempty"`
	Renamed   bool     `json:"renamed,omitempty"`
}

/* -------------------------------------------------------------------- tools */

func text(s string) *mcp.CallToolResult {
	return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: s}}}
}

func (s *server) vaultInfo(ctx context.Context, _ *mcp.CallToolRequest, _ emptyIn) (*mcp.CallToolResult, any, error) {
	count, err := s.ix.Count()
	if err != nil {
		return nil, nil, err
	}
	recent, err := s.ix.Recent(8)
	if err != nil {
		return nil, nil, err
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Vault: %s\nPages: %d\n\nRecently edited:\n", s.v.Root(), count)
	for _, h := range recent {
		fmt.Fprintf(&b, "  %s — %s\n", h.Path, h.Title)
	}
	if len(recent) == 0 {
		b.WriteString("  (none yet)\n")
	}
	return text(b.String()), nil, nil
}

func (s *server) searchPages(ctx context.Context, _ *mcp.CallToolRequest, in searchIn) (*mcp.CallToolResult, any, error) {
	q := strings.TrimSpace(in.Query)
	if q == "" {
		return nil, nil, fmt.Errorf("query is required")
	}
	limit := in.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	hits, err := s.ix.Search(q, limit)
	if err != nil {
		return nil, nil, err
	}
	if len(hits) == 0 {
		return text(fmt.Sprintf("No page matches %q.", q)), nil, nil
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%d match(es) for %q:\n", len(hits), q)
	for _, h := range hits {
		fmt.Fprintf(&b, "\n%s\n  %s\n", h.Path, strings.TrimSpace(tidy(h.Snippet)))
	}
	return text(b.String()), nil, nil
}

func (s *server) listPages(ctx context.Context, _ *mcp.CallToolRequest, in listIn) (*mcp.CallToolResult, any, error) {
	pages, err := s.v.AllPages()
	if err != nil {
		return nil, nil, err
	}
	dir := strings.Trim(strings.TrimSpace(in.Dir), "/")
	limit := in.Limit
	if limit <= 0 {
		limit = 200
	}
	sort.Slice(pages, func(i, j int) bool { return pages[i].Path < pages[j].Path })
	var b strings.Builder
	n := 0
	for _, p := range pages {
		if dir != "" && !strings.HasPrefix(p.Path, dir+"/") && p.Path != dir {
			continue
		}
		if n == limit {
			b.WriteString("\n… list truncated; raise limit or narrow dir\n")
			break
		}
		n++
		kind := ""
		if strings.EqualFold(p.Props["type"], "database") {
			kind = "  [database]"
		}
		fmt.Fprintf(&b, "%s%s\n", p.Path, kind)
	}
	if n == 0 {
		return text("No pages" + map[bool]string{true: " under " + dir, false: ""}[dir != ""] + "."), nil, nil
	}
	return text(b.String()), nil, nil
}

func (s *server) readPage(ctx context.Context, _ *mcp.CallToolRequest, in readIn) (*mcp.CallToolResult, any, error) {
	p, err := s.v.Read(in.Path)
	if err != nil {
		return nil, nil, notFound(in.Path, err)
	}
	out := pageOut{
		Path:    p.Path,
		Title:   p.Title,
		Icon:    p.Icon,
		Tags:    p.Tags,
		Type:    p.Type,
		Body:    p.Body,
		ModTime: p.ModTime,
		Updated: stamp(p.Updated),
	}
	if len(p.Props) > 0 {
		out.Props = p.Props
	}
	if refs, err := s.ix.Backlinks(p.Path, p.Title); err == nil {
		for _, r := range refs {
			out.Backlinks = append(out.Backlinks, r.Path)
		}
	}
	return nil, out, nil
}

func (s *server) createPage(ctx context.Context, _ *mcp.CallToolRequest, in createIn) (*mcp.CallToolResult, any, error) {
	title := strings.TrimSpace(in.Title)
	if title == "" {
		return nil, nil, fmt.Errorf("title is required")
	}
	p, err := s.v.Create(strings.Trim(strings.TrimSpace(in.Dir), "/"), title, "page")
	if err != nil {
		return nil, nil, err
	}
	if body := strings.TrimSpace(in.Body); body != "" || in.Icon != "" {
		next, err := s.v.Write(vault.WriteInput{
			Path:   p.Path,
			Title:  p.Title,
			Icon:   in.Icon,
			Tags:   p.Tags,
			Body:   in.Body,
			Expect: p.ModTime,
		})
		if err != nil {
			return nil, nil, err
		}
		p = next
	}
	s.reindex(p.Path)
	return nil, pageOut{Path: p.Path, Title: p.Title, Icon: p.Icon, Body: p.Body, ModTime: p.ModTime}, nil
}

func (s *server) appendToPage(ctx context.Context, _ *mcp.CallToolRequest, in appendIn) (*mcp.CallToolResult, any, error) {
	chunk := strings.TrimRight(in.Markdown, "\n")
	if strings.TrimSpace(chunk) == "" {
		return nil, nil, fmt.Errorf("markdown is required")
	}
	// Two attempts: if someone edited the file between read and write, re-read
	// and append to the newer body instead of failing the agent.
	for attempt := 0; ; attempt++ {
		p, err := s.v.Read(in.Path)
		if err != nil {
			return nil, nil, notFound(in.Path, err)
		}
		body := p.Body
		if strings.TrimSpace(body) != "" {
			body = strings.TrimRight(body, "\n") + "\n\n"
		}
		body += chunk + "\n"
		next, err := s.v.Write(vault.WriteInput{
			Path:     p.Path,
			Title:    p.Title,
			Icon:     p.Icon,
			Tags:     p.Tags,
			Body:     body,
			Expect:   p.ModTime,
			NoRename: true,
		})
		if errors.Is(err, vault.ErrConflict) && attempt < 2 {
			continue
		}
		if err != nil {
			return nil, nil, err
		}
		s.reindex(next.Path)
		return text(fmt.Sprintf("Appended to %s (%d bytes now).", next.Path, next.Size)), nil, nil
	}
}

func (s *server) updatePage(ctx context.Context, _ *mcp.CallToolRequest, in updateIn) (*mcp.CallToolResult, any, error) {
	cur, err := s.v.Read(in.Path)
	if err != nil {
		return nil, nil, notFound(in.Path, err)
	}
	input := vault.WriteInput{
		Path:   cur.Path,
		Title:  cur.Title,
		Icon:   cur.Icon,
		Tags:   cur.Tags,
		Body:   cur.Body,
		Expect: in.ModTime,
	}
	if in.Body != nil {
		input.Body = *in.Body
	}
	if in.Title != nil {
		if t := strings.TrimSpace(*in.Title); t != "" {
			input.Title = t
		}
	}
	if in.Icon != nil {
		input.Icon = *in.Icon
	}
	if in.Tags != nil {
		input.Tags = in.Tags
	}
	prev := cur.Path
	next, err := s.v.Write(input)
	if err != nil {
		return nil, nil, err
	}
	s.reindex(prev)
	if next.Path != prev {
		s.reindex(next.Path)
	}
	return nil, pageOut{
		Path:    next.Path,
		Title:   next.Title,
		Icon:    next.Icon,
		Tags:    next.Tags,
		Type:    next.Type,
		Body:    next.Body,
		ModTime: next.ModTime,
		Renamed: next.Path != prev,
	}, nil
}

func (s *server) deletePage(ctx context.Context, _ *mcp.CallToolRequest, in deleteIn) (*mcp.CallToolResult, any, error) {
	if err := s.v.Delete(in.Path); err != nil {
		return nil, nil, notFound(in.Path, err)
	}
	if err := s.ix.Remove(in.Path); err != nil {
		log.Printf("mcp: index remove %s: %v", in.Path, err)
	}
	return text(fmt.Sprintf("Moved %s to the trash.", in.Path)), nil, nil
}

func (s *server) queryDatabase(ctx context.Context, _ *mcp.CallToolRequest, in dbIn) (*mcp.CallToolResult, any, error) {
	db, err := s.v.DatabaseOf(in.Path)
	if err != nil {
		if errors.Is(err, vault.ErrInvalid) {
			return nil, nil, fmt.Errorf("%s is not a database (its frontmatter needs type: database)", in.Path)
		}
		return nil, nil, notFound(in.Path, err)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "%s — %d row(s)\n", db.Title, len(db.Rows))
	if db.Filter != "" {
		fmt.Fprintf(&b, "filter: %s\n", db.Filter)
	}
	if db.Sort != "" {
		fmt.Fprintf(&b, "sort: %s %s\n", db.Sort, db.SortDir)
	}
	keys := make([]string, 0, len(db.Fields))
	for _, f := range db.Fields {
		keys = append(keys, f.Key)
	}
	if len(keys) > 0 {
		fmt.Fprintf(&b, "fields: %s\n", strings.Join(keys, ", "))
	}
	for _, r := range db.Rows {
		fmt.Fprintf(&b, "\n%s", r.Title)
		if r.Path != "" {
			fmt.Fprintf(&b, "  (%s)", r.Path)
		}
		// Stable column order so two runs are comparable.
		ks := make([]string, 0, len(r.Props))
		for k := range r.Props {
			ks = append(ks, k)
		}
		sort.Strings(ks)
		for _, k := range ks {
			if v := strings.TrimSpace(r.Props[k]); v != "" {
				fmt.Fprintf(&b, "\n  %s: %s", k, v)
			}
		}
		b.WriteString("\n")
	}
	if len(db.Rows) == 0 {
		b.WriteString("\n(no rows yet)\n")
	}
	return text(b.String()), nil, nil
}

/* ------------------------------------------------------------------ helpers */

// reindex keeps the search index honest after a write, since the MCP process
// is not the one the app's watcher belongs to.
func (s *server) reindex(rel string) {
	if s.ix == nil || rel == "" {
		return
	}
	p, err := s.v.Read(rel)
	if err != nil {
		return
	}
	if err := s.ix.Upsert(p); err != nil {
		log.Printf("mcp: index upsert %s: %v", rel, err)
	}
}

func notFound(rel string, err error) error {
	if errors.Is(err, vault.ErrNotFound) {
		return fmt.Errorf("no page at %q", rel)
	}
	return err
}

func stamp(ns int64) string {
	if ns <= 0 {
		return ""
	}
	return time.Unix(0, ns).Format("2006-01-02 15:04")
}

// tidy collapses the \x01\x02 highlight markers the index uses into 「...」.
func tidy(s string) string {
	s = strings.ReplaceAll(s, "\x01", "«")
	s = strings.ReplaceAll(s, "\x02", "»")
	return strings.Join(strings.Fields(s), " ")
}
