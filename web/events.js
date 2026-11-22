// The events block's own controls.
//
// An events block is a ```events fence. Its rows are lines, so everything here
// is a splice of source lines and nothing is stored anywhere else: setting a
// time rewrites one line, deleting a row removes one line, deleting the block
// removes the fence. The page is the only copy.

import { escapeHtml, parseEventLine } from "./markdown.js";

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

/**
 * Write `date [HH:MM[-HH:MM]] ` as a new line inside a fence and return the
 * line number it landed on. `openLine` picks the fence; without it the page's
 * last one is used, and one is made when the page has none.
 */
export function insertEvent(src, date, start, end, openLine = null) {
  const entry = `${date}${start ? " " + start + (end ? "-" + end : "") : ""} `;
  const range = openLine == null ? lastFence(src) : fenceAt(src, openLine);
  if (range) {
    const [open, close] = range;
    let at = close;
    while (at > open + 1 && !src[at - 1].trim()) at--;
    src.splice(at, 0, entry);
    return at;
  }
  while (src.length && !src[src.length - 1].trim()) src.pop();
  if (src.length) src.push("");
  src.push("```events");
  const at = src.length;
  src.push(entry, "```");
  return at;
}

/* ---------- actions ---------- */

async function setTime(line, ev, x, y) {
  const pick = await askEvent({ date: ev.date, start: ev.start, end: ev.end, timeOnly: true, head: ev.title, x, y });
  if (!pick) return;
  const out = lines();
  const cur = parseEventLine(out[line]);
  if (!cur) return;
  out[line] = eventLine({ ...cur, start: pick.start, end: pick.end });
  write(out);
}

function allDay(line, ev) {
  const out = lines();
  const cur = parseEventLine(out[line]);
  if (!cur) return;
  out[line] = eventLine({ ...cur, start: "", end: "" });
  write(out);
}

function deleteLine(line) {
  const out = lines();
  if (line < 0 || line >= out.length) return;
  out.splice(line, 1);
  write(out);
}

function deleteBlock(openLine) {
  const out = lines();
  const range = fenceAt(out, openLine);
  if (!range) return;
  const [open, close] = range;
  out.splice(open, close - open + 1);
  // Do not leave the blank line the block was separated by behind.
  if ((out[open] || "").trim() === "" && (open === 0 || (out[open - 1] || "").trim() === "")) out.splice(open, 1);
  write(out);
}

async function addTo(openLine, x, y) {
  const pick = await askEvent({ date: todayISO(), head: "New event", x, y });
  if (!pick) return;
  const out = lines();
  const at = insertEvent(out, pick.date, pick.start, pick.end, openLine);
  const text = out[at];
  write(out);
  // Park the caret where the title goes: the line is a date, not a sentence.
  setTimeout(() => {
    if (!api.openAt(at, text.length)) return;
    const ta = document.querySelector("textarea.block-edit");
    const pos = ta ? ta.value.indexOf(text) : -1;
    if (ta && pos >= 0) ta.setSelectionRange(pos + text.length, pos + text.length);
  }, 40);
}

/* ---------- the block's menus ---------- */

function onClick(e) {
  const bar = e.target.closest?.(".md-events-more");
  const more = bar ? null : e.target.closest?.(".ev-more");
  const time = bar || more ? null : e.target.closest?.(".ev-time");
  if (!bar && !more && !time) return;
  e.preventDefault();
  e.stopPropagation();

  const card = e.target.closest(".md-events");
  const row = e.target.closest(".ev, .ev-bad");
  const n = row ? Number(row.dataset.evLine) : NaN;
  const line = Number.isFinite(n) ? n : -1;
  const x = e.clientX || 0;
  const y = e.clientY || 0;

  if (bar) {
    const open = Number(card?.dataset.line);
    api.menu(x, y, [
      { label: "Add event…", icon: "plus", action: () => addTo(open, x, y) },
      "-",
      { label: "Delete events block", icon: "trash", danger: true, action: () => deleteBlock(open) },
    ]);
    return;
  }

  const out = lines();
  const ev = line >= 0 ? parseEventLine(out[line]) : null;
  if (!ev) {
    // A line that is not an event yet can still be taken out of the block.
    if (line >= 0) api.menu(x, y, [{ label: "Delete line", icon: "trash", danger: true, action: () => deleteLine(line) }]);
    return;
  }
  if (time) {
    setTime(line, ev, x, y);
    return;
  }
  const items = [{ label: ev.start ? "Change time…" : "Set time…", icon: "clock", action: () => setTime(line, ev, x, y) }];
  if (ev.start) items.push({ label: "Make it all day", icon: "calendar", action: () => allDay(line, ev) });
  items.push("-", { label: "Delete event", icon: "trash", danger: true, action: () => deleteLine(line) });
  api.menu(x, y, items);
}

/* ---------- date & time dialog ---------- */

/**
 * Ask for a date and an optional time. Resolves with { date, start, end } or
 * null. Empty start means all day — the same thing the line says.
 */
export function askEvent({ date = todayISO(), start = "", end = "", timeOnly = false, head = "New event", x = 0, y = 0 } = {}) {
  return new Promise((resolve) => {
    const node = document.createElement("div");
    node.className = "url-pop ev-pop";
    node.dataset.opensMenu = "1";
    node.innerHTML =
      `<div class="url-head">${escapeHtml(head)}</div>` +
      (timeOnly
        ? ""
        : `<input class="url-input ev-date" type="date" value="${escapeHtml(date)}" aria-label="Date">`) +
      `<div class="ev-times">` +
      `<input class="url-input ev-start" type="time" value="${escapeHtml(start)}" aria-label="Start time">` +
      `<span class="ev-dash">–</span>` +
      `<input class="url-input ev-end" type="time" value="${escapeHtml(end)}" aria-label="End time">` +
      `</div>` +
      `<div class="ev-hint">No time means all day.</div>` +
      `<button class="btn primary url-add">${timeOnly ? "Set" : "Add"}</button>`;
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
      const d = timeOnly ? date : dateIn?.value || "";
      const s = startIn.value || "";
      const e = endIn.value || "";
      if (!d) return;
      // An end without a start is meaningless: keep the range the right way up.
      finish({ date: d, start: s, end: s ? e : "" });
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
      (timeOnly ? startIn : dateIn)?.focus();
      document.addEventListener("mousedown", away, true);
    }, 0);
  });
}
