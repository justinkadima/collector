package server

import (
	"encoding/base64"
	"fmt"
	"io"
	"io/fs"
	"mime"
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

	"github.com/justinkadima/collector/internal/vault"
)

// maxInline is the size above which an attachment is linked by absolute path
// instead of being baked into the HTML as a data URI. Screenshots and audio
// stay self-contained; a 200MB video does not turn into a 270MB document.
const maxInline = 8 << 20

type exportReq struct {
	Path    string   `json:"path"`
	Title   string   `json:"title"`
	Format  string   `json:"format"` // md | html | pdf
	HTML    string   `json:"html"`   // rendered body, for html and pdf
	Icon    string   `json:"icon"`
	Tags    []string `json:"tags"`
	Created int64    `json:"created"`
	Updated int64    `json:"updated"`
	// Dst skips the save dialog and writes straight to this path. The UI always
	// picks a path; this exists so the export can be scripted and tested.
	Dst string `json:"dst"`
}

// handleExport writes one page to a location the user picks: the raw markdown,
// a self-contained HTML document, or a PDF printed from that document.
func (s *Server) handleExport(w http.ResponseWriter, r *http.Request) {
	var in exportReq
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

	format := strings.ToLower(strings.TrimSpace(in.Format))
	if format != "md" && format != "html" && format != "pdf" {
		writeErr(w, fmt.Errorf("%w: unknown format %q", vault.ErrInvalid, in.Format))
		return
	}

	title := strings.TrimSpace(in.Title)
	if title == "" {
		title = strings.TrimSuffix(path.Base(in.Path), ".md")
	}
	if title == "" {
		title = "Untitled"
	}

	ext := map[string]string{"md": ".md", "html": ".html", "pdf": ".pdf"}[format]
	dst := strings.TrimSpace(in.Dst)
	if dst == "" {
		picked, cancelled, perr := pickSavePath(fileName(title)+ext, "Export “"+title+"” as "+strings.ToUpper(format))
		if perr != nil {
			writeErr(w, perr)
			return
		}
		if cancelled {
			writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
			return
		}
		dst = picked
	}
	if strings.ToLower(filepath.Ext(dst)) != ext {
		dst += ext
	}
	if abs, aerr := filepath.Abs(dst); aerr == nil {
		dst = abs
	}

	resp := map[string]any{"file": dst, "name": filepath.Base(dst), "format": format}

	switch format {
	case "md":
		// The .md file on disk *is* the page, so exporting it is a copy.
		src, ferr := v.FilePath(in.Path)
		if ferr != nil {
			writeErr(w, ferr)
			return
		}
		if same, _ := filepath.Abs(src); same == dst {
			writeErr(w, fmt.Errorf("%w: source and destination are the same file", vault.ErrInvalid))
			return
		}
		if err := copyFile(src, dst); err != nil {
			writeErr(w, err)
			return
		}
	case "html":
		doc := s.renderDoc(v, in, title)
		if err := os.WriteFile(dst, []byte(doc), 0o644); err != nil {
			writeErr(w, err)
			return
		}
	case "pdf":
		doc := s.renderDoc(v, in, title)
		if err := writePDF(doc, dst, title); err != nil {
			writeErr(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// fileName turns a page title into something a filesystem will accept.
func fileName(title string) string {
	r := strings.NewReplacer("/", "-", "\\", "-", ":", "-", "\x00", "")
	name := strings.TrimSpace(r.Replace(title))
	if name == "" {
		name = "Untitled"
	}
	if len(name) > 96 {
		name = strings.TrimSpace(name[:96])
	}
	return name
}

func copyFile(src, dst string) error {
	st, err := os.Stat(src)
	if err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	// Temp file + rename would lose an existing file's permissions; a page
	// export is small enough that a plain write is fine.
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, st.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

/* ------------------------------------------------------------- the document */

const docCSS = `
html.export, body.export { height: auto; overflow: visible; }
body.export { background: var(--bg); }
.doc {
  max-width: 720px;
  margin: 0 auto;
  padding: 64px 32px 96px;
}
.doc-head { margin-bottom: 40px; }
.doc-icon { font-size: 44px; line-height: 1.1; }
.doc-icon svg.i { width: 44px; height: 44px; stroke-width: 1.3; color: var(--text-soft); }
.doc-title {
  font-size: 40px;
  font-weight: 700;
  letter-spacing: -0.022em;
  line-height: 1.15;
  margin: 8px 0 10px;
}
.doc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 12.5px;
  color: var(--text-faint);
}
.doc-tags { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.doc-tag {
  font-size: 12px;
  color: var(--text-soft);
  background: var(--hover);
  border-radius: 999px;
  padding: 2px 9px;
}
.doc-foot {
  margin-top: 64px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--text-faint);
}
.doc-foot a { color: inherit; }
@media print {
  @page { margin: 18mm 16mm; }
  html.export, body.export { background: #fff; color: #000; }
  .doc { max-width: none; padding: 0; }
  .doc-foot { margin-top: 32px; }
  .md pre, .md table, .md .bookmark, .md .md-file, .md .md-media-block { break-inside: avoid; }
  .md h1, .md h2, .md h3 { break-after: avoid; }
}
`

// renderDoc produces one self-contained HTML file: the app's stylesheet inline,
// attachments as data URIs, and internal links flattened to plain text (there is
// no app to navigate to outside collector).
func (s *Server) renderDoc(v *vault.Vault, in exportReq, title string) string {
	body := inlineAssets(in.HTML, v)
	body = stripInternalLinks(body)

	icon := strings.TrimSpace(in.Icon)
	glyph := ""
	switch {
	case icon == vault.DatabaseIcon || icon == "":
		// nothing: an emoji-less page exports as plain text
	case isEmoji(icon):
		glyph = `<div class="doc-icon">` + htmlEsc(icon) + `</div>`
	}

	meta := []string{}
	if in.Updated > 0 {
		w := wordCount(in.HTML)
		meta = append(meta, "Edited "+shortDate(in.Updated))
		if w > 0 {
			meta = append(meta, fmt.Sprintf("%d words", w))
		}
	}
	tags := ""
	if len(in.Tags) > 0 {
		parts := make([]string, 0, len(in.Tags))
		for _, t := range in.Tags {
			if t = strings.TrimSpace(t); t != "" {
				parts = append(parts, `<span class="doc-tag">#`+htmlEsc(t)+`</span>`)
			}
		}
		if len(parts) > 0 {
			tags = `<div class="doc-tags">` + strings.Join(parts, "") + `</div>`
		}
	}
	metaHTML := ""
	if len(meta) > 0 {
		metaHTML = `<div class="doc-meta"><span>` + strings.Join(meta, "</span><span>·</span><span>") + `</span></div>`
	}

	var b strings.Builder
	b.WriteString("<!doctype html>\n<html lang=\"en\" class=\"export\">\n<head>\n")
	b.WriteString("<meta charset=\"utf-8\">\n")
	b.WriteString("<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n")
	b.WriteString("<meta name=\"generator\" content=\"Collector\">\n")
	b.WriteString("<title>" + htmlEsc(title) + "</title>\n")
	b.WriteString("<style>\n")
	b.WriteString(s.appCSS())
	b.WriteString("\n</style>\n<style>\n")
	b.WriteString(docCSS)
	b.WriteString("</style>\n</head>\n<body class=\"export\">\n<main class=\"doc\">\n")
	b.WriteString("<header class=\"doc-head\">")
	b.WriteString(glyph)
	b.WriteString("<h1 class=\"doc-title\">" + htmlEsc(title) + "</h1>")
	b.WriteString(metaHTML)
	b.WriteString(tags)
	b.WriteString("</header>\n<article class=\"md\">\n")
	b.WriteString(body)
	b.WriteString("\n</article>\n<footer class=\"doc-foot\">Exported from Collector · ")
	b.WriteString(time.Now().Format("2 January 2006"))
	b.WriteString("</footer>\n</main>\n</body>\n</html>\n")
	return b.String()
}

var assetAttr = regexp.MustCompile(`(src|href)="collector-asset:([^"]*)"`)

// inlineAssets replaces the collector-asset: placeholders the renderer emits with
// data URIs (small files) or absolute file:// links (large ones).
func inlineAssets(html string, v *vault.Vault) string {
	return assetAttr.ReplaceAllStringFunc(html, func(m string) string {
		sub := assetAttr.FindStringSubmatch(m)
		attr, rel := sub[1], sub[2]
		if u, err := url.PathUnescape(rel); err == nil {
			rel = u
		}
		abs, err := v.FilePath(rel)
		if err != nil {
			return attr + `=""`
		}
		st, err := os.Stat(abs)
		if err != nil || st.IsDir() {
			return attr + `=""`
		}
		if st.Size() > maxInline {
			return attr + `="` + htmlEsc(fileURL(abs)) + `"`
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			return attr + `=""`
		}
		mt := mime.TypeByExtension(strings.ToLower(filepath.Ext(abs)))
		if mt == "" {
			mt = mimeForExt(strings.ToLower(filepath.Ext(abs)))
		}
		return attr + `="data:` + mt + `;base64,` + base64.StdEncoding.EncodeToString(data) + `"`
	})
}

var (
	wikiAnchor = regexp.MustCompile(`(?s)<a\b[^>]*\bdata-wiki="[^"]*"[^>]*>(.*?)</a>`)
	pageAnchor = regexp.MustCompile(`(?s)<a\b[^>]*\bdata-md="[^"]*"[^>]*>(.*?)</a>`)
)

// stripInternalLinks flattens links to other pages: outside the app there is no
// page to open, so the words should read as words, not as dead links.
func stripInternalLinks(html string) string {
	html = wikiAnchor.ReplaceAllString(html, `<span class="wikilink">$1</span>`)
	html = pageAnchor.ReplaceAllString(html, `<span class="internal-link">$1</span>`)
	return html
}

func fileURL(abs string) string {
	u := url.URL{Scheme: "file", Path: abs}
	return u.String()
}

func mimeForExt(ext string) string {
	switch ext {
	case ".mp4", ".m4v":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mov":
		return "video/quicktime"
	case ".mp3":
		return "audio/mpeg"
	case ".m4a":
		return "audio/mp4"
	case ".wav":
		return "audio/wav"
	case ".ogg":
		return "audio/ogg"
	case ".svg":
		return "image/svg+xml"
	case ".pdf":
		return "application/pdf"
	}
	return "application/octet-stream"
}

func isEmoji(s string) bool {
	for _, r := range s {
		if r > 0x2000 {
			return true
		}
	}
	return false
}

func wordCount(html string) int {
	text := regexp.MustCompile(`<[^>]*>`).ReplaceAllString(html, " ")
	return len(strings.Fields(text))
}

func shortDate(ns int64) string {
	t := time.Unix(0, ns)
	now := time.Now()
	if t.Year() == now.Year() {
		return t.Format("2 Jan")
	}
	return t.Format("2 Jan 2006")
}

// appCSS is the app's own stylesheet, so an export looks like the page it came
// from instead of like a different product.
func (s *Server) appCSS() string {
	if s.web == nil {
		return ""
	}
	b, err := fs.ReadFile(s.web, "style.css")
	if err != nil {
		return ""
	}
	return string(b)
}

/* -------------------------------------------------------------------- files */

// pickSavePath asks the OS where to write, with a suggested name.
func pickSavePath(defaultName, prompt string) (string, bool, error) {
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf(
			`POSIX path of (choose file name with prompt "%s" default name "%s")`,
			strings.ReplaceAll(prompt, `"`, `'`), strings.ReplaceAll(defaultName, `"`, `'`))
		out, err := exec.Command("osascript", "-e", script).Output()
		if err != nil {
			return "", true, nil // user cancelled
		}
		return strings.TrimSpace(string(out)), false, nil
	case "linux":
		if _, err := exec.LookPath("zenity"); err == nil {
			out, err := exec.Command("zenity", "--file-selection", "--save",
				"--confirm-overwrite", "--title="+prompt, "--filename="+defaultName).Output()
			if err != nil {
				return "", true, nil
			}
			return strings.TrimSpace(string(out)), false, nil
		}
	}
	return "", false, fmt.Errorf("no native save dialog on %s", runtime.GOOS)
}

/* ---------------------------------------------------------------------- pdf */

// writePDF prints the document with a headless Chromium if one is installed.
// Without one there is no PDF engine to lean on, so the same document is opened
// in the default browser with the print dialog up, where "Save as PDF" is one
// click away — better than a button that just fails.
func writePDF(doc, dst, title string) error {
	if browser := findChrome(); browser != "" {
		tmp, err := os.CreateTemp("", "collector-export-*.html")
		if err != nil {
			return err
		}
		tmpPath := tmp.Name()
		defer os.Remove(tmpPath)
		if _, err := tmp.WriteString(doc); err != nil {
			tmp.Close()
			return err
		}
		tmp.Close()

		prof, err := os.MkdirTemp("", "collector-chrome-*")
		if err == nil {
			defer os.RemoveAll(prof)
		}
		args := []string{
			"--headless=new",
			"--disable-gpu",
			"--no-first-run",
			"--no-default-browser-check",
			"--no-pdf-header-footer",
			"--print-to-pdf-no-header",
			"--virtual-time-budget=5000",
			"--print-to-pdf=" + dst,
			fileURL(tmpPath),
		}
		if prof != "" {
			args = append([]string{"--user-data-dir=" + prof}, args...)
		}
		cmd := exec.Command(browser, args...)
		out, err := cmd.CombinedOutput()
		if err == nil {
			if st, serr := os.Stat(dst); serr == nil && st.Size() > 0 {
				return nil
			}
			err = fmt.Errorf("no pdf produced")
		}
		return fmt.Errorf("pdf export failed: %w: %s", err, strings.TrimSpace(string(out)))
	}

	// No Chromium: hand it to the browser's print dialog instead.
	htmlDst := strings.TrimSuffix(dst, filepath.Ext(dst)) + ".html"
	page := strings.Replace(doc, "</body>",
		"<script>addEventListener('load',function(){setTimeout(function(){print()},350)})</script></body>", 1)
	if err := os.WriteFile(htmlDst, []byte(page), 0o644); err != nil {
		return err
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", htmlDst)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", htmlDst)
	default:
		cmd = exec.Command("xdg-open", htmlDst)
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	return fmt.Errorf("no Chromium found for PDF export — opened %s instead, choose “Save as PDF” in the print dialog", filepath.Base(htmlDst))
}

// findChrome looks for a Chromium-family browser that can print to PDF.
func findChrome() string {
	candidates := []string{
		"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
		"/Applications/Chromium.app/Contents/MacOS/Chromium",
		"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
		"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		"/Applications/Arc.app/Contents/MacOS/Arc",
	}
	for _, p := range candidates {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p
		}
	}
	for _, name := range []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "brave-browser", "microsoft-edge", "chrome-headless-shell"} {
		if p, err := exec.LookPath(name); err == nil {
			return p
		}
	}
	return ""
}

func htmlEsc(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return r.Replace(s)
}
