// The calendar is a view over every page in the vault, not a store of its own.
// An event is one line inside an ```events fence in some page, and this panel
// is what that line looks like from a month away — so adding an event here is
// writing a line into a file, and nothing can drift out of sync.

import { api } from "./api.js";
import { icon } from "./icons.js";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const monthFmt = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const shortDayFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short" });

/* ------------------------------------------------------------ date helpers */

const iso = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const fromISO = (s) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};

const startOfMonth = (d) => new Date(d.getFullYear(), d.getMonth(), 1);
const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);

/** Monday of the week containing d — the app is not American. */
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  x.setDate(x.getDate() - dow);
  return x;
}

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/* ------------------------------------------------------------------- state */

const state = {
  open: false,
  month: startOfMonth(new Date()),
  selected: iso(new Date()),
  events: [],
  byDay: new Map(),
  loading: false,
  seq: 0,
  error: "",
};

let hooks = { open: null, add: null };
let root = null; // #calendar

/* ---------------------------------------------------------------- fetching */

function gridRange(month) {
  const from = mondayOf(month);
  return { from, to: addDays(from, 41) }; // six weeks, always
}

function group(events) {
  const map = new Map();
  for (const ev of events) {
    if (!map.has(ev.date)) map.set(ev.date, []);
    map.get(ev.date).push(ev);
  }
  return map;
}

async function load() {
  const { from, to } = gridRange(state.month);
  const seq = ++state.seq;
  state.loading = true;
  try {
    const data = await api(`/api/agenda?from=${iso(from)}&to=${iso(to)}`);
    if (seq !== state.seq) return;
    state.events = data.events || [];
    state.byDay = group(state.events);
    state.error = "";
  } catch (err) {
    if (seq !== state.seq) return;
    state.events = [];
    state.byDay = new Map();
    state.error = err.message || "Could not read the calendar";
  } finally {
    if (seq === state.seq) {
      state.loading = false;
      paint();
    }
  }
}

/* ------------------------------------------------------------------ render */

function paint() {
  if (!root || state.open === false) return;
  root.querySelector("#calendar-month").textContent = monthFmt.format(state.month);
  paintGrid();
  paintDay();
}

function paintGrid() {
  const grid = root.querySelector("#calendar-grid");
  const today = iso(new Date());
  const monthIdx = state.month.getMonth();
  const first = mondayOf(state.month);
  let html = "";
  for (let i = 0; i < 42; i++) {
    const d = addDays(first, i);
    const key = iso(d);
    const events = state.byDay.get(key) || [];
    const cls = ["cal-cell"];
    if (d.getMonth() !== monthIdx) cls.push("other");
    if (key === today) cls.push("today");
    if (key === state.selected) cls.push("sel");
    if (events.length) cls.push("has");
    const dots = events.slice(0, 3).map((ev) => `<i data-kind="${ev.start ? "timed" : "all"}"></i>`).join("");
    const more = events.length > 3 ? `<u>+${events.length - 3}</u>` : "";
    html +=
      `<button class="${cls.join(" ")}" data-date="${key}" title="${events.length ? events.length + " event" + (events.length > 1 ? "s" : "") : ""}">` +
      `<span class="cal-num">${d.getDate()}</span>` +
      `<span class="cal-dots">${dots}${more}</span>` +
      `</button>`;
  }
  grid.innerHTML = html;
}

function paintDay() {
  const head = root.querySelector("#calendar-day-title");
  const list = root.querySelector("#calendar-list");
  const events = state.byDay.get(state.selected) || [];
  head.textContent = dayFmt.format(fromISO(state.selected));
  if (!events.length) {
    list.innerHTML = `<div class="cal-empty">${
      state.loading ? "Loading…" : state.error ? state.error : "Nothing on this day."
    }</div>`;
    return;
  }
  list.innerHTML = events
    .map((ev) => {
      const when = ev.start ? ev.start + (ev.end ? "–" + ev.end : "") : "all day";
      const where = ev.page && ev.page !== "—" ? ev.page : "";
      return (
        `<button class="cal-ev" data-path="${esc(ev.path)}" data-line="${ev.line}">` +
        `<span class="cal-ev-time${ev.start ? "" : " all"}">${when}</span>` +
        `<span class="cal-ev-body">` +
        `<span class="cal-ev-title">${esc(ev.title)}</span>` +
        (where
          ? `<span class="cal-ev-page">${ev.icon ? `<span class="cal-ev-icon">${esc(ev.icon)}</span>` : ""}${esc(where)}</span>`
          : "") +
        `</span></button>`
      );
    })
    .join("");
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/* -------------------------------------------------------------- behaviour */

function select(dateStr, { reveal = false } = {}) {
  state.selected = dateStr;
  const d = fromISO(dateStr);
  if (d.getMonth() !== state.month.getMonth() || d.getFullYear() !== state.month.getFullYear()) {
    state.month = startOfMonth(d);
    if (reveal) load();
  }
  paint();
}

function step(delta) {
  state.month = addMonths(state.month, delta);
  load();
}

function bind() {
  root.addEventListener("click", (e) => {
    const nav = e.target.closest("[data-nav]");
    if (nav) return step(Number(nav.dataset.nav));
    if (e.target.closest("#calendar-today")) {
      select(iso(new Date()));
      state.month = startOfMonth(new Date());
      return load();
    }
    if (e.target.closest("#calendar-close")) return close();
    const cell = e.target.closest(".cal-cell");
    if (cell) return select(cell.dataset.date, { reveal: true });
    const ev = e.target.closest(".cal-ev");
    if (ev) return hooks.open?.(ev.dataset.path, Number(ev.dataset.line));
    if (e.target.closest("#calendar-add")) return hooks.add?.(state.selected);
  });
}

/* -------------------------------------------------------------------- API */

export function initCalendar(opts) {
  hooks = { ...hooks, ...opts };
  root = document.getElementById("calendar");
  if (!root) return;
  root.innerHTML =
    `<div class="cal-head">` +
    `<button class="icon-btn" data-nav="-1" title="Previous month">${icon("arrow-left")}</button>` +
    `<span id="calendar-month" class="cal-month"></span>` +
    `<button class="icon-btn" data-nav="1" title="Next month">${icon("arrow-right")}</button>` +
    `<span class="spacer"></span>` +
    `<button class="cal-today" id="calendar-today">Today</button>` +
    `<button class="icon-btn" id="calendar-close" title="Close calendar">${icon("x")}</button>` +
    `</div>` +
    `<div id="calendar-body">` +
    `<div class="cal-week">${WEEKDAYS.map((d) => `<span>${d}</span>`).join("")}</div>` +
    `<div class="cal-grid" id="calendar-grid"></div>` +
    `<div class="cal-day">` +
    `<div class="cal-day-head"><span id="calendar-day-title"></span>` +
    `<button class="cal-add" id="calendar-add" title="Add an event on this day">${icon("plus")}</button></div>` +
    `<div class="cal-list" id="calendar-list"></div>` +
    `</div></div>`;
  bind();
  // The panel is a place you leave open for the day, so it remembers. Start
  // closed and let openCalendar() do the opening, so the first paint has the
  // month's events instead of an empty grid.
  state.open = false;
  const was = localStorage.getItem("collector-calendar") ?? localStorage.getItem("not1-calendar");
  if (was === "1") openCalendar();
}

export function openCalendar() {
  if (!root) return;
  const was = state.open;
  state.open = true;
  localStorage.setItem("collector-calendar", "1");
  root.classList.remove("hidden");
  document.body.classList.add("calendar-open");
  document.getElementById("calendar-btn")?.classList.add("on");
  paint();
  if (!was) load();
}

export function closeCalendar() {
  if (!root) return;
  state.open = false;
  localStorage.setItem("collector-calendar", "0");
  root.classList.add("hidden");
  document.body.classList.remove("calendar-open");
  document.getElementById("calendar-btn")?.classList.remove("on");
}

export function toggleCalendar(force) {
  const want = force == null ? !state.open : !!force;
  if (want) openCalendar();
  else closeCalendar();
}

export function calendarOpen() {
  return state.open;
}

/** Re-read the month: called after a save, since a page write can move events. */
export function refreshCalendar() {
  if (state.open) load();
}

/** Jump the panel to a day, e.g. from a link in a page. */
export function showCalendarDay(dateStr) {
  state.month = startOfMonth(fromISO(dateStr));
  select(dateStr);
  openCalendar();
}
