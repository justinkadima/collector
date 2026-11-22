// In-cell editing for rendered markdown tables.
//
// Clicking a cell swaps its rendered HTML for the raw markdown of that one
// cell and lets you type in place. Committing splices the text back into the
// page source, so the .md file stays the only copy of the data.
//
// Enter saves and drops a row, Tab saves and moves right (Shift-Tab left),
// Escape saves and puts a paragraph under the table — a table is the one block
// you cannot press Enter out of, so there has to be a way out that is not the
// mouse (Shift-Escape still throws the edit away). Clicking away saves, and
// pasting is always plain text.

let api = null;

export function initCells(hooks) {
  api = hooks;
}

/**
 * Where the cell sits in the page source: `start`/`end` bracket everything
 * between the two pipes (padding included), `raw` is that text verbatim.
 * `line` is the source line the row came from, `col` the zero-based cell.
 */
function locate(src, line, col) {
  const lines = String(src).split("\n");
  const li = Math.max(0, Math.min(line, lines.length - 1));
  let base = 0;
  for (let i = 0; i < li; i++) base += lines[i].length + 1;
  const row = lines[li] ?? "";
  const parts = row.split("|");
  const idx = col + 1; // parts[0] is whatever sits before the leading pipe
  if (idx >= parts.length) {
    const at = base + row.length;
    return { line: li, start: at, end: at, raw: "" };
  }
  let pos = 0;
  for (let i = 0; i < idx; i++) pos += parts[i].length + 1;
  const raw = parts[idx];
  return { line: li, start: base + pos, end: base + pos + raw.length, raw };
}

/** The cell's markdown text, without the padding around it. */
export function cellSpan(src, line, col) {
  const loc = locate(src, line, col);
  return { line: loc.line, start: loc.start, end: loc.end, text: loc.raw.trim() };
}

/**
 * Keep a cell's original padding when the text is replaced: `| Ada |` stays
 * `| Ada Lovelace |`, and an empty `|  |` becomes `| Todo |` rather than `|  Todo|`.
 */
function padded(raw, text) {
  const has = Boolean(raw.trim());
  const lead = has ? raw.length - raw.trimStart().length : 1;
  const trail = has ? raw.length - raw.trimEnd().length : raw.length >= 2 ? 1 : 0;
  if (!text) return raw.length >= 2 ? "  " : "";
  return raw.slice(0, lead) + text + (trail ? raw.slice(raw.length - trail) : "");
}

export function startCellEdit(td, point) {
  if (!api || !td || td.dataset.celledit === "1") return;
  const line = Number(td.dataset.line);
  const col = Number(td.dataset.col);
  if (!Number.isFinite(line) || !Number.isFinite(col)) return;
  if (!api.source()) return;

  // Only one cell may be open; a stray click never leaves two editors behind.
  const open = document.querySelector(".cell-editing");
  if (open && open !== td) finish(open, "stay");

  const span = cellSpan(api.source(), line, col);
  td.dataset.celledit = "1";
  td.classList.add("cell-editing");
  td.setAttribute("contenteditable", "plaintext-only");
  td.textContent = span.text;
  td._cell = { line, col, text: span.text, done: false };
  td.addEventListener("keydown", onKey);
  td.addEventListener("blur", onBlur);
  td.addEventListener("paste", onPaste);
  td.focus({ preventScroll: true });
  placeCaret(td, point);
  if (td.scrollIntoView) td.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function placeCaret(td, point) {
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  if (point && document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(point.x, point.y);
    if (range && td.contains(range.startContainer)) {
      sel.addRange(range);
      return;
    }
  }
  const range = document.createRange();
  range.selectNodeContents(td);
  range.collapse(false);
  sel.addRange(range);
}

function onKey(e) {
  const td = e.currentTarget;
  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    finish(td, "down");
    return;
  }
  if (e.key === "Tab") {
    e.preventDefault();
    e.stopPropagation();
    finish(td, e.shiftKey ? "left" : "right");
    return;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    finish(td, e.shiftKey ? "revert" : "under");
  }
}

function onBlur(e) {
  finish(e.currentTarget, "stay");
}

function onPaste(e) {
  e.preventDefault();
  insertPlain((e.clipboardData?.getData("text") || "").replace(/\s*\n+\s*/g, " "));
}

function insertPlain(text) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  sel.deleteFromDocument();
  const node = document.createTextNode(text);
  sel.getRangeAt(0).insertNode(node);
  sel.collapse(node, node.length);
}

/** Write the cell's text back into the source, then re-render just that cell. */
function finish(td, mode) {
  const st = td._cell;
  if (!st || st.done) return;
  st.done = true;
  td.removeEventListener("keydown", onKey);
  td.removeEventListener("blur", onBlur);
  td.removeEventListener("paste", onPaste);
  const text = mode === "revert" ? st.text : clean(td.textContent);
  // A watcher refresh may have replaced the table under us; do not splice a
  // detached cell into the (possibly reloaded) source.
  if (td.isConnected && mode !== "revert" && text !== st.text) {
    const src = api.source();
    const loc = locate(src, st.line, st.col);
    const next = src.slice(0, loc.start) + padded(loc.raw, text) + src.slice(loc.end);
    if (next !== src) api.commit(next);
  }
  // Taking contenteditable off a focused cell moves focus to the body; when a
  // cell is next in line, hand focus over first and only then put this one back.
  const restore = () => {
    delete td.dataset.celledit;
    td.removeAttribute("contenteditable");
    td.classList.remove("cell-editing");
    td.innerHTML = api.render(text);
  };
  if (mode === "under") {
    // Out of the table: the line under it, made if need be.
    const blk = tableBlock(api.source(), st.line);
    restore();
    api.under?.(blk ? blk.end + 1 : st.line + 1);
    return;
  }
  const dir = { down: [1, 0], right: [0, 1], left: [0, -1] }[mode];
  if (dir && focusNeighbour(td, dir[0], dir[1], mode === "right")) setTimeout(restore, 0);
  else restore();
}

function clean(value) {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

/** Move to the cell `dr` rows and `dc` columns away. True if there was one. */
function focusNeighbour(td, dr, dc, wrap) {
  const tr = td.parentElement;
  if (!tr) return false;
  const col = Number(td.dataset.col);
  let target = null;
  if (dr) {
    const row = tr.nextElementSibling;
    target = row ? row.children[col] || null : null;
  } else if (dc) {
    target = tr.children[col + dc] || null;
    if (!target && wrap) {
      const row = tr.nextElementSibling;
      target = row ? row.children[0] || null : null;
    }
  }
  if (!target) return false;
  startCellEdit(target);
  return true;
}

/* ------------------------------------------------------------ table menu */

/**
 * The table block a line belongs to: contiguous lines containing a pipe.
 * `start` is the header, `start + 1` the alignment row, `end` the last row.
 */
function tableBlock(src, line) {
  const lines = String(src).split("\n");
  const isRow = (l) => l != null && l.includes("|") && l.trim() !== "";
  if (!isRow(lines[line])) return null;
  let start = line;
  while (start > 0 && isRow(lines[start - 1])) start--;
  let end = line;
  while (end + 1 < lines.length && isRow(lines[end + 1])) end++;
  if (end - start < 1) return null; // needs at least a header and an alignment row
  let cols = 1;
  for (let i = start; i <= end; i++) cols = Math.max(cols, countCells(lines[i]));
  return { lines, start, end, sep: start + 1, cols };
}

function countCells(row) {
  let s = row.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").length;
}

function blankRow(cols) {
  return "|" + Array.from({ length: cols }, () => "  ").join("|") + "|";
}

/** Apply `fn(lines)` to the block, then rebuild the whole body. */
function rewrite(src, line, fn) {
  const blk = tableBlock(src, line);
  if (!blk) return null;
  const rows = blk.lines.slice();
  const out = fn(rows, blk);
  return Array.isArray(out) ? out.join("\n") : null;
}

function editTable(line, fn) {
  const src = api.source();
  const next = rewrite(src, line, fn);
  if (!next || next === src) return;
  api.commit(next);
  api.refresh?.();
}

function addColumn(line, col, where) {
  editTable(line, (rows, blk) => {
    const at = col + (where === "right" ? 2 : 1);
    for (let i = blk.start; i <= blk.end; i++) {
      const parts = rows[i].split("|");
      if (at > parts.length - 1) continue;
      parts.splice(at, 0, i === blk.sep ? " --- " : "  ");
      rows[i] = parts.join("|");
    }
    return rows;
  });
}

function removeColumn(line, col) {
  editTable(line, (rows, blk) => {
    if (blk.cols <= 1) return null;
    const at = col + 1;
    for (let i = blk.start; i <= blk.end; i++) {
      const parts = rows[i].split("|");
      if (at > parts.length - 2) continue;
      parts.splice(at, 1);
      rows[i] = parts.join("|");
    }
    return rows;
  });
}

function clearColumn(line, col) {
  editTable(line, (rows, blk) => {
    const at = col + 1;
    for (let i = blk.start; i <= blk.end; i++) {
      if (i === blk.sep) continue;
      const parts = rows[i].split("|");
      if (at > parts.length - 2) continue;
      parts[at] = "  ";
      rows[i] = parts.join("|");
    }
    return rows;
  });
}

/** Right-click on a body cell, or the row handle, opens the row menu. */
export function openRowMenu(cell, point) {
  if (!api || !api.menu || !cell) return;
  const line = Number(cell.dataset.line);
  const col = Number(cell.dataset.col);
  if (!Number.isFinite(line) || !Number.isFinite(col)) return;
  const blk = tableBlock(api.source(), line);
  if (!blk) return;
  if (line === blk.start) return openColMenu(cell, point); // the header is a column
  const items = [
    {
      label: "Insert row above",
      icon: "arrow-up",
      action: () => editTable(line, (rows) => (rows.splice(line, 0, blankRow(blk.cols)), rows)),
    },
    {
      label: "Insert row below",
      icon: "arrow-down",
      action: () => editTable(line, (rows) => (rows.splice(line + 1, 0, blankRow(blk.cols)), rows)),
    },
    {
      label: "Duplicate row",
      icon: "copy",
      action: () => editTable(line, (rows) => (rows.splice(line + 1, 0, rows[line]), rows)),
    },
    "-",
    {
      label: "Clear contents",
      icon: "x",
      action: () => editTable(line, (rows) => ((rows[line] = blankRow(blk.cols)), rows)),
    },
    "-",
    {
      label: "Delete row",
      icon: "trash",
      action: () => editTable(line, (rows) => (rows.splice(line, 1), rows)),
    },
  ];
  api.menu(point.x, point.y, items);
}

/** Right-click on a header cell, or the column handle, opens the column menu. */
export function openColMenu(cell, point) {
  if (!api || !api.menu || !cell) return;
  const line = Number(cell.dataset.line);
  const col = Number(cell.dataset.col);
  if (!Number.isFinite(line) || !Number.isFinite(col)) return;
  const blk = tableBlock(api.source(), line);
  if (!blk) return;
  const items = [
    { label: "Insert column left", icon: "arrow-left", action: () => addColumn(line, col, "left") },
    { label: "Insert column right", icon: "arrow-right", action: () => addColumn(line, col, "right") },
    "-",
    { label: "Clear contents", icon: "x", action: () => clearColumn(line, col) },
  ];
  if (blk.cols > 1) {
    items.push("-", { label: "Delete column", icon: "trash", action: () => removeColumn(line, col) });
  }
  api.menu(point.x, point.y, items);
}

export function openCellMenu(cell, point) {
  if (!cell) return;
  if (cell.tagName === "TH") openColMenu(cell, point);
  else openRowMenu(cell, point);
}

/* ------------------------------------------------------- row/column grips */

// An ellipsis, not a grip: it opens a menu. The six-dot grid in the gutter is
// the block handle, and it drags.
const ROW_DOTS =
  '<circle cx="6" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18" cy="12" r="1.7"/>';

const grips = { row: { el: null, cell: null } };
let hideTimer = 0;

function ensureGrip(kind) {
  const g = grips[kind];
  if (g.el) return g.el;
  const el = document.createElement("button");
  el.type = "button";
  el.className = "md-grip md-grip-" + kind;
  el.dataset.opensMenu = "1";
  el.setAttribute("aria-label", "Row actions");
  el.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + ROW_DOTS + "</svg>";
  el.addEventListener("mousedown", (e) => e.preventDefault());
  el.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  el.addEventListener("mouseleave", scheduleGripHide);
  el.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const cell = g.cell;
    if (!cell) return;
    const rect = el.getBoundingClientRect();
    // The header row is a column: its handle opens the column menu, which is
    // what `openRowMenu` already does for a `th`.
    openRowMenu(cell, { x: rect.left, y: rect.bottom + 4 });
  });
  document.body.appendChild(el);
  g.el = el;
  return el;
}

function hideGrip(kind) {
  const g = grips[kind];
  g.cell = null;
  if (g.el) g.el.classList.remove("on");
}

function placeGrip(kind, cell) {
  if (!cell || cell.isContentEditable) return;
  const el = ensureGrip(kind);
  clearTimeout(hideTimer);
  grips[kind].cell = cell;
  const row = cell.parentElement?.getBoundingClientRect();
  if (!row) return hideGrip(kind);
  el.style.top = Math.round(row.top + row.height / 2 - 11) + "px";
  el.style.left = Math.round(Math.max(6, row.left - 26)) + "px";
  el.classList.add("on");
  for (const other in grips) if (other !== kind) hideGrip(other);
}

export function showRowGrip(cell) {
  placeGrip("row", cell);
}

export function hideRowGrip() {
  clearTimeout(hideTimer);
  hideGrip("row");
}

/** Hide the handle, but give the pointer time to travel over to it. */
export function scheduleGripHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => hideGrip("row"), 180);
}
