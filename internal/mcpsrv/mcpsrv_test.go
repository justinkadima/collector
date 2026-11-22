package mcpsrv

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"collector/internal/index"
	"collector/internal/vault"
)

func fixture(t *testing.T) (*vault.Vault, *index.Index) {
	t.Helper()
	dir := t.TempDir()
	write := func(rel, content string) {
		abs := filepath.Join(dir, rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("Projects/Roadmap.md", "---\nicon: 🚀\ntags: [plan]\n---\n# Roadmap\n\nShip the beta on Tuesday.\n")
	write("Scratch.md", "just some words about tuesday\n")
	write("Tasks.md", "---\ntype: database\nsource: Tasks\nfields: status:select\noptions-status: todo, done\n---\nRows live in the folder.\n")
	write("Tasks/Write docs.md", "---\nstatus: todo\n---\n")
	write("Tasks/Ship.md", "---\nstatus: done\n---\n")

	v, err := vault.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	ix, err := index.Open(v.IndexPath())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ix.Close() })
	if err := Sync(v, ix); err != nil {
		t.Fatal(err)
	}
	return v, ix
}

func connect(t *testing.T, v *vault.Vault, ix *index.Index) *mcp.ClientSession {
	t.Helper()
	ctx := context.Background()
	srv := New(v, ix)
	t1, t2 := mcp.NewInMemoryTransports()
	ss, err := srv.Connect(ctx, t1, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ss.Close() })
	c := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0.0.1"}, nil)
	cs, err := c.Connect(ctx, t2, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cs.Close() })
	return cs
}

func call(t *testing.T, cs *mcp.ClientSession, name string, args map[string]any) (*mcp.CallToolResult, string, map[string]any) {
	t.Helper()
	res, err := cs.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: args})
	if err != nil {
		t.Fatalf("%s: transport error: %v", name, err)
	}
	var text strings.Builder
	for _, c := range res.Content {
		if tc, ok := c.(*mcp.TextContent); ok {
			text.WriteString(tc.Text)
		}
	}
	var structured map[string]any
	if res.StructuredContent != nil {
		if b, err := json.Marshal(res.StructuredContent); err == nil {
			_ = json.Unmarshal(b, &structured)
		}
	}
	return res, text.String(), structured
}

func TestToolListIsComplete(t *testing.T) {
	v, ix := fixture(t)
	cs := connect(t, v, ix)
	res, err := cs.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, tool := range res.Tools {
		got[tool.Name] = true
		if tool.Description == "" {
			t.Errorf("%s has no description; models pick tools by description", tool.Name)
		}
	}
	for _, want := range []string{"vault_info", "search_pages", "list_pages", "read_page",
		"create_page", "append_to_page", "update_page", "delete_page", "query_database"} {
		if !got[want] {
			t.Errorf("missing tool %s", want)
		}
	}
}

func TestSearchAndRead(t *testing.T) {
	v, ix := fixture(t)
	cs := connect(t, v, ix)

	_, body, _ := call(t, cs, "search_pages", map[string]any{"query": "tuesday"})
	if !strings.Contains(body, "Projects/Roadmap.md") || !strings.Contains(body, "Scratch.md") {
		t.Errorf("search should hit both pages, got:\n%s", body)
	}
	if !strings.Contains(body, "«") {
		t.Errorf("snippet should mark the match, got:\n%s", body)
	}

	_, _, page := call(t, cs, "read_page", map[string]any{"path": "Projects/Roadmap.md"})
	if page["title"] != "Roadmap" {
		t.Errorf("title = %v", page["title"])
	}
	if body, _ := page["body"].(string); !strings.Contains(body, "Ship the beta") {
		t.Errorf("body = %q", page["body"])
	}
	if page["icon"] != "🚀" {
		t.Errorf("icon = %v", page["icon"])
	}
	if mt, _ := page["modTime"].(float64); mt <= 0 {
		t.Errorf("modTime should be usable as an optimistic lock, got %v", page["modTime"])
	}

	res, out, _ := call(t, cs, "read_page", map[string]any{"path": "Nope/Missing.md"})
	if !res.IsError || !strings.Contains(out, "no page at") {
		t.Errorf("missing page should be a tool error mentioning the path, got %q (isError=%v)", out, res.IsError)
	}
}

func TestAppendKeepsEverything(t *testing.T) {
	v, ix := fixture(t)
	cs := connect(t, v, ix)

	res, out, _ := call(t, cs, "append_to_page", map[string]any{
		"path":     "Projects/Roadmap.md",
		"markdown": "- [ ] Book the venue",
	})
	if res.IsError {
		t.Fatalf("append failed: %s", out)
	}
	raw, err := os.ReadFile(filepath.Join(v.Root(), "Projects/Roadmap.md"))
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	for _, want := range []string{"Ship the beta on Tuesday.", "- [ ] Book the venue", "tags:", "icon: 🚀"} {
		if !strings.Contains(content, want) {
			t.Errorf("after append, file lost %q:\n%s", want, content)
		}
	}
	if strings.Index(content, "Ship the beta") > strings.Index(content, "Book the venue") {
		t.Error("append went to the wrong end of the page")
	}

	// Twice in a row must not double the separator or drop the first append.
	call(t, cs, "append_to_page", map[string]any{"path": "Projects/Roadmap.md", "markdown": "- [ ] Send invites"})
	raw, _ = os.ReadFile(filepath.Join(v.Root(), "Projects/Roadmap.md"))
	if strings.Count(string(raw), "Book the venue") != 1 || !strings.Contains(string(raw), "Send invites") {
		t.Errorf("second append mangled the page:\n%s", raw)
	}
	if strings.Contains(string(raw), "\n\n\n") {
		t.Errorf("append left a double blank line:\n%s", raw)
	}
}

func TestUpdateHonoursModTime(t *testing.T) {
	v, ix := fixture(t)
	cs := connect(t, v, ix)

	_, _, page := call(t, cs, "read_page", map[string]any{"path": "Scratch.md"})
	mod := page["modTime"].(float64)

	// A write that claims to be based on the version we read succeeds.
	res, out, updated := call(t, cs, "update_page", map[string]any{
		"path": "Scratch.md", "body": "# Scratch\n\nrewritten\n", "modTime": mod,
	})
	if res.IsError {
		t.Fatalf("update failed: %s", out)
	}
	if !strings.Contains(updated["body"].(string), "rewritten") {
		t.Errorf("body = %v", updated["body"])
	}

	// The same modTime is now stale, so the next write must refuse.
	res, out, _ = call(t, cs, "update_page", map[string]any{
		"path": "Scratch.md", "body": "clobber", "modTime": mod,
	})
	if !res.IsError {
		t.Fatalf("stale modTime should be rejected, got %q", out)
	}
	raw, _ := os.ReadFile(filepath.Join(v.Root(), "Scratch.md"))
	if strings.Contains(string(raw), "clobber") {
		t.Errorf("conflicting write landed anyway:\n%s", raw)
	}

	// Omit modTime and it is a forced write; a rename follows the title.
	res, out, renamed := call(t, cs, "update_page", map[string]any{
		"path": "Scratch.md", "title": "Scratch pad", "tags": []string{"inbox"},
	})
	if res.IsError {
		t.Fatalf("forced update failed: %s", out)
	}
	if renamed["renamed"] != true || renamed["path"] != "Scratch pad.md" {
		t.Errorf("expected a rename to 'Scratch pad.md', got %v", renamed)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "Scratch pad.md")); err != nil {
		t.Errorf("file was not renamed: %v", err)
	}
}

func TestCreateAndDelete(t *testing.T) {
	v, ix := fixture(t)
	cs := connect(t, v, ix)

	res, out, created := call(t, cs, "create_page", map[string]any{
		"title": "Meeting notes", "dir": "Projects", "body": "## Agenda\n", "icon": "📝",
	})
	if res.IsError {
		t.Fatalf("create failed: %s", out)
	}
	if created["path"] != "Projects/Meeting notes.md" {
		t.Errorf("path = %v", created["path"])
	}
	raw, err := os.ReadFile(filepath.Join(v.Root(), "Projects/Meeting notes.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"icon: 📝", "## Agenda"} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("new page missing %q:\n%s", want, raw)
		}
	}
	// The new page is searchable right away, without the app reindexing.
	_, hits, _ := call(t, cs, "search_pages", map[string]any{"query": "Agenda"})
	if !strings.Contains(hits, "Meeting notes") {
		t.Errorf("created page not searchable: %s", hits)
	}

	res, out, _ = call(t, cs, "delete_page", map[string]any{"path": "Projects/Meeting notes.md"})
	if res.IsError {
		t.Fatalf("delete failed: %s", out)
	}
	if _, err := os.Stat(filepath.Join(v.Root(), "Projects/Meeting notes.md")); !os.IsNotExist(err) {
		t.Error("page still on disk after delete")
	}
	trash := filepath.Join(v.Root(), ".collector", "trash")
	entries, _ := os.ReadDir(trash)
	if len(entries) == 0 {
		t.Error("delete should move the file to .collector/trash, not unlink it")
	}
	_, hits, _ = call(t, cs, "search_pages", map[string]any{"query": "Agenda"})
	if strings.Contains(hits, "Meeting notes") {
		t.Errorf("deleted page still in the index: %s", hits)
	}
}

func TestQueryDatabaseAndListing(t *testing.T) {
	v, ix := fixture(t)
	cs := connect(t, v, ix)

	_, list, _ := call(t, cs, "list_pages", map[string]any{"dir": "Tasks"})
	if !strings.Contains(list, "Tasks/Write docs.md") || strings.Contains(list, "Roadmap") {
		t.Errorf("list_pages(dir) should be confined to the folder, got:\n%s", list)
	}

	res, out, _ := call(t, cs, "query_database", map[string]any{"path": "Tasks.md"})
	if res.IsError {
		t.Fatalf("query_database failed: %s", out)
	}
	for _, want := range []string{"Write docs", "Ship", "status: todo", "status: done", "fields: status"} {
		if !strings.Contains(out, want) {
			t.Errorf("database output missing %q:\n%s", want, out)
		}
	}

	res, out, _ = call(t, cs, "query_database", map[string]any{"path": "Scratch.md"})
	if !res.IsError || !strings.Contains(out, "not a database") {
		t.Errorf("querying a normal page should explain itself, got %q", out)
	}

	_, info, _ := call(t, cs, "vault_info", nil)
	if !strings.Contains(info, "Pages: 5") || !strings.Contains(info, v.Root()) {
		t.Errorf("vault_info = %s", info)
	}
}
