package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/justinkadima/collector/internal/index"
	"github.com/justinkadima/collector/internal/vault"
)

// testServer is a server with a vault, an index and one subscriber, which is
// everything applyExternalChanges touches.
func testServer(t *testing.T) (*Server, *vault.Vault, chan []byte) {
	t.Helper()
	dir := t.TempDir()
	v, err := vault.New(dir)
	if err != nil {
		t.Fatalf("vault.New: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".collector"), 0o755); err != nil {
		t.Fatal(err)
	}
	ix, err := index.Open(v.IndexPath())
	if err != nil {
		t.Fatalf("index.Open: %v", err)
	}
	t.Cleanup(func() { _ = ix.Close() })
	s := &Server{
		v:       v,
		idx:     ix,
		written: map[string]writtenFile{},
		subs:    map[chan []byte]struct{}{},
	}
	ch := make(chan []byte, 8)
	s.subs[ch] = struct{}{}
	return s, v, ch
}

// next returns the next broadcast, or the empty string if there was none.
func next(t *testing.T, ch chan []byte) (string, string) {
	t.Helper()
	select {
	case raw := <-ch:
		var msg struct {
			Type  string   `json:"type"`
			Paths []string `json:"paths"`
		}
		if err := json.Unmarshal(raw, &msg); err != nil {
			t.Fatalf("broadcast %s: %v", raw, err)
		}
		if len(msg.Paths) != 1 || msg.Paths[0] != "Home.md" {
			t.Fatalf("paths = %v", msg.Paths)
		}
		return msg.Type, string(raw)
	default:
		return "", ""
	}
}

func writeFile(t *testing.T, v *vault.Vault, rel, content string) {
	t.Helper()
	abs, err := v.Abs(rel)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A file rewritten with the bytes it already had — which is what a sync client
// does — is a touch: the stamp moves and the page does not.
func TestSameBytesIsATouch(t *testing.T) {
	s, v, ch := testServer(t)
	p, err := v.Write(vault.WriteInput{Path: "Home.md", Title: "Home", Body: "Hello.\n"})
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := s.idx.Upsert(p); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	abs, _ := v.Abs("Home.md")
	raw, err := os.ReadFile(abs)
	if err != nil {
		t.Fatal(err)
	}
	// Same bytes, new stamp: the sync client's habit.
	st, _ := os.Stat(abs)
	if err := os.WriteFile(abs, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(abs, st.ModTime().Add(1e9), st.ModTime().Add(1e9))

	s.applyExternalChanges(v, []string{"Home.md"})
	if kind, _ := next(t, ch); kind != "touch" {
		t.Fatalf("same bytes: got %q, want a touch", kind)
	}

	// Different bytes are news.
	writeFile(t, v, "Home.md", "# Home\n\nHello again.\n")
	s.applyExternalChanges(v, []string{"Home.md"})
	if kind, raw := next(t, ch); kind != "fs" {
		t.Fatalf("new bytes: got %q (%s), want fs", kind, raw)
	}
}

// Our own write must not come back as somebody else's: no message at all.
func TestOwnWriteIsQuiet(t *testing.T) {
	s, v, ch := testServer(t)
	p, err := v.Write(vault.WriteInput{Path: "Home.md", Title: "Home", Body: "Mine.\n"})
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if err := s.idx.Upsert(p); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	s.markWritten("Home.md")
	s.applyExternalChanges(v, []string{"Home.md"})
	if kind, raw := next(t, ch); kind != "" {
		t.Fatalf("own write: got %q (%s), want silence", kind, raw)
	}

	// Another writer putting *different* bytes back in the same moment is news.
	writeFile(t, v, "Home.md", "# Home\n\nSomeone else.\n")
	s.applyExternalChanges(v, []string{"Home.md"})
	if kind, raw := next(t, ch); kind != "fs" {
		t.Fatalf("someone else: got %q (%s), want fs", kind, raw)
	}
}

// Dotfiles and the temp files a write leaves behind are not pages.
func TestHiddenPathsAreIgnored(t *testing.T) {
	for _, rel := range []string{".DS_Store", "Notes/.hidden.md", ".collector/index.db", "Notes/.collector-123.tmp"} {
		if !hiddenRel(rel) {
			t.Errorf("%q should be ignored", rel)
		}
	}
	for _, rel := range []string{"Home.md", "Notes/Deep.md", "Tasks/Claw Machine.md"} {
		if hiddenRel(rel) {
			t.Errorf("%q should not be ignored", rel)
		}
	}
}
