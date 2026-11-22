// Package index is a disposable SQLite cache over the vault: full-text search,
// backlinks and title resolution. Deleting it loses nothing.
package index

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"github.com/justinkadima/collector/internal/vault"

	_ "modernc.org/sqlite"
)

// Markers used to delimit snippet highlights without injecting HTML from file
// contents. The frontend escapes first, then converts these.
const (
	MarkStart = "\x01"
	MarkEnd   = "\x02"
)

type Index struct {
	db *sql.DB
}

type Hit struct {
	Path    string `json:"path"`
	Title   string `json:"title"`
	Dir     string `json:"dir"`
	Icon    string `json:"icon"`
	Updated int64  `json:"updated"`
	Snippet string `json:"snippet"`
}

type LinkRef struct {
	Path  string `json:"path"`
	Title string `json:"title"`
	Icon  string `json:"icon"`
}

func Open(dbPath string) (*Index, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	dsn := "file:" + dbPath + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	ix := &Index{db: db}
	if err := ix.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return ix, nil
}

func (ix *Index) migrate() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS pages(
			path TEXT PRIMARY KEY,
			title TEXT NOT NULL,
			icon TEXT NOT NULL DEFAULT '',
			type TEXT NOT NULL DEFAULT '',
			dir TEXT NOT NULL DEFAULT '',
			created INTEGER NOT NULL DEFAULT 0,
			updated INTEGER NOT NULL DEFAULT 0,
			modtime INTEGER NOT NULL DEFAULT 0,
			size INTEGER NOT NULL DEFAULT 0,
			body TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE INDEX IF NOT EXISTS pages_updated ON pages(updated DESC)`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
			path UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2'
		)`,
		`CREATE TABLE IF NOT EXISTS links(
			src TEXT NOT NULL,
			dst TEXT NOT NULL,
			dst_path TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE IF NOT EXISTS events(
			path TEXT NOT NULL,
			line INTEGER NOT NULL,
			date TEXT NOT NULL,
			start TEXT NOT NULL DEFAULT '',
			end TEXT NOT NULL DEFAULT '',
			title TEXT NOT NULL
		)`,
		`CREATE INDEX IF NOT EXISTS events_date ON events(date)`,
		`CREATE INDEX IF NOT EXISTS events_path ON events(path)`,
		`CREATE INDEX IF NOT EXISTS links_src ON links(src)`,
		`CREATE INDEX IF NOT EXISTS links_dst ON links(dst)`,
	}
	for _, s := range stmts {
		if _, err := ix.db.Exec(s); err != nil {
			return err
		}
	}
	// Indexes written before the type column existed: adding it twice fails,
	// which is exactly the "already there" case.
	_, _ = ix.db.Exec(`ALTER TABLE pages ADD COLUMN type TEXT NOT NULL DEFAULT ''`)
	return nil
}

func (ix *Index) Close() error { return ix.db.Close() }

func (ix *Index) ReplaceAll(pages []vault.Page) error {
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, q := range []string{`DELETE FROM pages`, `DELETE FROM pages_fts`, `DELETE FROM links`, `DELETE FROM events`} {
		if _, err := tx.Exec(q); err != nil {
			return err
		}
	}
	for _, p := range pages {
		if err := upsertTx(tx, p); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (ix *Index) Upsert(p vault.Page) error {
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := upsertTx(tx, p); err != nil {
		return err
	}
	return tx.Commit()
}

func upsertTx(tx *sql.Tx, p vault.Page) error {
	dir := ""
	if i := strings.LastIndex(p.Path, "/"); i >= 0 {
		dir = p.Path[:i]
	}
	if _, err := tx.Exec(`INSERT INTO pages(path,title,icon,type,dir,created,updated,modtime,size,body)
		VALUES(?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(path) DO UPDATE SET title=excluded.title, icon=excluded.icon, type=excluded.type,
			dir=excluded.dir, created=excluded.created, updated=excluded.updated,
			modtime=excluded.modtime, size=excluded.size, body=excluded.body`,
		p.Path, p.Title, p.Icon, p.Type, dir, p.Created, p.Updated, p.ModTime, p.Size, p.Body); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM pages_fts WHERE path=?`, p.Path); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO pages_fts(path,title,body) VALUES(?,?,?)`, p.Path, p.Title, p.Body); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM events WHERE path=?`, p.Path); err != nil {
		return err
	}
	// Events are derived from the page body, like links: the fence is the only
	// copy, and this table is rebuilt from it whenever the file changes.
	for _, ev := range vault.ParseEvents(p.Body) {
		if _, err := tx.Exec(`INSERT INTO events(path,line,date,start,end,title) VALUES(?,?,?,?,?,?)`,
			p.Path, ev.Line, ev.Date, ev.Start, ev.End, ev.Title); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`DELETE FROM links WHERE src=?`, p.Path); err != nil {
		return err
	}
	for _, dst := range vault.ExtractLinks(p.Body, p.Path) {
		var dstPath string
		base := dst
		if i := strings.LastIndex(base, "/"); i >= 0 {
			base = base[i+1:]
		}
		_ = tx.QueryRow(`SELECT path FROM pages
			WHERE lower(title)=lower(?) OR path=? OR path=? OR lower(title)=lower(?)
			ORDER BY (path=?) DESC, (lower(title)=lower(?)) DESC LIMIT 1`,
			dst, dst, dst+".md", base, dst, base).Scan(&dstPath)
		if _, err := tx.Exec(`INSERT INTO links(src,dst,dst_path) VALUES(?,?,?)`, p.Path, dst, dstPath); err != nil {
			return err
		}
	}
	return nil
}

func (ix *Index) Remove(rel string) error {
	tx, err := ix.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM pages WHERE path=?`, rel); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM pages_fts WHERE path=?`, rel); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM links WHERE src=?`, rel); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM events WHERE path=?`, rel); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE links SET dst_path='' WHERE dst_path=?`, rel); err != nil {
		return err
	}
	return tx.Commit()
}

// Reindex recomputes dst_path for every link, e.g. after a rename.
func (ix *Index) Reindex() error {
	_, err := ix.db.Exec(`UPDATE links SET dst_path=COALESCE(
		(SELECT p.path FROM pages p WHERE lower(p.title)=lower(links.dst) LIMIT 1), '')`)
	return err
}

func ftsQuery(q string) string {
	var toks []string
	var cur strings.Builder
	flush := func() {
		if cur.Len() > 0 {
			toks = append(toks, `"`+cur.String()+`"*`)
			cur.Reset()
		}
	}
	for _, r := range q {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' {
			cur.WriteRune(r)
		} else {
			flush()
		}
	}
	flush()
	return strings.Join(toks, " AND ")
}

func (ix *Index) Search(q string, limit int) ([]Hit, error) {
	q = strings.TrimSpace(q)
	if q == "" {
		return nil, nil
	}
	if limit <= 0 || limit > 100 {
		limit = 40
	}
	if match := ftsQuery(q); match != "" {
		hits, err := ix.searchFTS(match, limit)
		if err == nil && len(hits) > 0 {
			return hits, nil
		}
	}
	return ix.searchLike(q, limit)
}

func (ix *Index) searchFTS(match string, limit int) ([]Hit, error) {
	rows, err := ix.db.Query(`
		SELECT p.path, p.title, p.icon, p.dir, p.updated, p.type,
		       snippet(pages_fts, 2, char(1), char(2), '…', 14)
		FROM pages_fts f
		JOIN pages p ON p.path = f.path
		WHERE pages_fts MATCH ?
		ORDER BY rank
		LIMIT ?`, match, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Hit
	for rows.Next() {
		var h Hit
		var snip sql.NullString
		var typ string
		if err := rows.Scan(&h.Path, &h.Title, &h.Icon, &h.Dir, &h.Updated, &typ, &snip); err != nil {
			return nil, err
		}
		h.Snippet = strings.TrimSpace(snip.String)
		h.Icon = iconOr(h.Icon, typ)
		out = append(out, h)
	}
	return out, rows.Err()
}

func (ix *Index) searchLike(q string, limit int) ([]Hit, error) {
	like := "%" + strings.ReplaceAll(strings.ReplaceAll(q, "%", `\%`), "_", `\_`) + "%"
	rows, err := ix.db.Query(`
		SELECT path, title, icon, dir, updated, type, substr(body, 1, 160)
		FROM pages
		WHERE title LIKE ? ESCAPE '\' OR body LIKE ? ESCAPE '\'
		ORDER BY updated DESC LIMIT ?`, like, like, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Hit
	for rows.Next() {
		var h Hit
		var body sql.NullString
		var typ string
		if err := rows.Scan(&h.Path, &h.Title, &h.Icon, &h.Dir, &h.Updated, &typ, &body); err != nil {
			return nil, err
		}
		h.Snippet = strings.TrimSpace(body.String)
		h.Icon = iconOr(h.Icon, typ)
		out = append(out, h)
	}
	return out, rows.Err()
}

func (ix *Index) Recent(limit int) ([]Hit, error) {
	if limit <= 0 {
		limit = 12
	}
	rows, err := ix.db.Query(`SELECT path,title,icon,dir,updated FROM pages ORDER BY updated DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Hit
	for rows.Next() {
		var h Hit
		if err := rows.Scan(&h.Path, &h.Title, &h.Icon, &h.Dir, &h.Updated); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// Backlinks returns pages linking to rel (by path or by wiki title).
func (ix *Index) Backlinks(rel, title string) ([]LinkRef, error) {
	rows, err := ix.db.Query(`
		SELECT DISTINCT p.path, p.title, p.icon
		FROM links l JOIN pages p ON p.path = l.src
		WHERE l.src <> ? AND (l.dst_path = ? OR (l.dst_path = '' AND lower(l.dst) = lower(?)))
		ORDER BY p.title COLLATE NOCASE`, rel, rel, title)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LinkRef
	for rows.Next() {
		var r LinkRef
		if err := rows.Scan(&r.Path, &r.Title, &r.Icon); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Resolve maps a wiki-link target or path to a page path.
func (ix *Index) Resolve(target string) (string, bool) {
	target = strings.TrimSpace(strings.TrimSuffix(target, ".md"))
	if target == "" {
		return "", false
	}
	var p string
	if err := ix.db.QueryRow(`SELECT path FROM pages WHERE path=? OR path=? LIMIT 1`,
		target, target+".md").Scan(&p); err == nil {
		return p, true
	}
	if err := ix.db.QueryRow(`SELECT path FROM pages WHERE lower(title)=lower(?) ORDER BY updated DESC LIMIT 1`,
		target).Scan(&p); err == nil {
		return p, true
	}
	// Fall back to the file name portion of a path-style link.
	if i := strings.LastIndex(target, "/"); i >= 0 {
		if err := ix.db.QueryRow(`SELECT path FROM pages WHERE lower(title)=lower(?) ORDER BY updated DESC LIMIT 1`,
			target[i+1:]+".md").Scan(&p); err == nil {
			return p, true
		}
	}
	return "", false
}

// Icons returns page path -> emoji for pages that have one.
// Icons maps page path to the emoji shown in the sidebar. A database without
// an icon of its own still gets the database glyph, so a hand-written one reads
// the same as one made in the app.
// iconOr fills in the database sentinel so every caller agrees on what a
// database without an icon looks like.
func iconOr(ic, typ string) string {
	if ic == "" && typ == "database" {
		return vault.DatabaseIcon
	}
	return ic
}

func (ix *Index) Icons() map[string]string {
	out := map[string]string{}
	rows, err := ix.db.Query(`SELECT path, icon, type FROM pages WHERE icon <> '' OR type = 'database'`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var p, ic, typ string
		if err := rows.Scan(&p, &ic, &typ); err != nil {
			continue
		}
		out[p] = iconOr(ic, typ)
	}
	return out
}

// PageRef is one row of the link picker: enough to render "icon + title" and
// nothing else.
type PageRef struct {
	Path  string `json:"path"`
	Title string `json:"title"`
	Icon  string `json:"icon"`
	Dir   string `json:"dir"`
}

// PageRefs lists pages for the link picker, most recently edited first, with an
// optional case-insensitive substring filter on the title.
func (ix *Index) PageRefs(q string, limit int) ([]PageRef, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	q = strings.TrimSpace(strings.ToLower(q))
	args := []any{limit}
	query := `SELECT path, title, icon, dir, type FROM pages`
	if q != "" {
		query += ` WHERE instr(lower(title), ?) > 0`
		args = []any{q, limit}
	}
	query += ` ORDER BY updated DESC, title LIMIT ?`
	rows, err := ix.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PageRef
	for rows.Next() {
		var r PageRef
		var typ string
		if err := rows.Scan(&r.Path, &r.Title, &r.Icon, &r.Dir, &typ); err != nil {
			return nil, err
		}
		r.Icon = iconOr(r.Icon, typ)
		out = append(out, r)
	}
	return out, rows.Err()
}

func (ix *Index) Count() (int, error) {
	var n int
	err := ix.db.QueryRow(`SELECT count(*) FROM pages`).Scan(&n)
	return n, err
}

func (ix *Index) Stats() map[string]any {
	var pages, links int
	_ = ix.db.QueryRow(`SELECT count(*) FROM pages`).Scan(&pages)
	_ = ix.db.QueryRow(`SELECT count(*) FROM links`).Scan(&links)
	return map[string]any{"pages": pages, "links": links, "indexedAt": time.Now().Unix()}
}
