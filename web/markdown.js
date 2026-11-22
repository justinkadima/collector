// A small, dependency-free markdown renderer covering the subset not1 uses.
// Everything is escaped; raw HTML in notes is shown as text (safer, and keeps
// files portable).

const CALLOUTS = {
  note: ["ℹ️", "Note"],
  info: ["ℹ️", "Info"],
  tip: ["💡", "Tip"],
  hint: ["💡", "Hint"],
  important: ["❗", "Important"],
  warning: ["⚠️", "Warning"],
  caution: ["⚠️", "Caution"],
  danger: ["🔥", "Danger"],
  error: ["🔥", "Error"],
  success: ["✅", "Success"],
  check: ["✅", "Done"],
  question: ["❓", "Question"],
  quote: ["❝", "Quote"],
  todo: ["☑️", "To-do"],
  example: ["🧪", "Example"],
};

const FILE_ICON =
  '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z"/><path d="M14 3v5h5"/></svg>';

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const isExternal = (u) => /^(https?:|mailto:|tel:)/i.test(u);

// A markdown image link is the storage format for every attachment; the
// extension decides how it renders.
const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv|ogv|ogg)$/i;
const AUDIO_RE = /\.(mp3|wav|m4a|oga|flac|aac|opus)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|tiff)$/i;

function mediaTag(src) {
  if (VIDEO_RE.test(src)) return "video";
  if (AUDIO_RE.test(src)) return "audio";
  return "img";
}

function fileUrl(rel, ctx) {
  if (typeof ctx.fileUrl === "function") return ctx.fileUrl(rel);
  return rel;
}

function inline(raw, ctx, st) {
  const tokens = [];
  const hold = (html) => {
    tokens.push(html);
    return `\u0000${tokens.length - 1}\u0000`;
  };

  let s = String(raw).replace(/`([^`\n]+)`/g, (_, code) => hold(`<code>${esc(code)}</code>`));
  s = esc(s);

  // images, video, audio — one syntax, three renderings
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+\S+)?\)/g, (_, alt, src) => {
    const url = isExternal(src) ? src : fileUrl(src.replace(/^\.\//, ""), ctx);
    const tag = mediaTag(src);
    if (tag === "video") {
      return hold(
        `<video class="md-media" src="${esc(url)}" controls preload="metadata" playsinline data-raw="${src}"></video>`
      );
    }
    if (tag === "audio") {
      return hold(
        `<audio class="md-media md-audio" src="${esc(url)}" controls preload="metadata" data-raw="${src}"></audio>`
      );
    }
    if (!isExternal(src) && !IMAGE_RE.test(src)) {
      // An attachment that isn't media: a file card, not a broken image.
      const name = src.split("/").pop() || alt || "file";
      const ext = src.includes(".") ? src.split(".").pop().toUpperCase() : "FILE";
      return hold(
        `<a class="md-file" href="${esc(url)}" download="${esc(name)}" data-file="${esc(src)}">` +
          `<span class="md-file-ico">${FILE_ICON}</span>` +
          `<span class="md-file-body"><span class="md-file-name">${esc(alt || name)}</span>` +
          `<span class="md-file-meta">${esc(ext)}</span></span></a>`
      );
    }
    return hold(`<img src="${esc(url)}" alt="${alt}" loading="lazy" data-raw="${src}">`);
  });

  // links
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)(?:\s+\S+)?\)/g, (_, text, href) => {
    const label = text || href;
    if (isExternal(href)) {
      return hold(`<a data-external href="${esc(href)}" rel="noreferrer">${label}</a>`);
    }
    const clean = href.replace(/^\.\//, "");
    if (/\.md(?:#.*)?$/i.test(clean)) {
      return hold(`<a data-md="${esc(clean)}" class="internal-link">${label}</a>`);
    }
    return hold(`<a data-wiki="${esc(clean)}" class="wikilink">${label}</a>`);
  });

  // wiki links
  s = s.replace(/\[\[([^\[\]|#\n]+)(?:#[^\[\]|\n]+)?(?:\|([^\[\]\n]+))?\]\]/g, (_, target, alias) => {
    const t = target.trim();
    const known = typeof ctx.hasTitle === "function" ? ctx.hasTitle(t) : true;
    const cls = known ? "wikilink" : "wikilink missing";
    const title = known ? `Open “${t}”` : `“${t}” has no page yet`;
    return hold(`<a class="${cls}" data-wiki="${esc(t)}" title="${esc(title)}">${esc(alias || t)}</a>`);
  });

  // emphasis
  s = s
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^\w_])_([^_\n]+)_/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
    .replace(/==([^=\n]+)==/g, "<mark>$1</mark>");

  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => tokens[Number(n)] ?? "");
  return s;
}

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR_RE = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const FENCE_RE = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const QUOTE_RE = /^\s{0,3}>/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function isBlockStart(line) {
  return (
    FENCE_RE.test(line) ||
    HEADING_RE.test(line) ||
    HR_RE.test(line) ||
    QUOTE_RE.test(line) ||
    LIST_RE.test(line)
  );
}

function splitCells(row) {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function renderList(items, ctx, st, at = "") {
  // Build a tree from indentation, then render grouped tags.
  const root = { children: [], indent: -1 };
  const stack = [root];
  for (const it of items) {
    while (stack.length > 1 && stack[stack.length - 1].indent >= it.indent) stack.pop();
    const node = { text: it.text, ordered: it.ordered, children: [], indent: it.indent, line: it.line };
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return renderNodes(root.children, ctx, st, at);
}

function renderNodes(nodes, ctx, st, at = "") {
  let html = "";
  let i = 0;
  while (i < nodes.length) {
    const tag = nodes[i].ordered ? "ol" : "ul";
    const group = [];
    while (i < nodes.length && (nodes[i].ordered ? "ol" : "ul") === tag) {
      group.push(nodes[i]);
      i++;
    }
    const allTasks = group.every((n) => /^\[[ xX]\]\s/.test(n.text));
    html += `<${tag}${allTasks ? ' class="tasks"' : ""}${at}>`;
    for (const n of group) {
      const m = n.text.match(/^\[([ xX])\]\s+([\s\S]*)$/);
      let cls = "";
      let body;
      if (m) {
        const id = st.task++;
        if (m[1] !== " ") cls = ' class="done"';
        body = `<input type="checkbox" class="task-box" data-task="${id}" ${
          m[1] !== " " ? "checked" : ""
        } aria-label="Toggle task"><span>${inline(m[2], ctx, st)}</span>`;
      } else {
        body = inline(n.text, ctx, st);
      }
      // A list item is its own editing unit; nested items are rendered inside
      // it and keep their own line numbers.
      const unit =
        n.line != null
          ? ` data-line="${n.line}" data-end="${n.line + 1}" data-kind="li" data-unit="1"`
          : "";
      html += `<li${cls}${unit}>${body}${n.children.length ? renderNodes(n.children, ctx, st) : ""}</li>`;
    }
    html += `</${tag}>`;
  }
  return html;
}

/* ------------------------------------------------------- code highlighting */

// Small and deliberately dumb: comments, strings, numbers, keywords. Colour is
// decoration, so a missed edge case only ever costs a wrong shade.
const kw = (s) => new Set(s.split(" "));
const C_LIKE =
  "const let var function return if else for while do class new this import from export default async await try catch finally throw typeof instanceof null true false undefined of in switch case break continue delete extends super yield static get set void";
const KEYWORDS = {
  js: kw(C_LIKE + " interface type enum implements readonly as public private protected namespace declare"),
  json: kw("true false null"),
  go: kw(
    "package import func var const type struct interface return if else for range switch case break continue go defer map chan select fallthrough goto nil true false int string bool byte error float64 make new len append cap delete copy panic recover"
  ),
  python: kw(
    "def class return if elif else for while in not and or import from as with try except finally raise lambda global nonlocal pass break continue yield assert del is None True False self async await"
  ),
  sh: kw("if then else elif fi for while do done case esac function return in export local set echo cd exit source shift eval exec read printf test"),
  rust: kw(
    "fn let mut pub use mod struct enum impl trait for in if else match loop while return self Self super crate as const static ref move unsafe async await dyn where Some None Ok Err"
  ),
  sql: kw(
    "select from where insert into values update set delete create table index join left right inner outer on group by order having limit offset and or not null as distinct union case when then end primary key foreign references drop alter add"
  ),
  c: kw(
    "include define int char float double void struct typedef static const return if else for while do switch case break continue sizeof goto unsigned signed long short enum union extern class public private protected virtual template namespace using new delete true false nullptr"
  ),
  yaml: kw("true false null yes no on off"),
};

// Display names for the code block header.
const LANG_LABEL = {
  js: "JavaScript",
  javascript: "JavaScript",
  jsx: "JSX",
  mjs: "JavaScript",
  cjs: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  tsx: "TSX",
  go: "Go",
  golang: "Go",
  py: "Python",
  python: "Python",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  shell: "Shell",
  console: "Shell",
  rs: "Rust",
  rust: "Rust",
  c: "C",
  cpp: "C++",
  "c++": "C++",
  java: "Java",
  kt: "Kotlin",
  swift: "Swift",
  sql: "SQL",
  json: "JSON",
  yaml: "YAML",
  yml: "YAML",
  toml: "TOML",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  xml: "XML",
  md: "Markdown",
  markdown: "Markdown",
  diff: "Diff",
  text: "Plain text",
  plaintext: "Plain text",
};

const LANGS = {};
for (const l of ["js", "javascript", "jsx", "mjs", "cjs", "ts", "typescript", "tsx"]) {
  LANGS[l] = { line: "//", block: ["/*", "*/"], keywords: KEYWORDS.js };
}
for (const l of ["go", "golang"]) LANGS[l] = { line: "//", block: ["/*", "*/"], keywords: KEYWORDS.go };
for (const l of ["py", "python"]) LANGS[l] = { line: "#", keywords: KEYWORDS.python };
for (const l of ["sh", "bash", "zsh", "shell", "console"]) LANGS[l] = { line: "#", keywords: KEYWORDS.sh };
for (const l of ["rs", "rust"]) LANGS[l] = { line: "//", block: ["/*", "*/"], keywords: KEYWORDS.rust };
for (const l of ["sql"]) LANGS[l] = { line: "--", block: ["/*", "*/"], keywords: KEYWORDS.sql };
for (const l of ["c", "cpp", "c++", "h", "hpp", "java", "kt", "kotlin", "swift", "cs", "csharp"]) {
  LANGS[l] = { line: "//", block: ["/*", "*/"], keywords: KEYWORDS.c };
}
for (const l of ["json"]) LANGS[l] = { line: null, keywords: KEYWORDS.json };
for (const l of ["yaml", "yml", "toml", "ini"]) LANGS[l] = { line: "#", keywords: KEYWORDS.yaml };

const WORD_CH = /[A-Za-z_$@]/;
const WORD_TAIL = /[A-Za-z0-9_$]/;

function highlight(code, langRaw) {
  const spec = LANGS[String(langRaw || "").toLowerCase()];
  if (!spec) return esc(code);
  const n = code.length;
  const parts = [];
  let i = 0;
  while (i < n) {
    const ch = code[i];
    if (spec.line && code.startsWith(spec.line, i)) {
      const nl = code.indexOf("\n", i);
      const stop = nl === -1 ? n : nl;
      parts.push(`<span class="tok-c">${esc(code.slice(i, stop))}</span>`);
      i = stop;
      continue;
    }
    if (spec.block && code.startsWith(spec.block[0], i)) {
      const close = code.indexOf(spec.block[1], i + spec.block[0].length);
      const stop = close === -1 ? n : close + spec.block[1].length;
      parts.push(`<span class="tok-c">${esc(code.slice(i, stop))}</span>`);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === ch) {
          j++;
          break;
        }
        if (ch !== "`" && code[j] === "\n") break;
        j++;
      }
      parts.push(`<span class="tok-s">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }
    if (ch >= "0" && ch <= "9" && !WORD_TAIL.test(code[i - 1] || "")) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoO._]/.test(code[j])) j++;
      parts.push(`<span class="tok-n">${esc(code.slice(i, j))}</span>`);
      i = j;
      continue;
    }
    if (WORD_CH.test(ch)) {
      let j = i;
      while (j < n && WORD_TAIL.test(code[j])) j++;
      const w = code.slice(i, j);
      parts.push(spec.keywords.has(w) ? `<span class="tok-k">${esc(w)}</span>` : esc(w));
      i = j;
      continue;
    }
    parts.push(esc(ch));
    i++;
  }
  return parts.join("");
}

/** The html for one attachment block (image, video, audio or file card). */
function mediaBlock(alt, src, ctx, at = "") {
  const url = isExternal(src) ? src : fileUrl(src.replace(/^\.\//, ""), ctx);
  const tag = mediaTag(src);
  if (tag === "video") {
    return `<div class="md-media-block"${at}><video class="md-media" src="${esc(url)}" controls preload="metadata" playsinline data-raw="${esc(
      src
    )}"></video></div>`;
  }
  if (tag === "audio") {
    return `<div class="md-media-block"${at}><audio class="md-media md-audio" src="${esc(url)}" controls preload="metadata" data-raw="${esc(
      src
    )}"></audio></div>`;
  }
  if (!isExternal(src) && !IMAGE_RE.test(src)) {
    const name = src.split("/").pop() || alt || "file";
    const ext = name.includes(".") ? name.split(".").pop().toUpperCase() : "FILE";
    return (
      `<a class="md-file" href="${esc(url)}" data-file="${esc(src)}"${at}>` +
      `<span class="md-file-ico">${FILE_ICON}</span>` +
      `<span class="md-file-body"><span class="md-file-name">${esc(alt || name)}</span>` +
      `<span class="md-file-meta">${esc(ext)}</span></span></a>`
    );
  }
  return `<img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" data-raw="${esc(src)}"${at}>`;
}

/** A lone link on its own line is a bookmark: title, host, letter tile. */
function bookmarkCard(title, href, at = "") {
  let host = href;
  try {
    host = new URL(href).host.replace(/^www\./, "");
  } catch {
    /* keep the raw url */
  }
  const path = href.replace(/^https?:\/\/[^/]+/i, "");
  let hue = 0;
  for (const ch of host) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  const label = title && title !== href ? title : host;
  return (
    `<a class="bookmark" href="${esc(href)}" data-external rel="noreferrer"${at}>` +
    `<span class="bookmark-ico" style="--h:${hue}">${esc(host.charAt(0).toUpperCase() || "?")}</span>` +
    `<span class="bookmark-body">` +
    `<span class="bookmark-title">${esc(label)}</span>` +
    `<span class="bookmark-url">${esc(host)}${path && path !== "/" ? esc(path) : ""}</span>` +
    `</span></a>`
  );
}

/* ----------------------------------------------------------------- events */

// One line of an ```events fence: a date, an optional time or time range, then a
// title. This is the same grammar the Go side indexes (internal/vault/events.go)
// — the fence is the only copy of an event, so both readers must agree.
const EVENT_LINE_RE = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2})(?:\s*[-–]\s*(\d{1,2}:\d{2}))?)?\s+(\S.*)$/;

const evDate = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/**
 * Read a block as events. Same grammar as internal/vault/events.go: a line that
 * parses is an event, and every line after it that is not blank, not a # note,
 * and not another event is its description.
 */
export function parseEvents(code) {
  return eventRows(code, 0).map((r) => ({ ...r.ev, desc: r.desc }));
}

export function parseEventLine(line) {
  const m = String(line || "").trim().match(EVENT_LINE_RE);
  if (!m) return null;
  const [y, mo, d] = m[1].split("-").map(Number);
  const at = new Date(y, mo - 1, d);
  if (at.getFullYear() !== y || at.getMonth() !== mo - 1 || at.getDate() !== d) return null;
  const title = m[4].trim();
  if (!title || title.startsWith("#")) return null;
  const clock = (v) => {
    const [h, mi] = v.split(":").map(Number);
    if (!(h >= 0 && h < 24 && mi >= 0 && mi < 60)) return "";
    return String(h).padStart(2, "0") + ":" + String(mi).padStart(2, "0");
  };
  const ev = { date: m[1], start: "", end: "", title, desc: "", at };
  if (m[2]) {
    ev.start = clock(m[2]);
    if (!ev.start || (m[3] && !clock(m[3]))) return null;
    if (m[3]) ev.end = clock(m[3]);
  }
  return ev;
}

/** The events of a block, with the line each was written on and its description. */
function eventRows(code, openLine) {
  const out = [];
  let cur = null;
  const lines = String(code || "").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const ev = parseEventLine(lines[i]);
    if (ev) {
      cur = { ev, n: openLine + 1 + i, desc: "" };
      out.push(cur);
      continue;
    }
    if (!cur) continue; // text before the event belongs to nothing
    const text = lines[i].trim();
    if (!text && !cur.desc) continue; // leading blanks do not start a description
    cur.desc = cur.desc ? cur.desc + "\n" + text : text;
  }
  for (const row of out) row.desc = row.desc.replace(/\n+$/, "");
  return out;
}

/**
 * An events fence renders as the thing it describes, not as source text.
 *
 * One block is one event: the label says Event, the row is the day, the time
 * and the title, and the description sits under the title. A block with
 * several events (an older page, or a hand-written one) reads as a list, and
 * only a block on its own asks for a description.
 */
function eventsBlock(code, at, openLine = 0) {
  const body = String(code || "");
  const rows = eventRows(body, openLine);
  const single = rows.length === 1;
  const today = isoToday();

  const more = `<button class="ev-more" title="Event options" aria-label="Event options">⋯</button>`;
  const html = rows
    .map(({ ev, n, desc }) => {
      const when = ev.start ? (ev.end ? ev.start + "–" + ev.end : ev.start) : "all day";
      const hint = desc ? "Change the description" : "Add a description";
      return (
        `<li class="ev${ev.date === today ? " today" : ""}" data-ev-line="${n}">` +
        `<button class="ev-day" title="Change the day">${esc(evDate.format(ev.at))}</button>` +
        `<button class="ev-time${ev.start ? "" : " all"}" title="Change the time">${esc(when)}</button>` +
        `<div class="ev-text">` +
        `<span class="ev-title" title="Change the title">${esc(ev.title)}</span>` +
        `<div class="ev-desc${desc ? "" : " empty"}" title="${hint}">${
          desc ? esc(desc) : single ? "Add a description…" : ""
        }</div>` +
        `</div>` +
        more +
        `</li>`
      );
    })
    .join("");

  const bar =
    `<div class="md-events-bar"><span class="md-events-label">${rows.length > 1 ? "Events" : "Event"}</span>` +
    (rows.length > 1 ? `<span class="md-events-count">${rows.length}</span>` : "") +
    `<button class="md-events-more" title="Block options" aria-label="Block options">⋯</button></div>`;

  const inner = html
    ? `<ul class="md-events-list">${html}</ul>`
    : body.trim()
      ? `<div class="md-events-empty ev-bad-lines">${esc(body.trim())}</div>`
      : `<div class="md-events-empty">No events yet.</div>`;

  return `<div class="md-events${single ? " single" : ""}"${at}>${bar}<div class="md-events-body">${inner}</div></div>`;
}

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function renderMarkdown(src, ctx = {}) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  // Every top-level block records the source lines it came from (end exclusive),
  // so clicking it can put the caret back into those lines of the markdown.
  const at = (kind, start, end) => ` data-line="${start}" data-end="${end}" data-kind="${kind}"`;
  const st = { task: 0 };
  let out = "";
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence) {
      const openLine = i;
      const marker = fence[1][0];
      const lang = fence[2] || "";
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence (or EOF)
      const code = buf.join("\n");
      if (lang.toLowerCase() === "events") {
        out += eventsBlock(code, at("events", openLine, i), openLine);
        continue;
      }
      const label = LANG_LABEL[lang.toLowerCase()] || (lang ? lang.toUpperCase() : "Text");
      out +=
        `<div class="md-code" data-line="${openLine}" data-end="${i}" data-kind="code" data-lang="${esc(lang)}">` +
        `<div class="md-code-bar">` +
        `<button class="md-code-lang" data-opens-menu="1" title="Change language">${esc(label)}</button>` +
        `<button class="md-code-copy" title="Copy code">Copy</button>` +
        `</div>` +
        `<pre><code>${highlight(code, lang)}</code></pre></div>`;
      continue;
    }

    const h = line.match(HEADING_RE);
    if (h) {
      const level = h[1].length;
      out += `<h${level}${at("h" + level, i, i + 1)}>${inline(h[2], ctx, st)}</h${level}>`;
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out += `<hr${at("hr", i, i + 1)}>`;
      i++;
      continue;
    }

    // table — every cell remembers the source line and column it came from, so
    // clicking one can put the caret inside that cell of the markdown.
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const headLine = i;
      const head = splitCells(line);
      const align = splitCells(lines[i + 1]).map((c) => {
        const l = c.startsWith(":");
        const r = c.endsWith(":");
        return l && r ? "center" : r ? "right" : l ? "left" : "";
      });
      i += 2;
      const cell = (tag, text, idx, srcLine) =>
        `<${tag} data-line="${srcLine}" data-col="${idx}"${
          align[idx] ? ` style="text-align:${align[idx]}"` : ""
        }>${inline(text, ctx, st)}</${tag}>`;
      let body = "";
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        const srcLine = i;
        body +=
          "<tr>" +
          splitCells(lines[i]).map((c, idx) => cell("td", c, idx, srcLine)).join("") +
          "</tr>";
        i++;
      }
      out +=
        `<table${at("table", headLine, i)}><thead><tr>` +
        head.map((c, idx) => cell("th", c, idx, headLine)).join("") +
        "</tr></thead><tbody>" +
        body +
        "</tbody></table>";
      continue;
    }

    // A line that is only an attachment link is its own block, like Notion's
    // image/video/file blocks — no paragraph wrapper, no stray line breaks.
    const soleMedia = line.match(/^\s*!\[([^\]]*)\]\(([^)\s]+)(?:\s+\S+)?\)\s*$/);
    if (soleMedia) {
      out += mediaBlock(soleMedia[1], soleMedia[2], ctx, at("media", i, i + 1));
      i++;
      continue;
    }

    // blockquote / callout
    if (QUOTE_RE.test(line)) {
      const qStart = i;
      const buf = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        buf.push(lines[i].replace(/^\s{0,3}>\s?/, ""));
        i++;
      }
      const callout = buf[0]?.match(/^\[!(\w+)\]\s*(.*)$/);
      if (callout) {
        const info = CALLOUTS[callout[1].toLowerCase()] || ["💡", callout[1]];
        const rest = [callout[2], ...buf.slice(1)].join("\n").trim();
        out += `<div class="callout"${at("callout", qStart, i)}><div class="callout-icon">${info[0]}</div><div class="callout-body"><p><strong>${esc(
          info[1]
        )}</strong></p>${rest ? renderMarkdown(rest, ctx) : ""}</div></div>`;
      } else {
        out += `<blockquote${at("quote", qStart, i)}>${renderMarkdown(buf.join("\n"), ctx)}</blockquote>`;
      }
      continue;
    }

    // list
    if (LIST_RE.test(line)) {
      const listStart = i;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(LIST_RE);
        if (m) {
          items.push({
            indent: m[1].replace(/\t/g, "  ").length,
            ordered: /^\d/.test(m[2]),
            text: m[3],
            line: i,
          });
          i++;
          continue;
        }
        // lazy continuation of the previous item
        if (items.length && l.trim() && !isBlockStart(l) && /^\s{2,}/.test(l)) {
          items[items.length - 1].text += "\n" + l.trim();
          i++;
          continue;
        }
        break;
      }
      out += renderList(items, ctx, st, at("list", listStart, i));
      continue;
    }

    // paragraph
    const pStart = i;
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i]) && !TABLE_SEP_RE.test(lines[i])) {
      if (lines[i].includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) break;
      buf.push(lines[i]);
      i++;
    }
    let sole = buf.length === 1 ? buf[0].match(/^\s*\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\s*$/) : null;
    if (!sole && buf.length === 1) {
      const bare = buf[0].match(/^\s*(https?:\/\/\S+)\s*$/);
      if (bare) sole = [bare[0], "", bare[1]];
    }
    if (sole) {
      out += bookmarkCard(sole[1], sole[2], at("bookmark", pStart, i));
      continue;
    }
    out += `<p${at("p", pStart, i)}>${inline(buf.join("\n"), ctx, st).replace(/\n/g, "<br>")}</p>`;
  }

  return out;
}

const TASK_RE = /^(\s*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/gm;

/** Flip the nth task checkbox in the source text. Returns the new source. */
export function toggleTask(src, index) {
  let n = 0;
  return String(src).replace(TASK_RE, (match, prefix, state) => {
    if (n++ !== index) return match;
    return `${prefix}[${state === " " ? "x" : " "}]`;
  });
}

export function countTasks(src) {
  return [...String(src).matchAll(TASK_RE)].length;
}

/** Render a single cell's markdown (no block parsing) for in-place editing. */
export function renderInline(md, ctx = {}) {
  return inline(md, ctx, { task: 0 });
}

export { esc as escapeHtml };
