// Databases: one page, one view over a folder of markdown files.
//
// The database definition lives in the page's frontmatter (`type: database`,
// `source:`, `fields:`, `view:`, …) and every row is a normal page whose
// frontmatter keys are the cells. So the file format is the schema; this module
// only reads it and writes single keys back.
import { api } from "./api.js";
import { icon } from "./icons.js";
import { escapeHtml } from "./markdown.js";

const CHECKBOX = "checkbox";
const DATE = "date";
const NUMBER = "number";
const SELECT = "select";
const TEXT = "text";

const TYPE_LABELS = {
  text: "Text",
  select: "Select",
  date: "Date",
  number: "Number",
  checkbox: "Checkbox",
};

export async function fetchDatabase(path) {
  const data = await api("/api/db?path=" + encodeURIComponent(path));
  return data.database;
}

/* ------------------------------------------------------------------ values */

function truthy(v) {
  switch (String(v ?? "").trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "1":
    case "done":
    case "checked":
      return true;
  }
  return false;
}

function parseDate(v) {
  const s = String(v ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return null;
  const d = new Date(s.length <= 10 ? s + "T00:00:00" : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

function fmtDate(v) {
  const d = parseDate(v);
  if (!d) return String(v ?? "");
  return d.getFullYear() === new Date().getFullYear() ? monthDay.format(d) : monthDayYear.format(d);
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function hue(s) {
  let h = 0;
  for (const ch of String(s)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}

function declList(fields) {
  if (!fields) return [];
  return String(fields)
    .split(",")
    .map((part) => {
      const [k, t] = part.split(":");
      return { key: (k || "").trim(), type: (t || "").trim() };
    })
    .filter((f) => f.key);
}

function serializeDecl(list) {
  return list.map((f) => (f.type ? `${f.key}:${f.type}` : f.key)).join(", ");
}

/* -------------------------------------------------------------- popovers */

let pop = null;

function closePop() {
  if (!pop) return;
  const { node, onDown, onKey } = pop;
  pop = null; // clear first: removing the node can fire blur handlers that call back in
  node.remove();
  document.removeEventListener("mousedown", onDown, true);
  document.removeEventListener("keydown", onKey, true);
}

function popover(anchor, node, { align = "start" } = {}) {
  closePop();
  document.body.appendChild(node);
  const a = anchor.getBoundingClientRect();
  const r = node.getBoundingClientRect();
  let left = align === "end" ? a.right - r.width : a.left;
  left = Math.max(8, Math.min(left, window.innerWidth - r.width - 8));
  let top = a.bottom + 4;
  if (top + r.height > window.innerHeight - 8) top = Math.max(8, a.top - r.height - 4);
  node.style.position = "fixed";
  node.style.left = left + "px";
  node.style.top = top + "px";
  node.style.zIndex = "60";

  const onDown = (e) => {
    if (!node.contains(e.target) && !node.dataset.keep?.includes("always")) closePop();
  };
  const onKey = (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      closePop();
    }
  };
  document.addEventListener("mousedown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  pop = { node, onDown, onKey };
  return node;
}

function menuList(items) {
  const node = document.createElement("div");
  node.className = "popover db-pop";
  node.innerHTML = items
    .map((it) => {
      if (it === "-") return '<div class="menu-sep"></div>';
      if (it.head) return `<div class="menu-head">${escapeHtml(it.head)}</div>`;
      return `<button class="menu-item ${it.danger ? "danger" : ""}">${
        it.icon ? icon(it.icon) : ""
      }<span>${escapeHtml(it.label)}</span>${
        it.hint ? `<span class="hint">${escapeHtml(it.hint)}</span>` : ""
      }</button>`;
    })
    .join("");
  const btns = [...node.querySelectorAll(".menu-item")];
  const actionable = items.filter((it) => it !== "-" && !it.head);
  btns.forEach((b, i) => {
    b.onclick = () => {
      closePop();
      actionable[i]?.action?.();
    };
  });
  return node;
}

/* -------------------------------------------------------------- mounting */

// renderDatabase paints the view into host. ctx supplies the few app-level
// actions a database needs; everything else is local.
// The currently mounted database view. Editors that float outside the grid use
// it to find their way back to the cell that opened them.
let dbHost = null;

export function renderDatabase(host, db, ctx) {
  dbHost = host;
  db.rows = db.rows || [];
  db.fields = db.fields || [];
  const paint = () => {
    // Keep the user's place across repaints: a cell write, a filter change or a
    // watcher refresh shouldn't drop them back to nothing.
    const restore = host._sel;
    const hadFocus = host.contains(document.activeElement);
    host.innerHTML = "";
    host.appendChild(toolbar(db, ctx, repaint));
    const body = document.createElement("div");
    body.className = "db-body";
    if (db.view === "board") body.appendChild(board(db, ctx, repaint));
    else if (db.view === "list") body.appendChild(listView(db, ctx, repaint));
    else body.appendChild(table(db, ctx, repaint, host));
    host.appendChild(body);
    host.dataset.view = db.view;
    if (restore && db.view === "table") {
      const td = host.querySelector(
        `td.db-cell[data-r="${restore.r}"][data-c="${restore.c}"]`
      );
      if (td) {
        td.classList.add("sel");
        if (hadFocus) td.focus({ preventScroll: true });
      }
    }
  };

  // repaint re-renders after a local model change; refresh pulls the folder
  // again after the filesystem moved underneath us (new/deleted rows).
  const repaint = () => paint();
  const refresh = async () => {
    if (!ctx.current()) return;
    // Don't yank the DOM out from under an inline rename; retry once it settles.
    if (host.querySelector(".db-name-input")) {
      clearTimeout(db._refreshTimer);
      db._refreshTimer = setTimeout(() => db._refresh?.(), 400);
      return;
    }
    try {
      const next = await fetchDatabase(db.path);
      Object.assign(db, next);
      paint();
    } catch (err) {
      ctx.toast(err.message, "error");
    }
  };
  db._refresh = refresh;
  db._newRow = (group) => createRow(db, ctx, group, null, repaint);
  paint();
  return { refresh };
}

async function setView(db, ctx, patch) {
  Object.assign(db, patch);
  try {
    const data = await api("/api/db", { method: "POST", body: { path: db.path, ...patch } });
    Object.assign(db, data.database);
  } catch (err) {
    ctx.toast(err.message, "error");
  }
}

/* --------------------------------------------------------------- toolbar */

function toolbar(db, ctx, repaint) {
  const bar = document.createElement("div");
  bar.className = "db-bar";

  const views = [
    ["table", "Table"],
    ["board", "Board"],
    ["list", "List"],
  ];
  const seg = document.createElement("div");
  seg.className = "seg db-seg";
  seg.innerHTML = views
    .map(
      ([k, label]) =>
        `<button class="seg-btn${db.view === k ? " active" : ""}" data-view="${k}">${label}</button>`
    )
    .join("");
  seg.querySelectorAll(".seg-btn").forEach((b) => {
    b.onclick = () => {
      if (b.dataset.view === db.view) return;
      setView(db, ctx, { view: b.dataset.view }).then(repaint);
    };
  });
  bar.appendChild(seg);

  const tools = document.createElement("div");
  tools.className = "db-tools";

  const count = document.createElement("span");
  count.className = "db-count";
  count.textContent =
    db.rows.length === db.total
      ? `${db.total} row${db.total === 1 ? "" : "s"}`
      : `${db.rows.length} of ${db.total}`;
  tools.appendChild(count);

  if (db.view === "board") tools.appendChild(groupButton(db, ctx, repaint));

  if (db.filter) {
    const chip = document.createElement("button");
    chip.className = "db-tool db-chip-tool";
    chip.innerHTML = `${icon("hash")}<span>${escapeHtml(db.filter)}</span><span class="x">${icon("x")}</span>`;
    chip.title = "Edit filter";
    chip.onclick = (e) => {
      if (e.target.closest(".x")) {
        setView(db, ctx, { filter: "" }).then(repaint);
        return;
      }
      openFilter(db, ctx, chip, repaint);
    };
    tools.appendChild(chip);
  } else {
    const f = document.createElement("button");
    f.className = "db-tool";
    f.innerHTML = `${icon("list")}<span>Filter</span>`;
    f.onclick = () => openFilter(db, ctx, f, repaint);
    tools.appendChild(f);
  }

  const sortBtn = document.createElement("button");
  sortBtn.className = "db-tool";
  const sortLabel = db.sort ? `${db.sort} ${db.sortDir === "desc" ? "↓" : "↑"}` : "Sort";
  sortBtn.innerHTML = `${icon("table")}<span>${escapeHtml(sortLabel)}</span>`;
  sortBtn.onclick = () => openSort(db, ctx, sortBtn, repaint);
  tools.appendChild(sortBtn);

  bar.appendChild(tools);
  return bar;
}

function groupButton(db, ctx, repaint) {
  const b = document.createElement("button");
  b.className = "db-tool";
  b.innerHTML = `${icon("panel")}<span>Group: ${escapeHtml(db.groupBy || "none")}</span>`;
  b.onclick = () => {
    const items = [{ head: "Group by" }];
    if (db.groupBy) items.push({ label: "No grouping", icon: "x", action: () => setView(db, ctx, { groupBy: "" }).then(repaint) });
    for (const f of db.fields.filter((x) => x.type === SELECT || x.type === CHECKBOX)) {
      items.push({
        label: f.key,
        hint: f.key === db.groupBy ? "✓" : "",
        action: () => setView(db, ctx, { groupBy: f.key }).then(repaint),
      });
    }
    if (items.length === 1) items.push({ label: "Add a select property first" });
    popover(b, menuList(items));
  };
  return b;
}

function openSort(db, ctx, anchor, repaint) {
  const items = [{ head: "Sort by" }];
  const fields = [{ key: "title", type: TEXT }, ...db.fields];
  for (const f of fields) {
    if (f.key === db.groupBy) continue;
    const active = db.sort === f.key || (f.key === "title" && !db.sort);
    items.push({
      label: f.key,
      hint: active ? (db.sortDir === "desc" ? "↓" : "↑") : "",
      action: () => {
        const dir = active && db.sortDir !== "desc" ? "desc" : "asc";
        setView(db, ctx, { sort: f.key === "title" ? "" : f.key, sortDir: dir }).then(repaint);
      },
    });
  }
  items.push("-", { label: "Title, A to Z", icon: "list", action: () => setView(db, ctx, { sort: "", sortDir: "asc" }).then(repaint) });
  popover(anchor, menuList(items), { align: "end" });
}

function openFilter(db, ctx, anchor, repaint) {
  const node = document.createElement("div");
  node.className = "popover db-pop db-filter-pop";
  const suggestions = [];
  for (const f of db.fields) {
    if (f.type === SELECT) {
      for (const o of f.options || []) suggestions.push(`${f.key} = ${o}`);
    } else if (f.type === CHECKBOX) {
      suggestions.push(`${f.key} = true`);
      suggestions.push(`${f.key} = false`);
    } else if (f.type === DATE) {
      suggestions.push(`${f.key} >= ${todayISO()}`);
      suggestions.push(`${f.key} < ${todayISO()}`);
    }
  }
  node.innerHTML =
    `<div class="menu-head">Filter rows</div>` +
    `<input class="db-filter-input" type="text" spellcheck="false" placeholder="status != done, due &lt; 2026-03-01…" value="${escapeHtml(
      db.filter || ""
    )}">` +
    (suggestions.length
      ? `<div class="db-suggest">${suggestions
          .slice(0, 8)
          .map((s) => `<button class="db-suggestion">${escapeHtml(s)}</button>`)
          .join("")}</div>`
      : "") +
    `<div class="db-filter-actions"><button class="btn-ghost db-clear">Clear</button><button class="btn-ghost db-apply">Apply</button></div>`;

  const input = node.querySelector("input");
  const apply = (value) => {
    closePop();
    setView(db, ctx, { filter: value.trim() }).then(repaint);
  };
  node.querySelector(".db-apply").onclick = () => apply(input.value);
  node.querySelector(".db-clear").onclick = () => apply("");
  node.querySelectorAll(".db-suggestion").forEach((b) => {
    b.onclick = () => {
      input.value = b.textContent;
      apply(input.value);
    };
  });
  input.onkeydown = (e) => {
    if (e.key === "Enter") apply(input.value);
  };
  popover(anchor, node, { align: "end" });
  input.focus();
  input.select();
}

/* ---------------------------------------------------------------- table */

function table(db, ctx, repaint, host) {
  const wrap = document.createElement("div");
  wrap.className = "db-table-wrap";
  const t = document.createElement("table");
  t.className = "db-table";

  const head = document.createElement("thead");
  const hrow = document.createElement("tr");
  hrow.appendChild(th("Name", null, db, ctx, repaint));
  for (const f of db.fields) hrow.appendChild(th(f.key, f, db, ctx, repaint));
  const addTh = document.createElement("th");
  addTh.className = "db-th-add";
  addTh.innerHTML = `<button class="icon-btn tiny" title="New property">${icon("plus")}</button>`;
  addTh.querySelector("button").onclick = () => addProperty(db, ctx, addTh, repaint);
  hrow.appendChild(addTh);
  head.appendChild(hrow);
  t.appendChild(head);

  const tb = document.createElement("tbody");
  db.rows.forEach((row, r) => {
    const tr = document.createElement("tr");
    tr.dataset.path = row.path;

    const nameCell = document.createElement("td");
    nameCell.className = "db-cell db-cell-name";
    nameCell.dataset.r = String(r);
    nameCell.dataset.c = "0";
    nameCell.tabIndex = -1;
    const name = nameNode(row, db, ctx, repaint);
    name.title = "Open page";
    nameCell.appendChild(name);
    tr.appendChild(nameCell);

    db.fields.forEach((f, i) => {
      const td = document.createElement("td");
      td.className = "db-cell";
      td.dataset.r = String(r);
      td.dataset.c = String(i + 1);
      td.tabIndex = -1;
      const v = document.createElement("div");
      v.className = "db-cell-btn";
      paintValue(v, row, f);
      td.appendChild(v);
      tr.appendChild(td);
    });

    const more = document.createElement("td");
    more.className = "db-cell-more";
    more.innerHTML = `<button class="icon-btn tiny" title="Row options">${icon("more")}</button>`;
    more.querySelector("button").onclick = () => rowMenu(row, db, ctx, repaint, more.querySelector("button"));
    tr.appendChild(more);
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  wrap.appendChild(t);

  if (!db.rows.length) {
    const empty = document.createElement("p");
    empty.className = "db-empty";
    empty.textContent = db.total
      ? "No rows match this filter."
      : "No rows yet. Every row is a markdown file in this folder.";
    wrap.appendChild(empty);
  }
  wrap.appendChild(newRowButton(db, ctx, repaint, null));

  /* --- cell focus, keyboard and clicks --------------------------------- */

  const lastCol = db.fields.length;
  const fieldAt = (c) => (c > 0 ? db.fields[c - 1] : null);
  const cellAt = (r, c) =>
    t.querySelector(`td.db-cell[data-r="${r}"][data-c="${c}"]`);

  const selectCell = (td) => {
    if (!td) return;
    for (const el of t.querySelectorAll("td.db-cell.sel")) el.classList.remove("sel");
    td.classList.add("sel");
    host._sel = { r: +td.dataset.r, c: +td.dataset.c };
    td.focus({ preventScroll: true });
    td.scrollIntoView({ block: "nearest", inline: "nearest" });
  };

  const move = (td, dr, dc) => {
    const r = clamp(+td.dataset.r + dr, 0, db.rows.length - 1);
    const c = clamp(+td.dataset.c + dc, 0, lastCol);
    selectCell(cellAt(r, c));
  };

  function startRename(td, row) {
    const node = nameNode(row, db, ctx, repaint, { editing: true });
    td.replaceChildren(node);
  }

  t.addEventListener("mousedown", (e) => {
    if (e.target.closest(".db-cell-input") || e.target.closest(".db-name-input")) return;
    const td = e.target.closest("td.db-cell");
    if (td) selectCell(td);
  });

  t.addEventListener("click", (e) => {
    const td = e.target.closest("td.db-cell");
    if (!td) return;
    if (e.target.closest(".db-cell-input") || e.target.closest(".db-name")) return;
    const c = +td.dataset.c;
    const field = fieldAt(c);
    if (!field) return;
    selectCell(td);
    beginEdit(td, db.rows[+td.dataset.r], field, db, ctx, repaint, host);
  });

  t.addEventListener("keydown", (e) => {
    const td = e.target.closest("td.db-cell");
    if (!td) return;
    if (e.target.matches(".db-cell-input, .db-name-input")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    const r = +td.dataset.r;
    const c = +td.dataset.c;
    const row = db.rows[r];
    const field = fieldAt(c);

    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        return move(td, -1, 0);
      case "ArrowDown":
        e.preventDefault();
        return move(td, 1, 0);
      case "ArrowLeft":
        e.preventDefault();
        return move(td, 0, -1);
      case "ArrowRight":
        e.preventDefault();
        return move(td, 0, 1);
      case "Tab":
        e.preventDefault();
        return move(td, 0, e.shiftKey ? -1 : 1);
      case "Enter":
      case "F2":
        e.preventDefault();
        if (!field) return startRename(td, row);
        return beginEdit(td, row, field, db, ctx, repaint, host);
      case "Backspace":
      case "Delete":
        if (!field) return;
        e.preventDefault();
        if (field.type === CHECKBOX) writeCell(row, field, "false", db, ctx, repaint);
        else if (row.props[field.key]) writeCell(row, field, "", db, ctx, repaint);
        return;
    }

    if (e.key.length === 1 && !e.isComposing && field) {
      e.preventDefault();
      beginEdit(td, row, field, db, ctx, repaint, host, { text: e.key });
    }
  });

  return wrap;
}

function th(label, field, db, ctx, repaint) {
  const cell = document.createElement("th");
  const sorted = field ? db.sort === field.key : !db.sort;
  cell.innerHTML =
    `<button class="db-th">${escapeHtml(label)}${
      sorted ? `<span class="sort-arrow">${db.sortDir === "desc" ? "↓" : "↑"}</span>` : ""
    }</button>` +
    (field ? `<button class="db-th-menu" title="Property options">${icon("more")}</button>` : "");
  const menuBtn = cell.querySelector(".db-th-menu");
  if (menuBtn) {
    menuBtn.onclick = (e) => {
      e.stopPropagation();
      propertyMenu(field, cell, db, ctx, repaint);
    };
  }
  cell.querySelector("button").onclick = (e) => {
    if (!field) {
      const dir = sorted && db.sortDir !== "desc" ? "desc" : "asc";
      setView(db, ctx, { sort: "", sortDir: dir }).then(repaint);
      return;
    }
    if (e.altKey || e.metaKey) {
      propertyMenu(field, cell, db, ctx, repaint);
      return;
    }
    const dir = db.sort === field.key && db.sortDir !== "desc" ? "desc" : "asc";
    setView(db, ctx, { sort: field.key, sortDir: dir }).then(repaint);
  };
  cell.oncontextmenu = (e) => {
    if (!field) return;
    e.preventDefault();
    propertyMenu(field, cell, db, ctx, repaint);
  };
  return cell;
}

function propertyMenu(field, cell, db, ctx, repaint) {
  const items = [
    { head: field.key },
    { label: "Rename property", icon: "edit", action: () => renameProperty(field, cell, db, ctx, repaint) },
    "-",
    { head: "Type" },
  ];
  for (const [type, label] of Object.entries(TYPE_LABELS)) {
    items.push({
      label,
      hint: field.type === type ? "✓" : "",
      action: () => {
        const list = db.fields.map((f) => ({ key: f.key, type: f.key === field.key ? type : f.type }));
        setView(db, ctx, { fields: serializeDecl(list) }).then(repaint);
      },
    });
  }
  items.push("-", {
    label: "Remove property",
    icon: "trash",
    danger: true,
    action: () => {
      const list = db.fields.filter((f) => f.key !== field.key).map((f) => `${f.key}:${f.type}`);
      setView(db, ctx, { fields: serializeDecl(declList(list.join(", "))) }).then(repaint);
    },
  });
  popover(cell, menuList(items), { align: "end" });
}

function renameProperty(field, anchor, db, ctx, repaint) {
  const node = document.createElement("div");
  node.className = "popover db-pop db-input-pop";
  node.innerHTML = `<div class="menu-head">Rename property</div><input type="text" spellcheck="false" value="${escapeHtml(
    field.key
  )}">`;
  const input = node.querySelector("input");
  const commit = () => {
    const next = input.value.trim();
    closePop();
    if (!next || next === field.key) return;
    const list = db.fields.map((f) => `${f.key === field.key ? next : f.key}:${f.type}`);
    setView(db, ctx, { fields: serializeDecl(declList(list.join(", "))) }).then(repaint);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") commit();
  };
  popover(anchor, node, { align: "end" });
  input.focus();
  input.select();
}

function addProperty(db, ctx, anchor, repaint) {
  const node = document.createElement("div");
  node.className = "popover db-pop db-input-pop";
  node.innerHTML = `<div class="menu-head">New property</div><input type="text" spellcheck="false" placeholder="Due date">`;
  const input = node.querySelector("input");
  const commit = () => {
    const name = input.value.trim().replace(/:/g, "");
    closePop();
    if (!name) return;
    const existing = db.fields.map((f) => ({ key: f.key, type: f.type }));
    if (!existing.some((f) => f.key.toLowerCase() === name.toLowerCase())) {
      existing.push({ key: name, type: TEXT });
    }
    setView(db, ctx, { fields: serializeDecl(existing) }).then(repaint);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") commit();
  };
  popover(anchor, node, { align: "end" });
  input.focus();
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), Math.max(lo, hi));
}

/* --- cell rendering ---------------------------------------------------- */

// paintValue draws a value into any element. Class names match the old button
// styling so board cards, list rows and table cells all look the same.
function paintValue(host, row, field) {
  const raw = row.props[field.key] ?? "";
  if (field.type === CHECKBOX) {
    const on = truthy(raw);
    host.classList.add("check");
    if (on) host.classList.add("on");
    host.innerHTML = `<span class="box">${on ? icon("check") : ""}</span>`;
    return;
  }
  if (!String(raw).trim()) {
    host.classList.add("empty");
    host.textContent = "";
    return;
  }
  if (field.type === SELECT) {
    const pill = document.createElement("span");
    pill.className = "db-pill";
    pill.style.setProperty("--h", hue(raw));
    pill.textContent = raw;
    host.appendChild(pill);
  } else if (field.type === DATE) {
    const d = parseDate(raw);
    host.textContent = d ? fmtDate(raw) : raw;
    if (d) {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      if (d < today) host.classList.add("overdue");
      else if (d.getTime() === today.getTime()) host.classList.add("today");
    }
  } else if (field.type === NUMBER) {
    host.textContent = raw;
    host.classList.add("num");
  } else {
    host.textContent = raw;
  }
}

function nameNode(row, db, ctx, repaint, { editing = false } = {}) {
  const node = document.createElement("div");
  node.className = "db-name";
  const badge = document.createElement("span");
  badge.className = "db-name-icon";
  badge.innerHTML = row.icon ? escapeHtml(row.icon) : icon("file");
  node.appendChild(badge);
  const label = document.createElement("span");
  label.className = "db-name-text";
  label.textContent = row.title || "Untitled";
  node.appendChild(label);
  node.onclick = () => ctx.openPage(row.path);
  if (!editing) return node;

  const input = document.createElement("input");
  input.className = "db-name-input";
  input.value = row.title || "";
  input.spellcheck = false;
  label.replaceWith(input);
  let done = false;
  const commit = async (keep = false) => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    if (!name || name === row.title) {
      if (!keep) repaint();
      return;
    }
    try {
      const data = await api("/api/rename", { method: "POST", body: { path: row.path, name } });
      row.title = data.page.title;
      row.path = data.page.path;
      ctx.refreshTree();
      repaint(); // drop the input so the deferred refresh can run
      await db._refresh?.();
    } catch (err) {
      ctx.toast(err.message, "error");
      repaint();
    }
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      done = true;
      repaint();
    } else if (e.key === "Tab") {
      e.preventDefault();
      commit();
    }
  };
  input.onblur = () => commit();
  setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
  return node;
}

function cellValue(row, field, db, ctx, repaint) {
  const btn = document.createElement("button");
  btn.className = "db-cell-btn";
  paintValue(btn, row, field);
  btn.onclick = () => editCell(btn, row, field, db, ctx, repaint);
  return btn;
}

// editCell is the board/list entry point: a button is the anchor and the editor
// floats next to it. The table has its own cell-level flow (beginEdit).
function editCell(anchor, row, field, db, ctx, repaint) {
  if (field.type === CHECKBOX) {
    writeCell(row, field, truthy(row.props[field.key]) ? "false" : "true", db, ctx, repaint);
    return;
  }
  if (field.type === SELECT) return openSelect(anchor, row, field, db, ctx, repaint);
  if (field.type === DATE) return openDate(anchor, row, field, db, ctx, repaint);
  return openTextInput(anchor, row, field, db, ctx, repaint);
}

/* --- editors ----------------------------------------------------------- */

// beginEdit is how a table cell becomes editable: text and numbers turn into an
// input in place, select and date open a small picker, checkbox just flips.
function beginEdit(td, row, field, db, ctx, repaint, host, { text = null } = {}) {
  if (field.type === CHECKBOX) {
    writeCell(row, field, truthy(row.props[field.key]) ? "false" : "true", db, ctx, repaint);
    return;
  }
  if (field.type === SELECT) return openSelect(td, row, field, db, ctx, repaint, text ?? "");
  if (field.type === DATE) return openDate(td, row, field, db, ctx, repaint);
  return inlineEdit(td, row, field, db, ctx, repaint, host, text);
}

// Editors opened from a table cell hand focus back to that cell once the write
// lands, so pick-a-value doesn't end the keyboard run.
function refocusCell(anchor) {
  if (!anchor || anchor.tagName !== "TD" || anchor.dataset.r == null) return;
  focusCell(null, Number(anchor.dataset.r), Number(anchor.dataset.c));
}

function paintCell(td, row, field) {
  const v = document.createElement("div");
  v.className = "db-cell-btn";
  paintValue(v, row, field);
  td.replaceChildren(v);
}

function focusCell(host, r, c) {
  const scope = host || dbHost;
  const grid = scope?.querySelector(".db-table");
  if (!grid) return;
  const next = grid.querySelector(`td.db-cell[data-r="${r}"][data-c="${c}"]`);
  if (!next) return;
  for (const el of grid.querySelectorAll("td.db-cell.sel")) el.classList.remove("sel");
  next.classList.add("sel");
  scope._sel = { r, c };
  next.focus({ preventScroll: true });
}

function inlineEdit(td, row, field, db, ctx, repaint, host, text = null) {
  if (td.querySelector(".db-cell-input")) return;
  const raw = row.props[field.key] ?? "";
  const r = +td.dataset.r;
  const c = +td.dataset.c;

  const input = document.createElement("input");
  input.className = "db-cell-input";
  input.value = text ?? raw;
  input.spellcheck = false;
  if (field.type === NUMBER) {
    input.inputMode = "decimal";
    input.autocomplete = "off";
  }
  td.classList.add("editing");
  td.replaceChildren(input);

  let done = false;
  const finish = async (commit, dir, keepFocus) => {
    if (done) return;
    done = true;
    td.classList.remove("editing");
    const value = input.value.trim();
    const changed = commit && value !== raw;
    const lastRow = db.rows.length - 1;
    const addRow = changed && dir === "down" && r === lastRow;
    if (changed) await writeCell(row, field, value, db, ctx, repaint);
    else paintCell(td, row, field);
    if (!keepFocus) return;
    if (addRow) {
      // Enter on the last row adds one, the way a spreadsheet does.
      createRow(db, ctx, null, null, repaint);
      return;
    }
    const nr = clamp(r + (dir === "down" ? 1 : 0), 0, lastRow);
    const nc = clamp(c + (dir === "right" ? 1 : dir === "left" ? -1 : 0), 0, db.fields.length);
    focusCell(host, nr, nc);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true, "down", true);
    } else if (e.key === "Tab") {
      e.preventDefault();
      finish(true, e.shiftKey ? "left" : "right", true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false, null, true);
    }
  });
  input.addEventListener("blur", () => finish(true, null, false));

  input.focus();
  if (text === null) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
}

// openSelect is the one editor that stays a popover: an option list you can
// filter with the keyboard, plus a "Create" entry for values that are new.
function openSelect(anchor, row, field, db, ctx, repaint, query = "") {
  const raw = row.props[field.key] ?? "";
  const node = document.createElement("div");
  node.className = "popover db-pop db-input-pop db-select-pop";
  node.innerHTML =
    `<input type="text" class="db-select-search" spellcheck="false" placeholder="Search or add…" value="${escapeHtml(query)}">` +
    `<div class="db-opts"></div>` +
    `<div class="db-filter-actions"><button class="btn-ghost db-clear-opt">Clear</button></div>`;

  const input = node.querySelector(".db-select-search");
  const list = node.querySelector(".db-opts");
  const options = field.options || [];
  let items = [];
  let active = -1;

  const apply = async (v) => {
    closePop();
    await writeCell(row, field, v, db, ctx, repaint);
    refocusCell(anchor);
  };

  const render = () => {
    const q = input.value.trim();
    const lower = q.toLowerCase();
    items = options.filter((o) => !lower || o.toLowerCase().includes(lower)).map((o) => ({ value: o }));
    if (q && !options.some((o) => o.toLowerCase() === lower)) items.push({ create: q });
    list.innerHTML = "";
    items.forEach((it, i) => {
      const b = document.createElement("button");
      b.className = "db-opt" + (i === active ? " active" : "");
      if (it.create) {
        b.innerHTML = `<span class="db-opt-plus">${icon("plus")}</span><span class="db-opt-new">${escapeHtml(it.create)}</span>`;
      } else {
        b.innerHTML =
          `<span class="db-pill" style="--h:${hue(it.value)}">${escapeHtml(it.value)}</span>` +
          (it.value === raw ? `<span class="db-opt-check">${icon("check")}</span>` : "");
      }
      b.onclick = () => apply(it.create || it.value);
      list.appendChild(b);
    });
    if (!items.length) {
      const none = document.createElement("div");
      none.className = "db-opt-none";
      none.textContent = "No options yet — type to add one.";
      list.appendChild(none);
    }
  };

  input.addEventListener("input", () => {
    active = -1;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = input.value.trim().toLowerCase();
      const exact = options.find((o) => o.toLowerCase() === q);
      const it = active >= 0 ? items[active] : exact ? { value: exact } : items[0];
      const v = it ? it.create || it.value : input.value.trim();
      if (v) apply(v);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      active = Math.min(active + 1, items.length - 1);
      render();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      active = Math.max(active - 1, -1);
      render();
    }
  });
  node.querySelector(".db-clear-opt").onclick = () => apply("");

  render();
  popover(anchor, node);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function openDate(anchor, row, field, db, ctx, repaint) {
  const raw = row.props[field.key] ?? "";
  const node = document.createElement("div");
  node.className = "popover db-pop db-input-pop db-date-pop";
  node.innerHTML =
    `<div class="menu-head">${escapeHtml(field.key)}</div>` +
    `<input type="date" value="${escapeHtml(String(raw).slice(0, 10))}">` +
    `<div class="db-date-quick">
       <button class="btn-ghost" data-days="0">Today</button>
       <button class="btn-ghost" data-days="1">Tomorrow</button>
       <button class="btn-ghost" data-days="7">Next week</button>
     </div>` +
    `<div class="db-filter-actions"><button class="btn-ghost db-clear-opt">Clear</button></div>`;

  const input = node.querySelector("input");
  const apply = async (v) => {
    closePop();
    await writeCell(row, field, v, db, ctx, repaint);
    refocusCell(anchor);
  };
  input.onchange = () => apply(input.value);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply(input.value);
    }
  });
  node.querySelectorAll("[data-days]").forEach((b) => {
    b.onclick = () => {
      const d = new Date();
      d.setDate(d.getDate() + Number(b.dataset.days));
      apply(d.toISOString().slice(0, 10));
    };
  });
  node.querySelector(".db-clear-opt").onclick = () => apply("");

  popover(anchor, node);
  input.focus();
}

// openTextInput is the popover variant used by board cards and list rows, where
// there is no cell to grow into.
function openTextInput(anchor, row, field, db, ctx, repaint) {
  const raw = row.props[field.key] ?? "";
  const node = document.createElement("div");
  node.className = "popover db-pop db-input-pop";
  node.innerHTML = `<input type="text" spellcheck="false" ${
    field.type === NUMBER ? 'inputmode="decimal"' : ""
  } value="${escapeHtml(raw)}">`;
  const input = node.querySelector("input");
  let done = false;
  const apply = (v) => {
    if (done) return;
    done = true;
    closePop();
    if (v !== raw) writeCell(row, field, v, db, ctx, repaint);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      apply(input.value.trim());
    }
  };
  input.onblur = () => {
    if (!done && pop) apply(input.value.trim());
  };
  popover(anchor, node);
  input.focus();
  input.select();
}

async function writeCell(row, field, value, db, ctx, repaint) {
  const prev = row.props[field.key] ?? "";
  if (prev === value) return;
  if (value === "") delete row.props[field.key];
  else row.props[field.key] = value;
  repaint();
  try {
    await api("/api/prop", { method: "POST", body: { path: row.path, key: field.key, value } });
    const f = db.fields.find((x) => x.key === field.key);
    if (f && f.type === SELECT && value && !(f.options || []).includes(value)) {
      f.options = [...(f.options || []), value];
    }
  } catch (err) {
    row.props[field.key] = prev;
    repaint();
    ctx.toast(err.message, "error");
  }
}

function rowMenu(row, db, ctx, repaint, anchor) {
  popover(
    anchor,
    menuList([
      { head: row.title || "Untitled", path: true },
      { label: "Open", icon: "file", action: () => ctx.openPage(row.path) },
      { label: "Rename", icon: "edit", action: () => renameRow(row, db, ctx, repaint) },
      "-",
      { label: "Move to trash", icon: "trash", danger: true, action: () => ctx.deleteRow(row, repaint) },
    ]),
    { align: "end" }
  );
}

async function renameRow(row, db, ctx, repaint) {
  const node = document.createElement("div");
  node.className = "popover db-pop db-input-pop";
  node.innerHTML = `<div class="menu-head">Rename row</div><input type="text" spellcheck="false" value="${escapeHtml(
    row.title || ""
  )}">`;
  const input = node.querySelector("input");
  input.onkeydown = async (e) => {
    if (e.key !== "Enter") return;
    const name = input.value.trim();
    closePop();
    if (!name || name === row.title) return;
    try {
      const data = await api("/api/rename", { method: "POST", body: { path: row.path, name } });
      row.path = data.page.path;
      row.title = data.page.title;
      ctx.refreshTree();
      await db._refresh?.();
    } catch (err) {
      ctx.toast(err.message, "error");
    }
  };
  popover(node, node);
  input.focus();
  input.select();
}

function newRowButton(db, ctx, repaint, group) {
  const b = document.createElement("button");
  b.className = "db-new";
  b.innerHTML = `${icon("plus")}<span>New</span>`;
  b.onclick = () => createRow(db, ctx, group, b, repaint);
  return b;
}

async function createRow(db, ctx, group, anchor, repaint) {
  const props = {};
  if (group && db.groupBy) props[db.groupBy] = group;
  try {
    const data = await api("/api/db/row", { method: "POST", body: { db: db.path, title: "Untitled", props } });
    const row = {
      path: data.page.path,
      title: data.page.title,
      icon: data.page.icon || "",
      updated: data.page.updated,
      props: { ...(data.page.props || {}) },
    };
    for (const k of Object.keys(row.props)) {
      if (["icon", "tags", "pinned", "created", "updated", "title", "type"].includes(k)) delete row.props[k];
    }
    db.rows.unshift(row);
    db.total += 1;
    ctx.refreshTree();
    repaint();
    // Straight into renaming, like a fresh Notion row.
    focusNewRow(row, db, ctx, repaint);
  } catch (err) {
    ctx.toast(err.message, "error");
    void anchor;
  }
}

function wrapRename(row, db, ctx, repaint) {
  const cell = document.createElement("td");
  cell.className = "db-cell-name";
  cell.appendChild(nameNode(row, db, ctx, repaint, { editing: true }));
  cell.dataset.row = "1";
  return cell;
}

// The new row may land in a table, a board column or a list, and the view can
// repaint underneath us, so keep looking for a few frames before giving up.
function focusNewRow(row, db, ctx, repaint) {
  const sel = `[data-path="${CSS.escape(row.path)}"]`;
  const attempt = (n) => {
    const tr = document.querySelector(`.db-table tr${sel}`);
    const name = tr?.querySelector(".db-cell-name");
    if (name) {
      name.replaceWith(wrapRename(row, db, ctx, repaint));
      return;
    }
    const label = document.querySelector(`.db-card${sel} .db-name-text, .db-list-row${sel} .db-name-text`);
    if (label) {
      label.closest(".db-name")?.replaceWith(nameNode(row, db, ctx, repaint, { editing: true }));
      return;
    }
    if (n < 20) setTimeout(() => attempt(n + 1), 16);
  };
  attempt(0);
}

/* ---------------------------------------------------------------- board */

function board(db, ctx, repaint) {
  const wrap = document.createElement("div");
  wrap.className = "db-board";
  if (!db.groupBy) {
    const note = document.createElement("div");
    note.className = "db-board-note";
    note.innerHTML =
      `<p class="db-board-title">Group this database</p>` +
      `<p class="db-board-sub">Pick a select property and the rows become columns of cards you can drag between.</p>`;
    const b = document.createElement("button");
    b.className = "btn-ghost";
    b.innerHTML = "Choose a property";
    b.onclick = () => groupButton(db, ctx, repaint).onclick();
    note.appendChild(b);
    wrap.appendChild(note);
    return wrap;
  }

  const field = db.fields.find((f) => f.key === db.groupBy) || { key: db.groupBy, type: SELECT, options: [] };
  let cols = field.type === CHECKBOX ? ["true", "false"] : [...(field.options || [])];
  const buckets = new Map();
  for (const c of cols) buckets.set(c, []);
  const rest = [];
  for (const row of db.rows) {
    const v = row.props[field.key] ?? "";
    if (!v) rest.push(row);
    else if (!buckets.has(v)) buckets.set(v, [row]);
    else buckets.get(v).push(row);
  }
  if (rest.length) buckets.set("", rest);

  for (const [value, rows] of buckets) {
    const col = document.createElement("div");
    col.className = "db-col";
    col.dataset.group = value;
    const head = document.createElement("div");
    head.className = "db-col-head";
    head.innerHTML = `${
      value
        ? `<span class="db-pill" style="--h:${hue(value)}">${escapeHtml(value)}</span>`
        : `<span class="db-pill none">No value</span>`
    }<span class="db-col-count">${rows.length}</span>`;
    col.appendChild(head);

    const cards = document.createElement("div");
    cards.className = "db-cards";
    for (const row of rows) cards.appendChild(card(row, db, ctx, repaint));
    col.appendChild(cards);

    const nb = document.createElement("button");
    nb.className = "db-new db-new-card";
    nb.innerHTML = `${icon("plus")}<span>New</span>`;
    nb.onclick = () => createRow(db, ctx, value, nb, repaint);
    col.appendChild(nb);

    col.ondragover = (e) => {
      e.preventDefault();
      col.classList.add("drop");
    };
    col.ondragleave = () => col.classList.remove("drop");
    col.ondrop = (e) => {
      e.preventDefault();
      col.classList.remove("drop");
      const path = e.dataTransfer.getData("text/plain");
      const row = db.rows.find((r) => r.path === path);
      if (!row) return;
      writeCell(row, field, value, db, ctx, repaint);
    };
    wrap.appendChild(col);
  }
  return wrap;
}

function card(row, db, ctx, repaint) {
  const node = document.createElement("div");
  node.className = "db-card";
  node.dataset.path = row.path;
  node.draggable = true;
  node.ondragstart = (e) => {
    e.dataTransfer.setData("text/plain", row.path);
    e.dataTransfer.effectAllowed = "move";
    node.classList.add("dragging");
  };
  node.ondragend = () => node.classList.remove("dragging");

  const name = document.createElement("div");
  name.appendChild(nameNode(row, db, ctx, repaint));
  node.appendChild(name);

  const extras = db.fields.filter((f) => f.key !== db.groupBy);
  const shown = extras.filter((f) => String(row.props[f.key] ?? "").trim()).slice(0, 4);
  if (shown.length) {
    const meta = document.createElement("div");
    meta.className = "db-card-meta";
    for (const f of shown) {
      const b = document.createElement("button");
      b.className = "db-cell-btn tight";
      b.appendChild(cellValue(row, f, db, ctx, repaint));
      meta.appendChild(b);
    }
    node.appendChild(meta);
  }
  return node;
}

/* ----------------------------------------------------------------- list */

function listView(db, ctx, repaint) {
  const wrap = document.createElement("div");
  wrap.className = "db-list";
  for (const row of db.rows) {
    const item = document.createElement("div");
    item.className = "db-list-row";
    item.dataset.path = row.path;
    item.appendChild(nameNode(row, db, ctx, repaint));
    const meta = document.createElement("div");
    meta.className = "db-list-meta";
    for (const f of db.fields) {
      if (!String(row.props[f.key] ?? "").trim()) continue;
      meta.appendChild(cellValue(row, f, db, ctx, repaint));
    }
    item.appendChild(meta);
    wrap.appendChild(item);
  }
  if (!db.rows.length) {
    const empty = document.createElement("p");
    empty.className = "db-empty";
    empty.textContent = db.total ? "No rows match this filter." : "No rows yet.";
    wrap.appendChild(empty);
  }
  wrap.appendChild(newRowButton(db, ctx, repaint, null));
  return wrap;
}
