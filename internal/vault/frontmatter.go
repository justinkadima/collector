package vault

import (
	"strconv"
	"strings"
	"time"
)

// Meta is the YAML frontmatter subset collector understands. Unknown keys are kept
// verbatim so files round-trip cleanly through other tools (Obsidian, etc).
type Meta struct {
	Icon    string
	Tags    []string
	Pinned  bool
	Created int64
	Updated int64
	// Extra keeps unknown lines verbatim so files round-trip through other
	// tools; Props is the same data parsed, which is what databases use.
	Extra     []string
	Props     map[string]string
	PropOrder []string
}

func splitFrontmatter(src string) (Meta, string) {
	var m Meta
	if !strings.HasPrefix(src, "---") {
		return m, src
	}
	// require the opening fence on its own line
	nl := strings.IndexByte(src, '\n')
	if nl < 0 || strings.TrimSpace(src[:nl]) != "---" {
		return m, src
	}
	rest := src[nl+1:]
	end := -1
	lines := strings.Split(rest, "\n")
	for i, ln := range lines {
		t := strings.TrimSpace(ln)
		if t == "---" || t == "..." {
			end = i
			break
		}
	}
	if end < 0 {
		return m, src
	}
	body := strings.Join(lines[end+1:], "\n")
	body = strings.TrimPrefix(body, "\n")

	for _, ln := range lines[:end] {
		t := strings.TrimSpace(ln)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		k, v, ok := strings.Cut(t, ":")
		if !ok {
			m.Extra = append(m.Extra, ln)
			continue
		}
		key := strings.ToLower(strings.TrimSpace(k))
		val := strings.TrimSpace(v)
		switch key {
		case "icon", "emoji":
			m.Icon = unquote(val)
		case "tags", "tag":
			m.Tags = parseList(val)
		case "pinned":
			m.Pinned = val == "true" || val == "yes"
		case "created", "date":
			m.Created = parseTime(val)
		case "updated", "modified":
			m.Updated = parseTime(val)
		case "title":
			// Filenames are canonical in collector; keep the key so other tools
			// still see it, but do not let it override the file name.
			m.Extra = append(m.Extra, ln)
		default:
			m.Extra = append(m.Extra, ln)
			if isScalar(val) {
				if m.Props == nil {
					m.Props = map[string]string{}
				}
				key = strings.TrimSpace(k)
				if _, seen := m.Props[key]; !seen {
					m.PropOrder = append(m.PropOrder, key)
				}
				m.Props[key] = unquote(val)
			}
		}
	}
	return m, body
}

func (m Meta) render() string {
	var b strings.Builder
	b.WriteString("---\n")
	if m.Created > 0 {
		b.WriteString("created: " + time.Unix(0, m.Created).UTC().Format(time.RFC3339) + "\n")
	}
	if m.Updated > 0 {
		b.WriteString("updated: " + time.Unix(0, m.Updated).UTC().Format(time.RFC3339) + "\n")
	}
	if m.Icon != "" {
		b.WriteString("icon: " + m.Icon + "\n")
	}
	if len(m.Tags) > 0 {
		b.WriteString("tags: [" + strings.Join(m.Tags, ", ") + "]\n")
	}
	if m.Pinned {
		b.WriteString("pinned: true\n")
	}
	for _, ln := range m.Extra {
		b.WriteString(strings.TrimRight(ln, "\r") + "\n")
	}
	b.WriteString("---\n")
	return b.String()
}

func unquote(s string) string {
	if len(s) >= 2 {
		if (s[0] == '"' && s[len(s)-1] == '"') || (s[0] == '\'' && s[len(s)-1] == '\'') {
			return s[1 : len(s)-1]
		}
	}
	return s
}

func parseList(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	if strings.HasPrefix(s, "[") && strings.HasSuffix(s, "]") {
		s = s[1 : len(s)-1]
	}
	var out []string
	for _, part := range strings.Split(s, ",") {
		v := strings.TrimSpace(unquote(strings.TrimSpace(part)))
		v = strings.TrimPrefix(v, "- ")
		if v != "" {
			out = append(out, v)
		}
	}
	return out
}

func parseTime(s string) int64 {
	s = unquote(strings.TrimSpace(s))
	if s == "" {
		return 0
	}
	for _, layout := range []string{time.RFC3339Nano, time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixNano()
		}
	}
	if n, err := strconv.ParseInt(s, 10, 64); err == nil {
		if n < 1e12 {
			n *= int64(time.Second)
		}
		return n
	}
	return 0
}

// isScalar reports whether a frontmatter value is a plain one-line scalar,
// i.e. something a database column can hold. Block lists and maps are left
// alone: they belong to the file, not to a table cell.
func isScalar(v string) bool {
	v = strings.TrimSpace(v)
	if v == "" {
		return false
	}
	if strings.HasPrefix(v, "[") && strings.HasSuffix(v, "]") {
		return true
	}
	return !strings.HasPrefix(v, "|") && !strings.HasPrefix(v, "{")
}

// yamlScalar renders a value that is safe to put after "key: " in YAML.
func yamlScalar(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return `""`
	}
	safe := true
	for i, r := range v {
		switch {
		case r == ':' && (i == len(v)-1 || v[i+1] == ' '):
			safe = false
		case r == '#' && i > 0 && v[i-1] == ' ':
			safe = false
		case r == '"' || r == '\\' || r == '\n' || r == '\t':
			safe = false
		case i == 0 && strings.ContainsRune("[]{}>|&*!%@`", r):
			safe = false
		case i == 0 && (r == '-' || r == '?'):
			safe = false
		}
		if !safe {
			break
		}
	}
	if !safe {
		esc := strings.ReplaceAll(v, `\`, `\\`)
		esc = strings.ReplaceAll(esc, `"`, `\"`)
		return `"` + esc + `"`
	}
	return v
}
