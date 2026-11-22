package vault

// Databases: a page whose frontmatter says `type: database` is a saved view
// over the markdown files in a folder. Nothing is stored twice — each row is
// its own page, and its frontmatter keys are the cell values.
//
//	---
//	type: database
//	source: Tasks
//	fields: status:select, due:date, owner:text
//	options-status: todo, doing, done
//	view: board
//	group-by: status
//	sort: due
//	filter: status != done
//	---
//
// A row (`Tasks/Fix the login form.md`) carries its own cells:
//
//	---
//	status: doing
//	due: 2026-03-01
//	owner: Justin
//	---
//
// This keeps the promise of the app: delete .collector/ and every database is still
// a folder plus a text file that says how to look at it.

import (
	"os"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Field struct {
	Key     string   `json:"key"`
	Type    string   `json:"type"`
	Options []string `json:"options,omitempty"`
}

type Row struct {
	Path    string            `json:"path"`
	Title   string            `json:"title"`
	Icon    string            `json:"icon"`
	Updated int64             `json:"updated"`
	ModTime int64             `json:"modTime"`
	Props   map[string]string `json:"props"`
}

type Database struct {
	Path    string  `json:"path"`
	Title   string  `json:"title"`
	Icon    string  `json:"icon"`
	Source  string  `json:"source"`
	View    string  `json:"view"`
	GroupBy string  `json:"groupBy"`
	Sort    string  `json:"sort"`
	SortDir string  `json:"sortDir"`
	Filter  string  `json:"filter"`
	Fields  []Field `json:"fields"`
	Rows    []Row   `json:"rows"`
	Total   int     `json:"total"`
}

// Reserved frontmatter keys: page metadata, never a database cell.
var metaKeys = map[string]bool{
	"icon": true, "emoji": true, "tags": true, "tag": true, "pinned": true,
	"created": true, "updated": true, "modified": true, "title": true,
	"date": true, "type": true, "source": true, "view": true, "group-by": true,
	"sort": true, "sort-dir": true, "filter": true, "fields": true,
}

func isMetaKey(k string) bool {
	k = strings.ToLower(strings.TrimSpace(k))
	return metaKeys[k] || strings.HasPrefix(k, "options-")
}

// isDatabase reports whether a page's frontmatter marks it as one.
func isDatabase(p Page) bool {
	return strings.EqualFold(strings.TrimSpace(p.Props["type"]), "database")
}

// DatabaseOf loads the database described by a page, plus its rows.
func (v *Vault) DatabaseOf(rel string) (Database, error) {
	v.mu.RLock()
	defer v.mu.RUnlock()

	p, err := v.readLocked(rel)
	if err != nil {
		return Database{}, err
	}
	if !isDatabase(p) {
		return Database{}, ErrInvalid
	}

	db := Database{
		Path:    p.Path,
		Title:   p.Title,
		Icon:    p.Icon,
		View:    strings.ToLower(strings.TrimSpace(p.Props["view"])),
		GroupBy: strings.TrimSpace(p.Props["group-by"]),
		Sort:    strings.TrimSpace(p.Props["sort"]),
		SortDir: strings.ToLower(strings.TrimSpace(p.Props["sort-dir"])),
		Filter:  strings.TrimSpace(p.Props["filter"]),
	}
	if db.View != "board" && db.View != "list" {
		db.View = "table"
	}
	if db.SortDir != "desc" {
		db.SortDir = "asc"
	}

	// Where do rows live? `source:` is relative to the database file, so a
	// database and its folder can sit next to each other.
	dir := path.Dir(p.Path)
	if dir == "." {
		dir = ""
	}
	src := strings.TrimSpace(p.Props["source"])
	src = strings.TrimSuffix(strings.ReplaceAll(src, "\\", "/"), "/")
	switch {
	case src == "":
		db.Source = dir
	case src == "." || src == "./":
		db.Source = dir
	case strings.HasPrefix(src, "/"):
		db.Source = strings.TrimPrefix(src, "/")
	case dir == "":
		db.Source = src
	default:
		db.Source = path.Join(dir, src)
	}

	rows, err := v.readRows(db.Source, p.Path)
	if err != nil {
		return Database{}, err
	}
	db.Total = len(rows)
	db.Fields = buildFields(p, rows, db.GroupBy)
	db.Rows = sortRows(filterRows(rows, db.Filter), db.Sort, db.SortDir)
	if db.Rows == nil {
		db.Rows = []Row{}
	}
	if db.Total > 0 && db.Fields == nil {
		db.Fields = []Field{}
	}
	return db, nil
}

func (v *Vault) readRows(dir, self string) ([]Row, error) {
	abs := v.abs(dir)
	entries, err := os.ReadDir(abs)
	if err != nil {
		if os.IsNotExist(err) {
			return []Row{}, nil
		}
		return nil, err
	}
	rows := make([]Row, 0, len(entries))
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") || !strings.EqualFold(path.Ext(name), ".md") {
			continue
		}
		rel := name
		if dir != "" {
			rel = dir + "/" + name
		}
		if rel == self {
			continue
		}
		row, err := v.readLocked(rel)
		if err != nil {
			continue
		}
		props := map[string]string{}
		for k, val := range row.Props {
			if isMetaKey(k) {
				continue
			}
			props[k] = val
		}
		rows = append(rows, Row{
			Path:    row.Path,
			Title:   row.Title,
			Icon:    row.Icon,
			Updated: row.Updated,
			ModTime: row.ModTime,
			Props:   props,
		})
	}
	return rows, nil
}

// buildFields merges the declared schema with the keys actually present, so a
// hand-added property shows up instead of being silently dropped.
func buildFields(db Page, rows []Row, groupBy string) []Field {
	declared := map[string]string{}
	var order []string
	fields := strings.TrimSpace(db.Props["fields"])
	if fields != "" {
		for _, part := range strings.Split(fields, ",") {
			k, t, ok := strings.Cut(strings.TrimSpace(part), ":")
			k = strings.TrimSpace(k)
			if k == "" || isMetaKey(k) {
				continue
			}
			if !ok {
				t = ""
			}
			declared[strings.ToLower(k)] = strings.TrimSpace(t)
			order = append(order, k)
		}
	}

	// Observed keys, in the order rows are read.
	seen := map[string]bool{}
	for _, r := range rows {
		for _, k := range sortedPropKeys(r.Props) {
			lk := strings.ToLower(k)
			if isMetaKey(k) || seen[lk] {
				continue
			}
			seen[lk] = true
			if _, ok := declared[lk]; !ok {
				order = append(order, k)
			}
		}
	}

	out := make([]Field, 0, len(order))
	for _, k := range order {
		lk := strings.ToLower(k)
		f := Field{Key: k, Type: inferType(rows, k, groupBy)}
		if t := declared[lk]; t != "" {
			f.Type = normalType(t)
		}
		if f.Type == "select" {
			f.Options = mergeOptions(parseList(db.Props["options-"+k]), rows, k)
		}
		out = append(out, f)
	}
	return out
}

func normalType(t string) string {
	switch strings.ToLower(strings.TrimSpace(t)) {
	case "select", "tags", "multi":
		return "select"
	case "date":
		return "date"
	case "number", "num":
		return "number"
	case "checkbox", "bool", "boolean", "done":
		return "checkbox"
	case "text", "string":
		return "text"
	}
	return "text"
}

func inferType(rows []Row, key, groupBy string) string {
	if strings.EqualFold(key, groupBy) {
		return "select"
	}
	values := make([]string, 0, len(rows))
	for _, r := range rows {
		if v, ok := r.Props[key]; ok && strings.TrimSpace(v) != "" {
			values = append(values, strings.TrimSpace(v))
		}
	}
	if len(values) == 0 {
		return "text"
	}
	allBool, allNum, allDate, distinct := true, true, true, map[string]bool{}
	for _, v := range values {
		distinct[strings.ToLower(v)] = true
		if !isBool(v) {
			allBool = false
		}
		if !isNumber(v) {
			allNum = false
		}
		if !isDate(v) {
			allDate = false
		}
	}
	switch {
	case allBool:
		return "checkbox"
	case allDate:
		return "date"
	case allNum:
		return "number"
	case len(distinct) <= 12:
		return "select"
	}
	return "text"
}

func isBool(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "true", "false", "yes", "no", "on", "off":
		return true
	}
	return false
}

func isNumber(v string) bool {
	_, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	return err == nil
}

var dateLayouts = []string{"2006-01-02T15:04:05Z07:00", "2006-01-02T15:04:05", "2006-01-02", "2006-01"}

func isDate(v string) bool {
	v = strings.TrimSpace(v)
	for _, l := range dateLayouts {
		if _, err := time.Parse(l, v); err == nil {
			return true
		}
	}
	return false
}

func mergeOptions(declared []string, rows []Row, key string) []string {
	out := append([]string(nil), declared...)
	seen := map[string]bool{}
	for _, o := range out {
		seen[strings.ToLower(o)] = true
	}
	var extra []string
	for _, r := range rows {
		v := strings.TrimSpace(r.Props[key])
		if v == "" || seen[strings.ToLower(v)] {
			continue
		}
		seen[strings.ToLower(v)] = true
		extra = append(extra, v)
	}
	sort.SliceStable(extra, func(i, j int) bool { return strings.ToLower(extra[i]) < strings.ToLower(extra[j]) })
	return append(out, extra...)
}

func sortedPropKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// ---------------------------------------------------------------- editing

// PatchMeta sets and deletes frontmatter keys without touching the body or any
// other key. An empty value in set deletes the key.
func (v *Vault) PatchMeta(rel string, set map[string]string, del []string) (Page, error) {
	v.mu.Lock()
	defer v.mu.Unlock()

	abs, clean, err := v.resolve(rel)
	if err != nil {
		return Page{}, err
	}
	raw, err := os.ReadFile(abs)
	if err != nil {
		return Page{}, ErrNotFound
	}
	src := string(raw)

	head, body := splitFenceText(src)
	lines := strings.Split(head, "\n")
	if head == "" {
		lines = nil
	}

	existing := map[string]int{}
	for i, ln := range lines {
		if k, _, ok := strings.Cut(ln, ":"); ok {
			existing[strings.ToLower(strings.TrimSpace(k))] = i
		}
	}

	drop := map[string]bool{}
	for _, d := range del {
		drop[strings.ToLower(strings.TrimSpace(d))] = true
	}

	// Order matters for readability: replace in place, append the rest.
	var appendLater []string
	for _, k := range sortedKeys(set) {
		val := set[k]
		lk := strings.ToLower(strings.TrimSpace(k))
		if val == "" {
			drop[lk] = true
			continue
		}
		if i, ok := existing[lk]; ok {
			lines[i] = k + ": " + yamlScalar(val)
			continue
		}
		appendLater = append(appendLater, k+": "+yamlScalar(val))
	}

	if len(drop) > 0 {
		kept := lines[:0]
		for _, ln := range lines {
			k, _, ok := strings.Cut(ln, ":")
			if ok && drop[strings.ToLower(strings.TrimSpace(k))] {
				continue
			}
			kept = append(kept, ln)
		}
		lines = kept
	}
	lines = append(lines, appendLater...)

	// Touch `updated:` unless the caller is explicitly writing it.
	if _, ok := set["updated"]; !ok {
		stamp := "updated: " + time.Now().UTC().Format(time.RFC3339)
		replaced := false
		for i, ln := range lines {
			if k, _, ok := strings.Cut(ln, ":"); ok && strings.EqualFold(strings.TrimSpace(k), "updated") {
				lines[i] = stamp
				replaced = true
				break
			}
		}
		if !replaced {
			lines = append(lines, stamp)
		}
	}

	var b strings.Builder
	b.WriteString("---\n")
	for _, ln := range lines {
		if strings.TrimSpace(ln) == "" {
			continue
		}
		b.WriteString(ln + "\n")
	}
	b.WriteString("---\n")
	b.WriteString(body)

	if err := v.writeAtomic(abs, b.String()); err != nil {
		return Page{}, err
	}
	return v.readLocked(clean)
}

func sortedKeys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// splitFenceText returns the frontmatter block (without fences) and the rest
// of the document, body included verbatim.
func splitFenceText(src string) (string, string) {
	if !strings.HasPrefix(src, "---") {
		return "", src
	}
	nl := strings.IndexByte(src, '\n')
	if nl < 0 || strings.TrimSpace(src[:nl]) != "---" {
		return "", src
	}
	rest := src[nl+1:]
	lines := strings.Split(rest, "\n")
	for i, ln := range lines {
		t := strings.TrimSpace(ln)
		if t == "---" || t == "..." {
			return strings.Join(lines[:i], "\n"), strings.Join(lines[i+1:], "\n")
		}
	}
	return "", src
}

// SetProp writes one cell value; an empty value removes the key.
func (v *Vault) SetProp(rel, key, value string) (Page, error) {
	key = strings.TrimSpace(key)
	if key == "" || isMetaKey(key) {
		return Page{}, ErrInvalid
	}
	return v.PatchMeta(rel, map[string]string{key: strings.TrimSpace(value)}, nil)
}

// SetView saves the database's view configuration (also frontmatter).
func (v *Vault) SetView(rel string, kv map[string]string) (Database, error) {
	clean := map[string]string{}
	for k, val := range kv {
		lk := strings.ToLower(strings.TrimSpace(k))
		switch lk {
		case "view", "group-by", "sort", "sort-dir", "filter", "source", "fields":
			clean[lk] = strings.TrimSpace(val)
		default:
			if strings.HasPrefix(lk, "options-") {
				clean[lk] = strings.TrimSpace(val)
			}
		}
	}
	if _, err := v.PatchMeta(rel, clean, nil); err != nil {
		return Database{}, err
	}
	return v.DatabaseOf(rel)
}

// AddRow creates a new page inside the database's folder and fills its cells.
func (v *Vault) AddRow(dbRel, title string, props map[string]string) (Page, error) {
	db, err := v.DatabaseOf(dbRel)
	if err != nil {
		return Page{}, err
	}
	if strings.TrimSpace(title) == "" {
		title = "Untitled"
	}
	// The folder may not exist yet: a database is usable before its first row.
	if db.Source != "" {
		if err := os.MkdirAll(v.abs(db.Source), 0o755); err != nil {
			return Page{}, err
		}
	}
	p, err := v.Create(db.Source, title, "")
	if err != nil {
		return Page{}, err
	}
	if len(props) > 0 {
		set := map[string]string{}
		for k, val := range props {
			if !isMetaKey(k) {
				set[k] = strings.TrimSpace(val)
			}
		}
		if len(set) > 0 {
			p, err = v.PatchMeta(p.Path, set, nil)
			if err != nil {
				return Page{}, err
			}
		}
	}
	return p, nil
}

// ---------------------------------------------------------- filter / sort

// Filter is deliberately tiny: one clause, `key op value`, with ops
// = != ~ > < >= <=. Anything unparseable is ignored rather than erroring, so a
// hand-typed filter never leaves the page blank.
func parseFilter(f string) (key, op, val string, ok bool) {
	f = strings.TrimSpace(f)
	if f == "" {
		return "", "", "", false
	}
	for _, o := range []string{"!=", ">=", "<=", "~", "=", ">", "<"} {
		if i := strings.Index(f, o); i > 0 {
			key = strings.TrimSpace(f[:i])
			op = o
			val = strings.TrimSpace(f[i+len(o):])
			break
		}
	}
	if key == "" {
		return "", "", "", false
	}
	val = strings.Trim(unquote(strings.TrimSpace(val)), `"'`)
	if key == "" {
		return "", "", "", false
	}
	return key, op, val, true
}

func filterRows(rows []Row, filter string) []Row {
	key, op, want, ok := parseFilter(filter)
	if !ok {
		return rows
	}
	out := make([]Row, 0, len(rows))
	for _, r := range rows {
		got := strings.TrimSpace(r.Props[key])
		if matchValue(got, op, want) {
			out = append(out, r)
		}
	}
	return out
}

func matchValue(got, op, want string) bool {
	if op == "~" {
		return strings.Contains(strings.ToLower(got), strings.ToLower(want))
	}
	if op == "=" || op == "!=" {
		eq := strings.EqualFold(got, want)
		if !eq && got != "" && want != "" {
			if a, err1 := strconv.ParseFloat(got, 64); err1 == nil {
				if b, err2 := strconv.ParseFloat(want, 64); err2 == nil {
					eq = a == b
				}
			}
		}
		if op == "=" {
			return eq
		}
		return !eq
	}
	// Ordering comparisons: numbers, then dates, then strings.
	if a, err1 := strconv.ParseFloat(got, 64); err1 == nil {
		if b, err2 := strconv.ParseFloat(want, 64); err2 == nil {
			return cmpOrder(a, b, op)
		}
	}
	if a, ok1 := parseDateValue(got); ok1 {
		if b, ok2 := parseDateValue(want); ok2 {
			return cmpOrder(float64(a.Unix()), float64(b.Unix()), op)
		}
	}
	return cmpOrderStrings(got, want, op)
}

func cmpOrder(a, b float64, op string) bool {
	switch op {
	case ">":
		return a > b
	case "<":
		return a < b
	case ">=":
		return a >= b
	case "<=":
		return a <= b
	}
	return false
}

func cmpOrderStrings(a, b, op string) bool {
	a, b = strings.ToLower(a), strings.ToLower(b)
	switch op {
	case ">":
		return a > b
	case "<":
		return a < b
	case ">=":
		return a >= b
	case "<=":
		return a <= b
	}
	return false
}

func parseDateValue(s string) (time.Time, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return time.Time{}, false
	}
	for _, l := range dateLayouts {
		if t, err := time.Parse(l, s); err == nil {
			return t, true
		}
	}
	return time.Time{}, false
}

// sortRows orders by a property when one is set; empty values always sort
// last, which is what a task list wants.
func sortRows(rows []Row, key, dir string) []Row {
	key = strings.TrimSpace(key)
	if key == "" || key == "title" || key == "name" {
		desc := dir == "desc"
		out := append([]Row(nil), rows...)
		sort.SliceStable(out, func(i, j int) bool {
			a, b := strings.ToLower(out[i].Title), strings.ToLower(out[j].Title)
			if desc {
				return a > b
			}
			return a < b
		})
		return out
	}
	desc := dir == "desc"
	out := append([]Row(nil), rows...)
	sort.SliceStable(out, func(i, j int) bool {
		a := strings.TrimSpace(out[i].Props[key])
		b := strings.TrimSpace(out[j].Props[key])
		if a == "" || b == "" {
			if a == b {
				return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
			}
			return a == ""
		}
		if af, err := strconv.ParseFloat(a, 64); err == nil {
			if bf, err := strconv.ParseFloat(b, 64); err == nil {
				if af == bf {
					return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
				}
				if desc {
					return af > bf
				}
				return af < bf
			}
		}
		at, ok1 := parseDateValue(a)
		bt, ok2 := parseDateValue(b)
		if ok1 && ok2 {
			if at.Equal(bt) {
				return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
			}
			if desc {
				return at.After(bt)
			}
			return at.Before(bt)
		}
		if desc {
			return strings.ToLower(a) > strings.ToLower(b)
		}
		return strings.ToLower(a) < strings.ToLower(b)
	})
	return out
}

// SyncDBSource keeps a database and the folder it looks at together: when the
// database page itself is renamed and its source was the folder of the same
// name, the folder follows. Renaming "Tasks" gives you "Projects" and
// "Projects/", not a database pointing at a folder nobody can find.
func (v *Vault) SyncDBSource(oldRel, newRel string) bool {
	if oldRel == "" || newRel == "" || oldRel == newRel {
		return false
	}
	p, err := v.Read(newRel)
	if err != nil || !isDatabase(p) {
		return false
	}
	oldBase := strings.TrimSuffix(path.Base(oldRel), ".md")
	newBase := strings.TrimSuffix(path.Base(newRel), ".md")
	if oldBase == newBase {
		return false
	}
	if !strings.EqualFold(strings.TrimSpace(p.Props["source"]), oldBase) {
		return false
	}
	dir := path.Dir(newRel)
	if dir == "." {
		dir = ""
	}
	oldDir := oldBase
	if dir != "" {
		oldDir = dir + "/" + oldBase
	}
	moved := false
	if abs, err := v.Abs(oldDir); err == nil {
		if st, err := os.Stat(abs); err == nil && st.IsDir() {
			if _, err := v.Rename(oldDir, newBase); err == nil {
				moved = true
			}
		}
	}
	_, _ = v.PatchMeta(newRel, map[string]string{"source": newBase}, nil)
	return moved
}
