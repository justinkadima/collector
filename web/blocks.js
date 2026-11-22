// Editing on the page, like the table cells: the rendered document is the
// surface. Click a paragraph and a textarea is laid exactly over it, holding
// that block's markdown — markers stripped, so a heading reads as a heading
// while you type. Commit, and the block renders again.
//
// A textarea rather than contenteditable on purpose: caret, selection, undo,
// IME and paste are the browser's problem, not ours.

const BLOCK = "[data-line][data-end]";
const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** Kinds whose text is the raw markdown (no marker to hide). */
const RAW = new Set(["p", "bookmark", "list"]);

/* ------------------------------------------------------------ kind mapping */

/** Split a block's source into the text to show and what to put back. */
function strip(kind, raw) {
  const lines = raw.split("\n");
  if (/^h[1-6]$/.test(kind)) {
    const m = lines[0].match(/^(#{1,6}\s+)/);
    return { text: m ? lines[0].slice(m[1].length) : lines[0], meta: { marker: m ? m[1] : "" } };
  }
  if (kind === "li") {
    const m = raw.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(\[[ xX]\]\s+)?/);
    if (!m) return { text: raw, meta: { indent: "", marker: "", box: "" } };
    return {
      text: raw.slice(m[0].length),
      meta: { indent: m[1].match(/^\s*/)[0], marker: m[1].trim() + " ", box: m[2] || "" },
    };
  }
  if (kind === "quote" || kind === "callout") {
    return { text: lines.map((l) => l.replace(/^\s{0,3}>\s?/, "")).join("\n"), meta: {} };
  }
  if (kind === "code" || kind === "events") {
    const open = lines[0].match(/^\s*(`{3,}|~{3,})\s*([\w+#-]*)/);
    const fence = open ? open[1] : "```";
    const lang = open ? open[2] || "" : "";
    const body = lines.slice(1, lines.length > 1 ? -1 : 1);
    return { text: body.join("\n"), meta: { fence, lang } };
  }
  return { text: raw, meta: {} };
}

/** Rebuild source lines from edited text. */
function add(kind, meta, text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  if (/^h[1-6]$/.test(kind)) {
    if (!lines[0].trim()) return "";
    return (meta.marker || "# ") + lines[0] + (lines.length > 1 ? "\n" + lines.slice(1).join("\n") : "");
  }
  if (kind === "li") {
    const marker = meta.marker || "- ";
    const first = (meta.indent || "") + marker + (meta.box || "") + lines[0];
    if (lines.length === 1) return first;
    // continuation lines stay inside the same item
    return [first, ...lines.slice(1)].join("\n");
  }
  if (kind === "quote" || kind === "callout") {
    return lines.map((l) => "> " + l).join("\n");
  }
  if (kind === "code" || kind === "events") {
    const fence = meta.fence || "```";
    return fence + (meta.lang || "") + "\n" + lines.join("\n") + "\n" + fence;
  }
  return lines.join("\n");
}

/** How much of a source line is marker, so caret offsets line up. */
function prefixLen(kind, meta, lineIdx) {
  if (kind === "quote" || kind === "callout") return 2; // every line is "> "
  if (kind === "code" || kind === "events") return 0;
  if (lineIdx > 0) return 0;
  if (/^h[1-6]$/.test(kind)) return (meta.marker || "").length;
  if (kind === "li") return (meta.indent || "").length + (meta.marker || "").length + (meta.box || "").length;
  return 0;
}

/* Rough but honest caret placement: measure the line's text with the same font
   and find the character boundary nearest the click. */
let measurer = null;
function colFromPoint(text, font, x) {
  if (!text) return 0;
  if (!measurer) measurer = document.createElement("canvas").getContext("2d");
  measurer.font = font;
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i <= text.length; i++) {
    const w = measurer.measureText(text.slice(0, i)).width;
    const d = Math.abs(w - x);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** The marker a new block gets when the user presses Enter. */
function nextMarker(kind, meta, after, wasEmpty) {
  const empty = !after.trim();
  if (kind === "code") return null; // stay inside the fence
  if (kind === "li") {
    // Enter on an empty item ends the list; Enter anywhere else continues it.
    if (empty && wasEmpty) return { kind: "p", meta: {} };
    const n = (meta.marker || "").match(/^(\d+)([.)])\s*$/);
    const marker = n ? `${Number(n[1]) + 1}${n[2]} ` : meta.marker || "- ";
    return { kind: "li", meta: { indent: meta.indent || "", marker, box: meta.box || "" } };
  }
  if (kind === "quote" || kind === "callout") return { kind: "quote", meta: {} };
  return { kind: "p", meta: {} };
}

/* ------------------------------------------------------------------ helpers */

const nl = (s, upto = s.length) => {
  let n = 0;
  for (let i = 0; i < upto; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
};

function offsetIn(src, line, col) {
  let n = 0;
  for (let i = 0; i < line; i++) {
    const k = src.indexOf("\n", n);
    if (k < 0) return src.length;
    n = k + 1;
  }
  return Math.min(n + col, src.length);
}

const css = (node, prop) => getComputedStyle(node).getPropertyValue(prop);

/** A line of prose: text a paragraph would swallow if it came next. */
const isProse = (line) =>
  !!line.trim() &&
  !LIST_LINE.test(line) &&
  !/^\s{0,3}>/.test(line) &&
  !/^#{1,6}\s/.test(line) &&
  !/^\s*(?:`{3,}|~{3,})/.test(line) &&
  !/^\s*\|/.test(line) &&
  !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);

/** Index of the previous non-blank line, or null at the top of the page. */
function previousLine(lines, from) {
  for (let i = from - 1; i >= 0; i--) if (lines[i].trim()) return i;
  return null;
}

/* ------------------------------------------------------------------- module */

export function initBlocks(opts) {
  const { host, body, commit, render, key: appKey, caret: onCaret, editable } = opts;
  let edit = null; // {unit, kind, start, end, meta, ta, orig, ghost, box}
  let layoutWatch = null; // keeps the overlay on its block
  let lastBox = null;

  /* ---- starting and stopping an edit ---- */

  function startEdit(unit, at = null, point = null) {
    if (edit) close(edit);
    const kind0 = unit.dataset.kind || "p";
    const start = Number(unit.dataset.line) || 0;
    const end = Number(unit.dataset.end) || start + 1;
    const raw = (body() || "").split("\n").slice(start, end).join("\n");
    const kind = unit.dataset.unit === "1" && kind0 === "li" ? "li" : kind0 === "list" ? "p" : kind0;
    const { text, meta } = strip(kind, raw);

    const ta = document.createElement("textarea");
    ta.className = "block-edit";
    ta.spellcheck = true;
    ta.rows = 1;
    ta.value = text;

    // An events block edits its raw lines over its own body, so the card stays
    // where it is while the fence is being typed.
    const inner = kind === "events" ? unit.querySelector(".md-events-body") : null;
    const box = kind === "code" ? unit.querySelector("pre") || unit : inner || unit;
    const textFrom = unit.matches("li")
      ? unit
      : kind === "code"
        ? unit.querySelector("code") || unit
        : inner || unit.querySelector(":scope > p") || unit;
    styleOf(textFrom).forEach(([k, v]) => ta.style.setProperty(k, v));
    if (kind === "events") {
      // Raw event lines line up in columns, so the fence is edited as data.
      ta.style.setProperty("font-family", css(document.documentElement, "--mono"));
      ta.style.setProperty("font-size", "12.8px");
      ta.style.setProperty("line-height", "1.62");
      ta.style.setProperty("padding-top", "6px");
      ta.style.setProperty("padding-bottom", "6px");
      ta.style.setProperty("padding-left", "12px");
      ta.style.setProperty("padding-right", "12px");
    }
    place(ta, box);

    unit.classList.add("block-hidden");
    unit.parentElement.insertBefore(ta, unit.nextSibling);

    edit = { unit, kind, start, end, meta, ta, orig: text, ghost: unit.dataset.ghost === "1", box };
    grow();
    follow();
    ta.focus({ preventScroll: true });
    let off = at == null ? ta.value.length : Math.max(0, Math.min(at, ta.value.length));
    if (point) {
      const r = ta.getBoundingClientRect();
      const lh = parseFloat(css(ta, "line-height")) || 20;
      const padTop = parseFloat(css(ta, "padding-top")) || 0;
      const padLeft = parseFloat(css(ta, "padding-left")) || 0;
      const linesOf = ta.value.split("\n");
      const line = Math.max(0, Math.min(linesOf.length - 1, Math.floor((point.y - r.top - padTop) / lh)));
      let base = 0;
      for (let i = 0; i < line; i++) base += linesOf[i].length + 1;
      off = Math.min(ta.value.length, base + colFromPoint(linesOf[line], css(ta, "font"), point.x - r.left - padLeft));
    }
    ta.setSelectionRange(off, off);
    syncCaret();
    ta.addEventListener("input", onInput);
    ta.addEventListener("keydown", onKey);
    ta.addEventListener("blur", onBlur);
    return edit;
  }

  const STYLE_PROPS = [
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "color",
    "text-align",
    "padding-top",
    "padding-bottom",
    "padding-left",
    "padding-right",
    "text-transform",
  ];

  function styleOf(node) {
    const cs = getComputedStyle(node);
    return STYLE_PROPS.map((p) => [p, cs.getPropertyValue(p)]);
  }

  function place(ta, unit) {
    const hb = host.getBoundingClientRect();
    const ub = unit.getBoundingClientRect();
    ta.style.left = ub.left - hb.left - host.clientLeft + "px";
    ta.style.top = ub.top - hb.top - host.clientTop + "px";
    ta.style.width = Math.max(40, ub.width) + "px";
  }

  /** Keep the overlay on its block when the page above it changes height.
   *  Images arrive after the page does, fonts settle, a block grows: the
   *  overlay is pinned in page coordinates, so without this it stays where the
   *  block used to be while the block slides away. */
  function follow() {
    layoutWatch?.disconnect();
    layoutWatch = null;
    if (!edit) return;
    const { ta, box } = edit;
    if (typeof ResizeObserver !== "function") return;
    const settle = () => {
      if (!edit || edit.ta !== ta || !ta.isConnected) return;
      place(ta, box);
      grow();
    };
    layoutWatch = new ResizeObserver(settle);
    layoutWatch.observe(host);
    host.addEventListener("load", settle, true);
    edit.settle = settle;
  }

  function grow() {
    if (!edit) return;
    const { ta, unit } = edit;
    ta.style.height = "auto";
    ta.style.height = Math.max(24, ta.scrollHeight) + "px";
    // Keep the flow below the block where the eye expects it.
    unit.style.height = ta.style.height;
    unit.style.minHeight = ta.style.height;
  }

  function close(ed) {
    if (!ed) return;
    ed.ta.removeEventListener("input", onInput);
    ed.ta.removeEventListener("keydown", onKey);
    ed.ta.removeEventListener("blur", onBlur);
    ed.ta.remove();
    layoutWatch?.disconnect();
    layoutWatch = null;
    if (ed.settle) host.removeEventListener("load", ed.settle, true);
    ed.unit.classList.remove("block-hidden");
    ed.unit.style.height = "";
    ed.unit.style.minHeight = "";
    if (ed.ghost) ed.unit.remove();
    if (edit === ed) edit = null;
  }

  /** Write the overlay's text back into the block's lines. */
  function onInput() {
    if (!edit) return;
    const { ta, kind, meta } = edit;
    const text = add(kind, meta, ta.value);
    const lines = (body() || "").split("\n");
    const blockLines = text === "" ? [""] : text.split("\n");
    // A block being started on a blank line: it needs blank lines around it, or
    // the text would simply continue the paragraph it was written under — or
    // swallow the one below — and the new block would not be new at all.
    if (edit.ghost && text.trim()) {
      edit.start = openRoom(lines, edit.start);
      edit.end = edit.start + 1;
    }
    const { start, end } = edit;
    const next = [...lines.slice(0, start), ...blockLines, ...lines.slice(end)].join("\n");
    // Where the caret is in the new body: the overlay's line, plus what the
    // marker we stripped off put back in front of it.
    const before = ta.value.slice(0, ta.selectionStart);
    const li = nl(before, before.length);
    const col = before.length - (before.lastIndexOf("\n") + 1);
    const pos = offsetIn(next, start + li, col + prefixLen(kind, meta, li));
    edit.end = start + blockLines.length;
    commit(next, true);
    onCaret?.(pos);
    grow();
  }

  function syncCaret() {
    if (!edit) return;
    const { ta, kind, meta, start } = edit;
    const before = ta.value.slice(0, ta.selectionStart);
    const li = nl(before, before.length);
    const col = before.length - (before.lastIndexOf("\n") + 1);
    onCaret?.(offsetIn(body() || "", start + li, col + prefixLen(kind, meta, li)));
  }

  /** Commit what is in the overlay and put the page back to rendered form. */
  function commitNow() {
    if (!edit) return;
    const ed = edit;
    close(ed);
    render();
  }

  function revert() {
    if (!edit) return;
    const ed = edit;
    ed.ta.value = ed.orig;
    onInput();
    close(ed);
    render();
    openAtLine(ed.start, 0);
  }

  /* ---- keys ---- */

  function onKey(e) {
    if (!edit) return;
    if (appKey?.(e)) return; // slash menu, link picker, palette
    const ta = edit.ta;
    const mod = e.metaKey || e.ctrlKey;

    if (mod && !e.shiftKey) {
      const k = e.key.toLowerCase();
      if (k === "b" || k === "i" || k === "`" || k === "k") {
        e.preventDefault();
        wrap(ta, k);
        return;
      }
    }

    if (e.key === "Escape") {
      e.preventDefault();
      revert();
      return;
    }

    if (e.key === "Tab") {
      e.preventDefault();
      indent(ta, e.shiftKey);
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      split();
      return;
    }

    if (e.key === "Backspace" && ta.selectionStart === 0 && ta.selectionEnd === 0) {
      e.preventDefault();
      mergeUp();
      return;
    }

    // Walking off the top or bottom line of a block goes to the neighbour, the
    // way the arrow keys move between Notion blocks. Shift extends the range.
    if (e.key === "ArrowUp" && !ta.value.slice(0, ta.selectionStart).includes("\n")) {
      e.preventDefault();
      if (e.shiftKey) extend(-1);
      else leave(-1);
      return;
    }

    if (e.key === "ArrowDown" && !ta.value.slice(ta.selectionStart).includes("\n")) {
      e.preventDefault();
      if (e.shiftKey) extend(1);
      else leave(1);
      return;
    }
  }

  /** ⌘B / ⌘I / ⌘` / ⌘K around the selection, in markdown. */
  function wrap(ta, kind) {
    const pairs = { b: ["**", "**"], i: ["*", "*"], "`": ["`", "`"], k: ["[", "](url)"] };
    const [open, close] = pairs[kind];
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const sel = ta.value.slice(s, e);
    const text = open + sel + close;
    ta.setRangeText(text, s, e, "end");
    if (!sel) ta.setSelectionRange(s + open.length, s + open.length);
    else if (kind === "k") ta.setSelectionRange(s + open.length + sel.length + 2, s + open.length + sel.length + 6);
    onInput();
  }

  function indent(ta, out) {
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    const value = ta.value;
    const lineStart = value.lastIndexOf("\n", s - 1) + 1;
    const lineEnd = value.indexOf("\n", e);
    const stop = lineEnd < 0 ? value.length : lineEnd;
    const chunk = value.slice(lineStart, stop);
    const lines = chunk.split("\n").map((l) => (out ? l.replace(/^ {1,2}/, "") : "  " + l));
    const next = lines.join("\n");
    ta.setRangeText(next, lineStart, stop, "end");
    ta.setSelectionRange(s + (out ? -Math.min(2, s - lineStart) : 2), Math.max(lineStart, s) + (next.length - chunk.length));
    onInput();
  }

  /** Enter: end this block and start the next one, Notion-style. */
  function split() {
    if (!edit) return;
    const { ta, kind, meta, start, end } = edit;
    const caretPos = ta.selectionStart;
    const text = ta.value;
    const before = text.slice(0, caretPos);
    const after = text.slice(caretPos);

    if (kind === "code" || kind === "events") {
      ta.setRangeText("\n", caretPos, caretPos, "end");
      onInput();
      return;
    }
    // Enter on an empty block breaks out of whatever it is in: an empty list
    // item becomes a paragraph, so the list ends where the user says it does.
    if (!before && !after) {
      if (kind === "li" || /^h[1-6]$/.test(kind) || kind === "quote" || kind === "callout") {
        unlist(start, end);
      }
      return;
    }

    const next = nextMarker(kind, meta, after, !before.trim());
    const a = add(kind, meta, before);
    const b = next ? add(next.kind, next.meta, after) : "";
    const blockLines = [...(a === "" ? [""] : a.split("\n")), ...(b === "" ? [""] : b.split("\n"))];
    const lines = (body() || "").split("\n");
    const out = [...lines.slice(0, start), ...blockLines, ...lines.slice(end)].join("\n");
    const newLine = start + (a === "" ? 1 : a.split("\n").length);
    close(edit);
    commit(out, true);
    render();
    openAtLine(newLine, 0);
  }

  /** Turn a block into a plain paragraph, marker and all. */
  function unlist(start, end) {
    const lines = (body() || "").split("\n");
    const raw = lines.slice(start, end).join("\n");
    const kind = edit?.kind;
    const text = edit ? edit.ta.value : strip(kind || "p", raw).text;
    const out = [...lines.slice(0, start), ...text.split("\n"), ...lines.slice(end)].join("\n");
    const ed = edit;
    if (ed) close(ed);
    commit(out, true);
    render();
    openAtLine(start, 0);
  }

  /** Backspace at the very start: join this block onto the one above. */
  function mergeUp() {
    if (!edit) return;
    const { kind, meta, start, end, ta } = edit;
    const lines = (body() || "").split("\n");
    const emptyText = add(kind, meta, ta.value) === "";
    if (start === 0 && emptyText) return; // nothing above to join

    // An empty bullet loses its bullet: there is nothing to merge, and the
    // user is backing out of the list.
    if (kind === "li" && !ta.value.trim()) {
      unlist(start, end);
      return;
    }

    // A list item or heading whose neighbour is not the same kind of block
    // loses its marker first: Backspace backs out of the structure.
    if (!emptyText) {
      const prev = previousLine(lines, start);
      const prevRaw = prev == null ? "" : lines[prev];
      const prevIsItem = LIST_LINE.test(prevRaw);
      if ((kind === "li" && !prevIsItem) || (/^h[1-6]$/.test(kind) && prevRaw.trim())) {
        unlist(start, end);
        return;
      }
    }

    if (start === 0) {
      // first block: strip its marker instead of merging
      edit.meta = { ...meta, marker: "", indent: "", box: "" };
      if (kind !== "p" && kind !== "bookmark") {
        ta.dispatchEvent(new Event("input"));
      }
      return;
    }
    // Find the previous non-empty line and append to it.
    let prev = start - 1;
    while (prev > 0 && !lines[prev].trim()) prev--;
    const merged = lines[prev].replace(/\s+$/, "") + (ta.value ? " " + ta.value : "");
    const col = lines[prev].replace(/\s+$/, "").length + 1;
    if (emptyText) {
      const out = [...lines.slice(0, prev + 1), ...lines.slice(end)].join("\n");
      close(edit);
      commit(out, true);
      render();
      openAtLine(prev, col);
      return;
    }
    const out = [...lines.slice(0, prev), merged, ...lines.slice(end)].join("\n");
    close(edit);
    commit(out, true);
    render();
    openAtLine(prev, col);
  }

  /** Arrow keys at the edges walk to the neighbouring block, skipping blank
   *  separator lines — those are spacing, not something to land in. */
  function leave(dir) {
    if (!edit) return;
    const lines = (body() || "").split("\n");
    let line = dir < 0 ? edit.start - 1 : edit.end;
    while (line >= 0 && line < lines.length && !lines[line].trim()) line += dir;
    if (line < 0) line = 0;
    if (line >= lines.length) line = lines.length - 1;
    const ed = edit;
    close(ed);
    render();
    if (!openAtLine(line, dir < 0 ? Infinity : 0)) openAtLine(dir < 0 ? 0 : line, 0);
  }

  function onBlur() {
    if (!edit) return;
    // A click on another block is handled by mousedown (which commits first);
    // here the page is simply left, so commit and go back to rendered form.
    const ed = edit;
    setTimeout(() => {
      if (edit !== ed) return;
      close(ed);
      render();
    }, 0);
  }

  /* ---- opening a block by line ---- */

  /** Open an edit at (line, col) in the source, creating a paragraph if needed. */
  function openAtLine(line, col = 0, point = null) {
    if (!editable?.()) return false;
    const text = body() || "";
    const total = text.split("\n").length;
    if (line < 0) line = 0;
    if (line >= total) line = total - 1;
    const raw = text.split("\n");
    if (line < 0) return false;

    // A unit that covers this line, preferring the innermost (list items).
    let unit = null;
    for (const child of host.children) {
      if (!child.dataset.line || child.dataset.end == null) continue;
      const s = Number(child.dataset.line);
      const e = Number(child.dataset.end);
      if (line < s || line >= e) continue;
      unit = child;
      const inner = child.matches("[data-unit]")
        ? child
        : [...(child.querySelectorAll?.("[data-unit]") || [])].find(
            (u) => line >= Number(u.dataset.line) && line < Number(u.dataset.end)
          );
      if (inner) unit = inner;
      break;
    }

    if (!unit) {
      if (raw[line] !== undefined && raw[line].trim()) return false; // not editable (table, media...)
      unit = ghostAt(line);
      if (!unit) return false;
      startEdit(unit, Math.max(0, col), point);
      return true;
    }

    const kind = unit.dataset.kind;
    if (kind && !RAW.has(kind) && !/^h[1-6]$/.test(kind) && !["li", "quote", "callout", "code", "events"].includes(kind)) {
      return false; // tables, media, dividers: not text
    }
    const { meta } = strip(kind === "list" ? "p" : kind, raw.slice(Number(unit.dataset.line), Number(unit.dataset.end)).join("\n"));
    const idx = line - Number(unit.dataset.line);
    const off = line > 0 ? 0 : Math.max(0, col - prefixLen(kind, meta, idx));
    startEdit(unit, idx === 0 ? off : null, point);
    return true;
  }

  /**
   * Where a new block can be written at `line`: the last blank line of the run,
   * with a blank line above it. A paragraph is a run of non-blank lines, so a
   * line written straight under one joins it — and a block that joins the block
   * above is not a block.
   */
  function openRoom(lines, line) {
    const blank = (i) => lines[i] !== undefined && !lines[i].trim();
    while (blank(line + 1)) line++;
    if (line > 0 && isProse(lines[line - 1] || "")) {
      lines.splice(line, 0, "");
      line++;
    }
    if (isProse(lines[line + 1] || "")) lines.splice(line + 1, 0, "");
    return line;
  }

  /** A blank line has no element; make a stand-in so there is something to type in. */
  function ghostAt(line) {
    let anchor = null;
    for (const child of host.children) {
      if (child.dataset.end == null) continue;
      if (Number(child.dataset.line) <= line) anchor = child;
      else break;
    }
    const ghost = document.createElement("p");
    ghost.className = "block-ghost";
    ghost.dataset.line = String(line);
    ghost.dataset.end = String(line + 1);
    ghost.dataset.kind = "p";
    ghost.dataset.ghost = "1";
    ghost.textContent = "\u200b";
    if (anchor) anchor.parentElement.insertBefore(ghost, anchor.nextSibling);
    else host.insertBefore(ghost, host.firstChild);
    return ghost;
  }

  /**
   * Re-render and put the caret back where the model says it is. With nothing
   * open this is a no-op unless the caller knows the view is stale — the table
   * cells, for instance, repaint themselves and must not lose their node.
   */
  function refresh(force = false) {
    if (!edit && !force) return false;
    if (sel && !edit) sel = null;
    const ta = opts.mirror?.();
    const pos = ta ? ta.selectionStart : 0;
    const wasEditing = !!edit;
    if (edit) close(edit);
    render();
    if (!wasEditing) return false;
    const text = body() || "";
    let line = 0;
    let n = 0;
    for (let i = 0; i < pos && i < text.length; i++) {
      if (text.charCodeAt(i) === 10) {
        line++;
        n = i + 1;
      }
    }
    return openAtLine(line, pos - n);
  }

  /* ---- block selection ---- */

  // Selection is a range of source lines, not of DOM nodes, so it survives a
  // re-render and matches exactly what would be deleted from the file.
  let sel = null; // { from, to }
  let selAnchor = null; // the block a shift-click range grows from
  let lastRange = null; // the last block the pointer was in

  const tops = () => [...host.children].filter((c) => c.dataset.end != null);
  const range = (el) => ({ from: Number(el.dataset.line), to: Number(el.dataset.end) });

  function paint() {
    for (const child of tops()) {
      if (!sel) {
        child.classList.remove("block-selected");
        continue;
      }
      const r = range(child);
      child.classList.toggle("block-selected", r.from < sel.to && r.to > sel.from);
    }
  }

  function selectBlocks(a, b) {
    sel = { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
    paint();
  }

  function clearSelection() {
    if (!sel) return;
    sel = null;
    selAnchor = null;
    paint();
  }

  /** Turn the current block plus its neighbour into a selection. */
  function extend(dir) {
    if (!edit) return;
    const list = tops();
    const here = range(edit.unit);
    const neighbour = list[list.indexOf(edit.unit) + dir];
    const next = neighbour ? range(neighbour) : null;
    const ed = edit;
    close(ed);
    render();
    if (!next) {
      openAtLine(dir < 0 ? here.from : here.to, 0);
      return;
    }
    selAnchor = here;
    selectBlocks(here, next);
  }

  /** Replace the selected source lines, then edit where the change landed. */
  function spliceSelection(replacement) {
    if (!sel) return;
    const { from, to } = sel;
    const lines = (body() || "").split("\n");
    const block = String(replacement).split("\n");
    const out = [...lines.slice(0, from), ...block, ...lines.slice(to)];
    sel = null;
    commit(out.join("\n"), true);
    render();
    paint();
    openAtLine(from + block.length - 1, block[block.length - 1].length);
  }

  const deleteSelection = () => spliceSelection("");

  /** Move the far edge of the block selection, the way shift+arrow moves the
   *  far end of a text selection. The anchor stays where the range started. */
  function growSel(dir) {
    const list = tops();
    const farDown = !selAnchor || selAnchor.from <= sel.from; // focus at the bottom?
    const growBottom = () => {
      const next = list.find((el) => Number(el.dataset.line) >= sel.to);
      if (next) sel = { from: sel.from, to: Number(next.dataset.end) };
      return !!next;
    };
    const shrinkBottom = () => {
      const last = [...list].reverse().find((el) => Number(el.dataset.end) >= sel.to && Number(el.dataset.line) < sel.to);
      if (last) sel = { from: sel.from, to: Number(last.dataset.line) };
      return !!last;
    };
    const growTop = () => {
      const prev = [...list].reverse().find((el) => Number(el.dataset.end) <= sel.from);
      if (prev) sel = { from: Number(prev.dataset.line), to: sel.to };
      return !!prev;
    };
    const shrinkTop = () => {
      const first = list.find((el) => Number(el.dataset.line) <= sel.from && Number(el.dataset.end) > sel.from);
      if (first) sel = { from: Number(first.dataset.end), to: sel.to };
      return !!first;
    };
    const moved = dir > 0 ? (farDown ? growBottom() : shrinkTop()) : farDown ? shrinkBottom() : growTop();
    if (!moved) return;
    if (sel.from >= sel.to) {
      clearSelection();
      return;
    }
    paint();
  }

  /** A selection is a text selection at the block level: typing replaces it. */
  function onDocKey(e) {
    if (!sel) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      if (e.shiftKey) {
        growSel(dir);
        return;
      }
      const covered = tops().filter((el) => {
        const r = range(el);
        return r.from < sel.to && r.to > sel.from;
      });
      const target = dir > 0 ? covered[covered.length - 1] : covered[0];
      clearSelection();
      if (target) openAtLine(Number(target.dataset.line), dir > 0 ? 0 : Infinity);
      return;
    }
    if (e.metaKey || e.ctrlKey) return;
    if (e.key === "Escape") {
      e.preventDefault();
      clearSelection();
      return;
    }
    if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      deleteSelection();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      spliceSelection("");
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      spliceSelection(e.key);
    }
  }
  document.addEventListener("keydown", onDocKey, true);

  /* ---- pointer ---- */

  let press = null; // a pointer press that may turn into a drag selection

  host.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      if (edit && edit.ta.contains(e.target)) return; // typing surface: native

      // Shift-click picks whole blocks — Notion's way of marking several lines
      // at once, and the only way to act on a run of blocks.
      if (e.shiftKey) {
        const target = unitOf(e.target);
        if (target) {
          e.preventDefault();
          const anchor = selAnchor || (edit ? range(edit.unit) : lastRange) || range(target);
          if (edit) {
            const ed = edit;
            close(ed);
            render();
          }
          selAnchor = anchor;
          lastRange = range(target);
          selectBlocks(anchor, range(target));
          return;
        }
      }

      // Resolve the pressed block before the DOM is replaced, then stay out of
      // the way: opening the editor happens on click, so a drag can select
      // blocks instead of dropping a caret.
      const unit = unitOf(e.target);
      press = unit ? { line: Number(unit.dataset.line), from: range(unit), x: e.clientX, y: e.clientY, moved: false } : null;
      if (sel) clearSelection();
      if (edit) {
        const ed = edit;
        close(ed);
        render();
        e.preventDefault();
      }
    },
    true
  );

  // Dragging across block boundaries selects the blocks it covers.
  host.addEventListener("mousemove", (e) => {
    if (!press || !(e.buttons & 1) || !editable?.()) return;
    if (!press.moved && Math.abs(e.clientX - press.x) + Math.abs(e.clientY - press.y) < 8) return;
    const over = unitOf(e.target);
    if (!over) return;
    const r = range(over);
    if (!press.moved && r.from === press.from.from && r.to === press.from.to) return;
    press.moved = true;
    selAnchor = press.from;
    selectBlocks(press.from, r);
  });

  /** The source line just after the block the pointer sits under, or null when
   *  the pointer is above the first block (then it is the top of the page). */
  function lineAtPoint(y) {
    let after = 0;
    for (const el of tops()) {
      const r = el.getBoundingClientRect();
      if (y >= r.top + r.height / 2) after = Number(el.dataset.end);
    }
    return after;
  }

  /** Open a blank paragraph at a source line, making one if the line is taken.
   *  `line === null` means "the end of the page". */
  function openBlankAt(line) {
    const lines = (body() || "").split("\n");
    if (line === null || line === undefined) line = lines.length - 1;
    if (line >= lines.length || lines[line].trim()) {
      lines.splice(line, 0, "");
      commit(lines.join("\n"), true);
      render();
    }
    openAtLine(line, 0);
  }

  // The padding under the page is paper too — clicking there means "write
  // here". Above the page stays inert: a stray click in the top margin should
  // not add a blank line to the file.
  const paper = host.closest(".page") || host.parentElement;
  paper?.addEventListener("click", (e) => {
    if (e.target !== paper || !editable?.()) return;
    if (e.clientY < host.getBoundingClientRect().bottom - 4) return;
    press = null;
    if (sel) clearSelection();
    if (edit) {
      const ed = edit;
      close(ed);
      render();
    }
    openBlankAt(lineAtPoint(e.clientY));
  });

  const endPress = () => {
    setTimeout(() => {
      press = null;
    }, 0);
  };
  document.addEventListener("mouseup", endPress, true);

  /* ---- moving blocks ---- */

  // Hover a block and a six-dot handle appears in the gutter; drag it and the
  // block's source lines move. A block is a range of lines, so moving one is
  // moving those lines — nothing is re-encoded, and the file stays the file.

  const GRIP_DOTS =
    '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/>' +
    '<circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/>' +
    '<circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>';

  let grip = null;
  let gripUnit = null;
  let gripHide = 0;
  let dropLine = null;
  let drag = null; // { span, y0, moved, target }
  let lastY = 0;
  let scrollTimer = 0;

  function gripEl() {
    if (grip) return grip;
    grip = document.createElement("button");
    grip.type = "button";
    grip.className = "block-grip";
    grip.setAttribute("aria-label", "Drag to move this block");
    grip.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + GRIP_DOTS + "</svg>";
    grip.addEventListener("mousedown", (e) => {
      // Own the gesture: the host's mousedown would commit an open editor and
      // decide this was a press on a block.
      e.preventDefault();
      e.stopPropagation();
      beginDrag(e);
    });
    grip.addEventListener("mouseenter", () => clearTimeout(gripHide));
    grip.addEventListener("mouseleave", () => scheduleHide());
    document.body.appendChild(grip);
    return grip;
  }

  function placeGrip(unit) {
    const el = gripEl();
    clearTimeout(gripHide);
    gripUnit = unit;
    // Anchor to the block's first line, the way Notion's handle does.
    const r = unit.getBoundingClientRect();
    const first = unit.matches("li, p, h1, h2, h3, h4, h5, h6") ? unit : unit.querySelector("p, h1, h2, h3, h4, h5, h6, li") || unit;
    const fr = first.getBoundingClientRect();
    const lh = parseFloat(css(first, "line-height")) || 24;
    el.style.top = Math.round(fr.top + Math.min(fr.height, lh) / 2 - 11) + "px";
    // Sit outside the table's own row handle, which lives at left - 26.
    el.style.left = Math.round(Math.max(4, r.left - 50)) + "px";
    el.classList.add("on");
  }

  function hideGrip() {
    gripUnit = null;
    if (grip) grip.classList.remove("on");
  }

  function scheduleHide() {
    clearTimeout(gripHide);
    gripHide = setTimeout(hideGrip, 200);
  }

  /** The block at height `y` whose left gutter holds `x`. */
  function unitAt(y, x) {
    for (const el of tops()) {
      const r = el.getBoundingClientRect();
      if (y < r.top - 8 || y > r.bottom + 8) continue;
      return x < r.left - 2 && x > r.left - 72 ? el : null;
    }
    return null;
  }

  // Tracked document-wide, because the handle lives in the gutter — outside the
  // page's text column, where `#preview` never sees a mousemove.
  document.addEventListener("mousemove", (e) => {
    if (drag) return;
    if (e.target.closest?.(".block-grip")) return;
    const over = host.contains(e.target) ? unitOf(e.target) : null;
    if (over) {
      // A table's own handles sit at its left and top edge; the block handle
      // steps aside so a click there reaches the row or column menu. Drag a
      // table by its gutter, like any other block.
      if (over.dataset.kind === "table") return scheduleHide();
      return placeGrip(over);
    }
    // The gutter is only a gutter next to the page: over the sidebar it is the
    // sidebar.
    if (e.target.closest?.("#sidebar")) return scheduleHide();
    const unit = unitAt(e.clientY, e.clientX);
    if (!unit) return scheduleHide();
    placeGrip(unit);
  });
  // The handle is positioned in viewport coordinates, so scrolling moves the
  // block out from under it.
  document.addEventListener("scroll", () => {
    if (!drag) hideGrip();
  }, true);

  /** The lines a block owns: a list item takes its deeper-indented children. */
  function dragSpan(unit) {
    const r = range(unit);
    if (unit.dataset.kind !== "li") return r;
    const lines = (body() || "").split("\n");
    const indent = ((lines[r.from] || "").match(/^\s*/) || [""])[0].length;
    while (r.to < lines.length && /^\s+\S/.test(lines[r.to]) && (lines[r.to].match(/^\s*/) || [""])[0].length > indent) r.to++;
    return r;
  }

  function beginDrag(e) {
    if (!gripUnit) return;
    const r = dragSpan(gripUnit);
    // Dragging the handle of a block inside a selection moves the selection.
    const span = sel && sel.from <= r.from && sel.to >= r.to ? { ...sel } : r;
    if (sel) clearSelection();
    drag = { span, y0: e.clientY, moved: false, target: null };
    lastY = e.clientY;
    grip.classList.add("dragging");
    document.addEventListener("mousemove", onDragMove, true);
    document.addEventListener("mouseup", onDragUp, true);
    scrollTimer = setInterval(autoScroll, 16);
  }

  /** Where the block would land for a pointer at `y`. */
  function updateTarget(y) {
    lastY = y;
    let target = null;
    let box = null;
    for (const el of tops()) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) {
        target = Number(el.dataset.line);
        box = r;
        break;
      }
    }
    drag.target = target;
    showDropLine(box);
  }

  const scrollerOf = () => {
    for (let el = host.parentElement; el; el = el.parentElement) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
    }
    return null;
  };

  // A long page cannot be reordered with a drag that stops at the fold, so the
  // edge of the window scrolls while the pointer rests there.
  function autoScroll() {
    if (!drag) return;
    const sc = scrollerOf();
    const zone = 70;
    let dy = 0;
    if (lastY > innerHeight - zone) dy = Math.ceil((lastY - (innerHeight - zone)) / 3) + 3;
    else if (lastY < zone) dy = -Math.ceil((zone - lastY) / 3) - 3;
    if (sc && dy) {
      const was = sc.scrollTop;
      sc.scrollTop += dy;
      if (sc.scrollTop !== was && drag.moved) updateTarget(lastY);
    }
  }

  function onDragMove(e) {
    if (!drag) return;
    e.preventDefault();
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.y0) < 4) return;
      drag.moved = true;
      host.classList.add("block-dragging");
      for (const el of tops()) {
        const r = range(el);
        if (r.from === drag.span.from && r.to === drag.span.to) el.classList.add("block-dragged");
      }
    }
    updateTarget(e.clientY);
  }

  function showDropLine(box) {
    if (!dropLine) {
      dropLine = document.createElement("div");
      dropLine.className = "drop-line";
      document.body.appendChild(dropLine);
    }
    if (!box) {
      const last = tops().pop()?.getBoundingClientRect();
      if (!last) return;
      box = { left: last.left, width: last.width, top: last.bottom + 2 };
    }
    dropLine.style.left = Math.round(box.left) + "px";
    dropLine.style.top = Math.round(box.top - 2) + "px";
    dropLine.style.width = Math.round(box.width) + "px";
    dropLine.classList.add("on");
  }

  function hideDropLine() {
    if (dropLine) dropLine.classList.remove("on");
  }

  function onDragUp() {
    document.removeEventListener("mousemove", onDragMove, true);
    document.removeEventListener("mouseup", onDragUp, true);
    clearInterval(scrollTimer);
    host.classList.remove("block-dragging");
    for (const el of tops()) el.classList.remove("block-dragged");
    hideDropLine();
    grip?.classList.remove("dragging");
    const d = drag;
    drag = null;
    hideGrip();
    if (!d?.moved) return;
    if (d.target != null && d.target >= d.span.from && d.target <= d.span.to) return; // dropped on itself
    moveSpan(d.span, d.target);
  }

  /** Move a run of source lines in front of `targetLine`; null means the end. */
  function moveSpan(span, targetLine) {
    const src = body() || "";
    const lines = src.split("\n");
    const { from, to } = span;
    const moved = lines.slice(from, to);
    const rest = [...lines.slice(0, from), ...lines.slice(to)];
    let at = targetLine == null ? rest.length : targetLine - (targetLine > to ? to - from : 0);

    // Taking the block out can leave two blank lines behind at the cut; collapse
    // them, and move the landing point with them.
    let seam = from;
    while (seam > 0 && rest[seam] != null && !rest[seam - 1].trim() && !rest[seam].trim()) {
      rest.splice(seam - 1, 1);
      if (at > seam - 1) at--;
      seam--;
    }
    at = Math.max(0, Math.min(at, rest.length));

    // Blank lines at the seam are separators, not content: drop them and put
    // one back where the block lands, so a move never glues two blocks together.
    const before = rest.slice(0, at);
    const after = rest.slice(at);
    while (before.length && !before[before.length - 1].trim()) before.pop();
    while (after.length && !after[0].trim()) after.shift();
    const out = [...before];
    // Lifting the first block off the top of the page would otherwise leave a
    // blank line at line 1.
    while (out.length && !out[0].trim()) out.shift();
    if (out.length) out.push("");
    out.push(...moved);
    if (after.length) out.push("", ...after);
    let text = out.join("\n");
    if (src.endsWith("\n") && !text.endsWith("\n")) text += "\n";
    if (text === src) return;
    lastRange = null;
    commit(text, true);
    render();
  }

  function unitOf(node) {
    if (!node || !host.contains(node)) return null;
    let top = node;
    while (top && top.parentElement !== host) top = top.parentElement;
    if (!top || top.dataset.end == null) return null;
    const inner = top.matches("[data-unit]") ? top : node.closest?.("[data-unit]");
    return inner && top.contains(inner) ? inner : top;
  }

  host.addEventListener("click", (e) => {
    if (!editable?.()) return;
    if (e.target.closest(".md-code-bar, .bookmark, [data-wiki], [data-md], [data-external], [data-file], input, a, button")) return;
    const dropped = press;
    press = null;
    if (dropped?.moved) return; // the drag already selected what it covered
    if (sel) clearSelection();
    if (dropped) {
      openAtLine(dropped.line, 0, { x: dropped.x, y: dropped.y });
      return;
    }
    const unit = unitOf(e.target);
    // A click on a different block moves the edit there. Real clicks have
    // already been handled by mousedown; this covers programmatic ones.
    if (edit) {
      if (!unit || unit === edit.unit) return;
      const line = Number(unit.dataset.line);
      const ed = edit;
      close(ed);
      render();
      openAtLine(line, 0, { x: e.clientX, y: e.clientY });
      return;
    }
    if (!unit) {
      // Empty space is paper: the line you clicked is the line you write on.
      // Under the last block that grows the page; between two blocks — the gap
      // under a table, say — it opens (or makes) the line right there.
      if (e.target !== host) return;
      openBlankAt(e.clientY > 0 ? lineAtPoint(e.clientY) : null);
      return;
    }
    const kind = unit.dataset.kind;
    if (kind === "table" || kind === "media" || kind === "hr") {
      // Tables edit cell by cell (cells.js); media and dividers have no text.
      return;
    }
    lastRange = range(unit);
    startEdit(unit, null, { x: e.clientX, y: e.clientY });
    syncCaret();
  });

  return {
    refresh,
    openAtLine,
    /** Write on a blank source line, making the line if it is taken. */
    openBlank: openBlankAt,
    repaint: paint,
    reset() {
      if (edit) close(edit);
      clearSelection();
    },
    selection: () => (sel ? { ...sel } : null),
    isEditing: () => !!edit,
    /** The caret box of the overlay, for anchoring popups. */
    caretBox() {
      if (!edit) return null;
      const { ta } = edit;
      const box = host.getBoundingClientRect();
      const r = ta.getBoundingClientRect();
      const lineHeight = parseFloat(css(ta, "line-height")) || 20;
      const lines = nl(ta.value, ta.selectionStart);
      lastBox = {
        left: r.left,
        top: r.top + lines * lineHeight - host.scrollTop,
        height: lineHeight,
        width: 2,
        base: box.top,
      };
      return lastBox;
    },
    /** Text the block editor is currently holding, for debugging and tests. */
    editing() {
      if (!edit) return null;
      return { start: edit.start, end: edit.end, kind: edit.kind, text: edit.ta.value };
    },
    commitNow,
  };
}
