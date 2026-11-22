// The events block: one block, one event.
//
// An events block is a ```events fence holding one line —
// `2026-11-24 09:30 Design review`. This module owns the three fields of that
// line (day, time, description) and the block's own menu. Every action is a
// splice of source lines, so the page stays the only copy: changing the day
// rewrites the date, changing a description rewrites the text after it.
//
// A fence with several lines is still rendered as a list (older pages, or
// hand-written ones); the same controls work row by row.

import { parseEventLine } from "./markdown.js";

let api = null; // { host, source, commit, openAt, menu }

export function initEvents(hooks) {
  api = hooks;
  api.host.addEventListener("click", onClick, true);
}

/* ---------- line arithmetic ---------- */

const pad2 = (n) => String(n).padStart(2, "0");

export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function lines() {
  return (api.source() || "").replace(/\r/g, "").split("\n");
}

function write(out) {
  api.commit(out.join("\n"), { rerender: true });
}

/** The canonical text of an event: what the file says once it is an event. */
export function eventLine({ date, start, end, title }) {
  const when = start ? " " + start + (end ? "-" + end : "") : "";
  return `${date}${when} ${title}`;
}

const FENCE_RE = /^\s*(`{3,}|~{3,})\s*events\s*$/;
const CLOSE_RE = /^\s*(`{3,}|~{3,})\s*$/;

/** The fence that opens on `openLine`, as [open, close] source line numbers. */
export function fenceAt(src, openLine) {
  if (!FENCE_RE.test(src[openLine] || "")) return null;
  for (let i = openLine + 1; i < src.length; i++) {
    if (CLOSE_RE.test(src[i])) return [openLine, i];
  }
  return [openLine, src.length]; // half-typed: the fence runs to the end
}

/** The last events fence in the page, or null. */
export function lastFence(src) {
  for (let i = src.length - 1; i >= 0; i--) {
    if (FENCE_RE.test(src[i])) return fenceAt(src, i);
  }
  return null;
}

/** One event, one block: a fence holding a single line. */
export function insertBlock(src, line) {
  const last = lastFence(src);
  if (last) {
    const [open, close] = last;
    const body = src.slice(open + 1, close);
    // An empty fence is the block the user just made: fill it, do not add a
    // second one underneath.
    if (!body.some((l) => l.trim())) {
      src.splice(open + 1, body.length, line);
      return open + 1;
    }
  }
  while (src.length && !src[src.length - 1].trim()) src.pop();
  if (src.length) src.push("");
  src.push("```events");
  const at = src.length;
  src.push(line, "```");
  return at;
}

/** A new block right after the one that opens on `openLine`. */
function insertAfter(src, openLine, line) {
  const range = fenceAt(src, openLine);
  if (!range) return null;
  const at = range[1] + 1;
  src.splice(at, 0, "", "```events", line, "```");
  return at + 2;
}

/* ---------- field edits ---------- */

/** Change one field of an event, keeping everything else on the line. */
function setFields(line, patch) {
  const out = lines();
  const cur = parseEventLine(out[line]);
  if (!cur) return;
  out[line] = eventLine({ ...cur, ...patch });
  write(out);
}

/** The events fence whose body holds `line`, as its opening line number. */
function enclosingFence(src, line) {
  for (let i = Math.min(line, src.length - 1); i >= 0; i--) {
    if (!FENCE_RE.test(src[i])) continue;
    const range = fenceAt(src, i);
    return range && line > range[0] && line < range[1] ? range[0] : null;
  }
  return null;
}

/** Take the fence out, and the blank line it was separated by. */
function removeFence(out, [open, close]) {
  out.splice(open, close - open + 1);
  if ((out[open] || "").trim() === "" && (open === 0 || (out[open - 1] || "").trim() === "")) out.splice(open, 1);
  write(out);
}

function deleteLine(line) {
  const out = lines();
  if (line < 0 || line >= out.length) return;
  const open = enclosingFence(out, line);
  out.splice(line, 1);
  // One event, one block: an event with no line is a block with no reason to
  // exist, so the block goes too.
  if (open != null) {
    const range = fenceAt(out, open);
    if (range && !out.slice(range[0] + 1, range[1]).some((l) => l.trim())) return removeFence(out, range);
  }
  write(out);
}

function deleteBlock(openLine) {
  const out = lines();
  const range = fenceAt(out, openLine);
  if (range) removeFence(out, range);
}

function duplicate(line, openLine) {
  const out = lines();
  const text = (out[line] || "").trim();
  if (!text || !insertAfterInto(out, openLine, text)) return;
  write(out);
}

function insertAfterInto(out, openLine, text) {
  const at = insertAfter(out, openLine, text);
  return at != null;
}

/* ---------- the block's controls ---------- */

async function setDay(line, ev, x, y) {
  const pick = await askEvent({ date: ev.date, mode: "date", head: "Day", x, y });
  if (!pick) return;
  setFields(line, { date: pick.date });
}

async function setTime(line, ev, x, y) {
  const pick = await askEvent({ date: ev.date, start: ev.start, end: ev.end, mode: "time", head: ev.title, x, y });
  if (!pick) return;
  setFields(line, { start: pick.start, end: pick.end });
}

async function addBlock(openLine, x, y) {
  const pick = await askEvent({ date: todayISO(), mode: "full", head: "New event", x, y });
  if (!pick) return;
  const out = lines();
  const line = eventLine({ ...pick, title: "New event" });
  const at = insertAfter(out, openLine, line);
  if (at == null) return;
  write(out);
  setTimeout(() => editDescription(at, { select: true }), 60);
}

/**
 * Type over an event's description in place. Enter or clicking away writes the
 * line; Esc leaves it as it was. `select` swaps the whole text, which is what
 * a freshly added event wants.
 */
export function editDescription(line, { select = false } = {}) {
  const row = api?.host?.querySelector(`[data-ev-line="${line}"]`);
  const span = row?.querySelector(".ev-title");
  const ev = parseEventLine(lines()[line]);
  if (!span || !ev) return false;

  const box = span.getBoundingClientRect();
  const cs = getComputedStyle(span);
  const input = document.createElement("input");
  input.className = "ev-desc-edit";
  input.value = ev.title;
  input.spellcheck = false;
  Object.assign(input.style, {
    left: Math.round(box.left) + "px",
    top: Math.round(box.top) + "px",
    width: Math.round(Math.max(box.width, 140) + 8) + "px",
    height: Math.round(box.height) + "px",
    font: cs.font,
    color: cs.color,
  });
  document.body.appendChild(input);
  input.focus();
  if (select) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);

  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    input.remove();
    const next = input.value.trim();
    if (save && next && next !== ev.title) setFields(line, { title: next });
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
    e.stopPropagation();
  });
  input.addEventListener("blur", () => finish(true));
  return true;
}

function onClick(e) {
  const bar = e.target.closest?.(".md-events-more");
  const more = bar ? null : e.target.closest?.(".ev-more");
  const day = bar || more ? null : e.target.closest?.(".ev-day");
  const time = bar || more || day ? null : e.target.closest?.(".ev-time");
  const desc = bar || more || day || time ? null : e.target.closest?.(".ev-title");
  if (!bar && !more && !day && !time && !desc) return;
  e.preventDefault();
  e.stopPropagation();

  const x = e.clientX || 0;
  const y = e.clientY || 0;
  const card = e.target.closest(".md-events");
  const open = Number(card?.dataset.line);
  const n = Number(e.target.closest(".ev, .ev-bad")?.dataset.evLine);
  const line = Number.isFinite(n) ? n : -1;
  const ev = line >= 0 ? parseEventLine(lines()[line]) : null;

  if (bar) {
    api.menu(x, y, [
      { label: "Add event", icon: "plus", action: () => addBlock(open, x, y) },
      "-",
      { label: "Delete events block", icon: "trash", danger: true, action: () => deleteBlock(open) },
    ]);
    return;
  }

  if (!ev) {
    if (line >= 0) api.menu(x, y, [{ label: "Delete line", icon: "trash", danger: true, action: () => deleteLine(line) }]);
    return;
  }

  if (day) return void setDay(line, ev, x, y);
  if (time) return void setTime(line, ev, x, y);
  if (desc) return void editDescription(line);

  const items = [{ label: ev.start ? "Change time…" : "Set time…", icon: "clock", action: () => setTime(line, ev, x, y) }];
  if (ev.start) items.push({ label: "Make it all day", icon: "calendar", action: () => setFields(line, { start: "", end: "" }) });
  items.push({ label: "Change day…", icon: "calendar", action: () => setDay(line, ev, x, y) });
  items.push("-", { label: "Duplicate event", icon: "copy", action: () => duplicate(line, open) });
  items.push({ label: "Delete event", icon: "trash", danger: true, action: () => deleteLine(line) });
  api.menu(x, y, items);
}

/* ---------- date & time dialog ---------- */

/**
 * Ask for a day, a time, or both. Resolves with { date, start, end } or null.
 * An empty start means all day — the same thing the line says.
 */
export function askEvent({ date = todayISO(), start = "", end = "", mode = "full", head = "New event", x = 0, y = 0 } = {}) {
  return new Promise((resolve) => {
    const withDate = mode !== "time";
    const withTime = mode !== "date";
    const node = document.createElement("div");
    node.className = "url-pop ev-pop";
    node.dataset.opensMenu = "1";
    node.innerHTML =
      `<div class="url-head">${esc(head)}</div>` +
      (withDate ? `<input class="url-input ev-date" type="date" value="${esc(date)}" aria-label="Day">` : "") +
      (withTime
        ? `<div class="ev-times">` +
          `<input class="url-input ev-start" type="time" value="${esc(start)}" aria-label="Start time">` +
          `<span class="ev-dash">–</span>` +
          `<input class="url-input ev-end" type="time" value="${esc(end)}" aria-label="End time">` +
          `</div>` +
          `<div class="ev-hint">No time means all day.</div>`
        : "") +
      `<button class="btn primary url-add">${mode === "full" ? "Add" : "Set"}</button>`;
    document.body.appendChild(node);

    const dateIn = node.querySelector(".ev-date");
    const startIn = node.querySelector(".ev-start");
    const endIn = node.querySelector(".ev-end");

    // Open at the pointer, the way the row menus do, and stay on screen.
    const rect = node.getBoundingClientRect();
    const left = Math.max(12, Math.min(x || rect.left, window.innerWidth - rect.width - 12));
    const top = Math.max(12, Math.min(y + 26 || rect.top, window.innerHeight - rect.height - 12));
    node.style.left = Math.round(left) + "px";
    node.style.top = Math.round(top) + "px";

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener("mousedown", away, true);
      node.remove();
      resolve(value);
    };
    const submit = () => {
      const d = dateIn ? dateIn.value : date;
      const s = startIn?.value || "";
      const e = endIn?.value || "";
      if (!d) return;
      // An end without a start is meaningless: keep the range the right way up.
      finish({ date: d, start: withTime ? s : start, end: withTime && s ? e : end });
    };
    node.querySelector(".url-add").onclick = submit;
    node.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
      e.stopPropagation();
    });
    const away = (e) => {
      if (!node.contains(e.target)) finish(null);
    };
    setTimeout(() => {
      (dateIn || startIn)?.focus();
      document.addEventListener("mousedown", away, true);
    }, 0);
  });
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
