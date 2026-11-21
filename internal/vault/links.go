package vault

import (
	"path"
	"regexp"
	"strings"
)

var (
	wikiLinkRe = regexp.MustCompile(`\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]+)?(?:\|[^\[\]\n]+)?\]\]`)
	mdLinkRe   = regexp.MustCompile(`(!?)\[([^\[\]\n]*)\]\(([^()\s]+)(?:\s+"[^"]*")?\)`)
)

// ExtractLinks returns the outbound link targets of a markdown document.
// Wiki links keep their raw title; markdown links to local .md files are
// normalised to vault-relative paths.
func ExtractLinks(body, fromPath string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(v string) {
		v = strings.TrimSpace(v)
		if v == "" || seen[strings.ToLower(v)] {
			return
		}
		seen[strings.ToLower(v)] = true
		out = append(out, v)
	}

	for _, m := range wikiLinkRe.FindAllStringSubmatch(body, -1) {
		add(m[1])
	}
	for _, m := range mdLinkRe.FindAllStringSubmatch(body, -1) {
		if m[1] == "!" { // image
			continue
		}
		target := m[3]
		if strings.Contains(target, "://") || strings.HasPrefix(target, "mailto:") ||
			strings.HasPrefix(target, "#") || strings.HasPrefix(target, "/") {
			continue
		}
		if !strings.HasSuffix(strings.ToLower(target), ".md") {
			continue
		}
		if i := strings.IndexAny(target, "#?"); i >= 0 {
			target = target[:i]
		}
		if strings.HasSuffix(target, ".md") {
			p := path.Clean(path.Join(path.Dir(fromPath), target))
			add(p)
		}
	}
	return out
}
