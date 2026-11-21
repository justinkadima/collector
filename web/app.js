import { api, ApiError, TOKEN, fileUrl } from "./api.js";
import { icon } from "./icons.js";
import { renderMarkdown, renderInline, toggleTask, escapeHtml } from "./markdown.js";
import {
  initCells,
  startCellEdit,
  openCellMenu,
  showRowGrip,
  showColGrip,
  hideRowGrip,
  scheduleGripHide,
} from "./cells.js";
import { fetchDatabase, renderDatabase } from "./db.js";
import {
  autoResize,
  caretCoords,
  wrapSelection,
  indentSelection,
  handleEnter,
} from "./editor.js";

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  workspace: "",
  needsWorkspace: true,
  tree: null,
  icons: {},
  theme: "light",
  page: null,
  dirty: false,
  saving: false,
  saveAgain: false,
  saveTimer: 0,
  readMode: false,
  backlinks: [],
  expanded: new Set(),
  recentPages: [],
  recentWorkspaces: [],
  sidebarWidth: 264,
  knownTitles: new Map(),
  pageCount: 0,
  openSeq: 0,
  db: null,
  dbView: null,
};

const el = {};
let overlay = null;
let menu = null;
let slash = { open: false, start: 0, query: "", items: [], sel: 0, node: null };
let linker = { open: false, start: 0, query: "", items: [], sel: 0, node: null };

/* ------------------------------------------------------------------ utils */

function toast(message, kind = "") {
  const node = document.createElement("div");
  node.className = "toast" + (kind ? " " + kind : "");
  node.textContent = message;
  $("#toasts").appendChild(node);
  setTimeout(() => {
    node.style.transition = "opacity .2s";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 250);
  }, kind === "error" ? 5200 : 2400);
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
function fmtDate(ns) {
  if (!ns) return "";
  const d = new Date(ns / 1e6);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 1970) return "";
  return dateFmt.format(d);
}
function fmtTime(ns) {
  if (!ns) return "";
  const d = new Date(ns / 1e6);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return fmtDate(ns);
}

function dirOf(p) {
  const i = (p || "").lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}
function baseName(p) {
  const s = (p || "").split("/").pop() || "";
  return s.replace(/\.md$/i, "");
}
function titleOf(p) {
  return baseName(p);
}
function joinPath(dir, rel) {
  if (!dir) return rel;
  return dir + "/" + rel;
}
function resolveRel(baseDir, target) {
  const parts = baseDir ? baseDir.split("/") : [];
  const t = String(target).replace(/^\.\//, "");
  for (const seg of t.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg && seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
function mdCtx() {
  return {
    hasTitle: (t) => state.knownTitles.has(t.trim().toLowerCase()),
    fileUrl: (rel) => fileUrl(resolveRel(dirOf(state.page?.path || ""), rel)),
  };
}

/* --------------------------------------------------------------- boot/app */

// Matches vault.DatabaseIcon: the marker the server uses for a database with no
// icon of its own. It renders as a stroke glyph so it sits next to the file
// icons instead of looking like a gray blob.
const DB_ICON = "▦";

/** HTML for a page icon: user emoji, else the database glyph, else a file. */
function pageGlyph(ic) {
  if (!ic) return icon("file");
  if (ic === DB_ICON) return icon("database");
  return escapeHtml(ic);
}

async function init() {
  cacheEls();
  applyTheme(localStorage.getItem("not1-theme") || "light");
  bindChrome();
  bindEditor();
  bindShortcuts();
  try {
    const data = await api("/api/bootstrap");
    onWorkspaceData(data);
  } catch (err) {
    toast(err.message, "error");
  }
  connectEvents();
}

function cacheEls() {
  el.editor = $("#editor");
  el.title = $("#page-title");
  el.page = $("#page");
  el.preview = $("#preview");
  el.scroller = $("#scroller");
  el.banner = $("#banner");
  el.backlinks = $("#backlinks");
  el.tree = $("#tree");
  el.sideRecent = $("#side-recent");
  el.crumbs = $("#crumbs");
  el.saveState = $("#save-state");
  el.pageIcon = $("#page-icon");
  el.meta = $("#page-meta");
  el.pageMenu = $("#page-menu");
  el.db = $("#db-view");
}

function applyTheme(theme) {
  state.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  localStorage.setItem("not1-theme", state.theme);
  const btn = $("#theme-btn");
  if (btn) {
    btn.innerHTML = icon(state.theme === "dark" ? "sun" : "moon");
    btn.title = state.theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
  }
}

function toggleTheme() {
  applyTheme(state.theme === "dark" ? "light" : "dark");
  api("/api/config", { method: "POST", body: { theme: state.theme } }).catch(() => {});
}

function onWorkspaceData(data) {
  state.needsWorkspace = !!data.needsWorkspace;
  state.workspace = data.workspace || "";
  state.tree = data.tree || null;
  state.icons = data.icons || {};
  state.theme = data.theme || state.theme;
  state.recentPages = data.recentPages || [];
  state.recentWorkspaces = data.recentWorkspaces || [];
  state.pageCount = data.pageCount || 0;
  if (data.sidebarWidth) setSidebarWidth(data.sidebarWidth, false);
  applyTheme(state.theme);
  $("#ws-name").textContent = state.workspace ? baseName(state.workspace) : "not1";
  $("#ws-avatar").textContent = state.workspace ? baseName(state.workspace).slice(0, 1).toUpperCase() : "n";
  $("#page-count").textContent = state.pageCount ? `${state.pageCount} page${state.pageCount === 1 ? "" : "s"}` : "";

  if (state.needsWorkspace) {
    state.page = null;
    showWelcome();
    return;
  }
  loadExpanded();
  refreshTree(true);
  $("#welcome").classList.add("hidden");
  renderSideRecent();
  renderCrumbs();
  const fromHash = hashPath();
  const target = fromHash || state.recentPages[0]?.path;
  if (target) openPage(target, { force: true });
  else showEmpty();
}

function hashPath() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ""));
  return h || "";
}

/* -------------------------------------------------------------- workspace */

function setTitle(title) {
  document.title = title ? `${title} — not1` : "not1";
  if (typeof window.not1SetTitle === "function") {
    try {
      Promise.resolve(window.not1SetTitle(document.title)).catch(() => {});
    } catch (_) {}
  }
}

function setChrome({ workspace, page }) {
  document.body.classList.toggle("no-workspace", !workspace);
  document.body.classList.toggle("no-page", !page);
}

function showWelcome() {
  setTitle("");
  const w = $("#welcome");
  w.classList.remove("hidden");
  $("#page").classList.add("hidden");
  $("#empty").classList.add("hidden");
  setChrome({ workspace: false, page: false });
  const recents = state.recentWorkspaces || [];
  w.innerHTML = `
    <div class="logo">n</div>
    <h1>Your notes, as files.</h1>
    <p>not1 is a quiet home for a folder of markdown on your disk.<br/>No lock-in, no sync, no accounts.</p>
    <div class="open-row">
      <button class="btn-primary" id="open-folder">Open a folder…</button>
      <input class="path-input" id="ws-path" placeholder="or paste a path, e.g. ~/Notes" spellcheck="false" />
    </div>
    <p class="hint">Markdown stays readable in any editor. Search, links and backlinks<br/>are indexed locally in <code>.not1/</code>.</p>
    ${
      recents.length
        ? `<div class="recent"><h4>Recent folders</h4>${recents
            .map(
              (p) =>
                `<button data-open-ws="${escapeHtml(p)}">${icon("folder")}<span>${escapeHtml(
                  baseName(p)
                )}</span><span class="path">${escapeHtml(p)}</span></button>`
            )
            .join("")}</div>`
        : ""
    }`;
  w.querySelector("#open-folder").onclick = pickFolder;
  const input = w.querySelector("#ws-path");
  const submit = () => {
    const v = input.value.trim();
    if (v) openWorkspace(v);
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter") submit();
  };
  input.onpaste = (e) => {
    const text = e.clipboardData?.getData("text");
    if (text) {
      e.preventDefault();
      input.value = text.trim();
      submit();
    }
  };
  $$("[data-open-ws]", w).forEach((b) => {
    b.onclick = () => openWorkspace(b.dataset.openWs);
  });
  setTimeout(() => $("#open-folder")?.focus(), 40);
}

function showEmpty() {
  $("#welcome").classList.add("hidden");
  $("#page").classList.add("hidden");
  $("#empty").classList.remove("hidden");
  setChrome({ workspace: true, page: false });
  setTitle(state.workspace ? state.workspace.split("/").filter(Boolean).pop() : "");
  const recent = state.recentPages || [];
  $("#empty").innerHTML = `
    <h2>Nothing open</h2>
    <p>Pick a page in the sidebar, or start something new.</p>
    <div class="row">
      <button class="btn-primary" id="empty-new">New page</button>
      <button class="btn-ghost" id="empty-search">Search</button>
    </div>
    ${
      recent.length
        ? `<div class="recent" style="margin-top:26px;text-align:left"><h4>Recently edited</h4>${recent
            .slice(0, 6)
            .map(
              (r) =>
                `<button data-open-page="${escapeHtml(r.path)}">${icon("file")}<span>${escapeHtml(
                  r.title
                )}</span><span class="path">${escapeHtml(r.dir || "")}</span></button>`
            )
            .join("")}</div>`
        : ""
    }`;
  $("#empty-new").onclick = () => createPage();
  $("#empty-search").onclick = () => openPalette();
  $$("[data-open-page]", $("#empty")).forEach((b) => {
    b.onclick = () => openPage(b.dataset.openPage);
  });
  renderCrumbs();
  updateSaveState("");
}

async function pickFolder() {
  try {
    const res = await api("/api/workspace/pick", { method: "POST", body: {} });
    if (res.cancelled || !res.path) return;
    await openWorkspace(res.path);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function openWorkspace(path) {
  try {
    const data = await api("/api/workspace", { method: "POST", body: { path } });
    state.page = null;
    state.dirty = false;
    state.expanded = new Set();
    onWorkspaceData(data);
    toast(`Opened ${baseName(data.workspace)}`);
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ------------------------------------------------------------------ tree */

function loadExpanded() {
  try {
    const raw = localStorage.getItem("not1-expanded:" + state.workspace);
    state.expanded = new Set(raw ? JSON.parse(raw) : []);
  } catch {
    state.expanded = new Set();
  }
}
function saveExpanded() {
  localStorage.setItem("not1-expanded:" + state.workspace, JSON.stringify([...state.expanded]));
}

function indexTitles() {
  state.knownTitles = new Map();
  const add = (key, path) => {
    const k = key.trim().toLowerCase();
    if (k && !state.knownTitles.has(k)) state.knownTitles.set(k, path);
  };
  const walk = (nodes) => {
    for (const n of nodes || []) {
      if (n.dir) walk(n.children);
      else {
        add(n.name, n.path);
        add(n.path, n.path);
        add(n.path.replace(/\.md$/i, ""), n.path);
        add(n.name + ".md", n.path);
      }
    }
  };
  walk(state.tree?.children);
}

async function refreshTree(rerender = false) {
  if (!state.workspace) return;
  try {
    const data = await api("/api/tree");
    state.tree = data.tree;
    if (data.icons) state.icons = data.icons;
    resetPageRefsCache();
    indexTitles();
    state.pageCount = countPages(state.tree);
    $("#page-count").textContent = state.pageCount
      ? `${state.pageCount} page${state.pageCount === 1 ? "" : "s"}`
      : "";
    if (rerender) renderTree();
    else renderTree();
    renderSideRecent();
    renderCrumbs();
  } catch (err) {
    /* transient */
  }
}

function countPages(node) {
  let n = 0;
  for (const c of node?.children || []) n += c.dir ? countPages(c) : 1;
  return n;
}

function renderTree() {
  el.tree.innerHTML = "";
  if (!state.tree?.children?.length) {
    const hint = document.createElement("div");
    hint.style.cssText = "padding:10px 8px;color:var(--text-faint);font-size:12.5px;line-height:1.5";
    hint.textContent = "No pages yet. Create one to get started.";
    el.tree.appendChild(hint);
    return;
  }
  const frag = document.createDocumentFragment();
  const walk = (nodes, depth) => {
    for (const n of nodes) {
      const row = document.createElement("div");
      row.className = "tree-row";
      row.dataset.path = n.path;
      row.dataset.dir = n.dir ? "1" : "0";
      row.style.paddingLeft = depth * 13 + 2 + "px";
      row.draggable = !n.dir;
      const open = n.dir && state.expanded.has(n.path);
      if (open) row.classList.add("open");
      if (!n.dir && state.page?.path === n.path) row.classList.add("active");
      row.innerHTML = `${
        n.dir
          ? `<button class="twisty" aria-label="Toggle folder">${icon("chevron-right")}</button>`
          : '<span style="width:18px;flex:0 0 auto"></span>'
      }<span class="row-icon">${
        n.dir ? icon(open ? "folder-open" : "folder") : pageGlyph(state.icons[n.path])
      }</span><span class="row-label"></span><button class="row-more" data-opens-menu="1" aria-label="Page options">${icon(
        "more"
      )}</button>`;
      row.querySelector(".row-label").textContent = n.name;
      frag.appendChild(row);
      if (n.dir && open) walk(n.children || [], depth + 1);
    }
  };
  walk(state.tree.children, 0);
  el.tree.appendChild(frag);
}

function renderSideRecent() {
  if (!el.sideRecent) return;
  const pages = state.recentPages || [];
  if (!pages.length || state.needsWorkspace) {
    el.sideRecent.innerHTML = "";
    return;
  }
  el.sideRecent.innerHTML =
    `<div class="side-label">Recent</div>` +
    pages
      .slice(0, 5)
      .map(
        (p) =>
          `<div class="tree-row" data-recent="${escapeHtml(p.path)}" title="${escapeHtml(p.path)}">
             <span style="width:18px;flex:0 0 auto"></span>
             <span class="row-icon">${pageGlyph(p.icon)}</span>
             <span class="row-label">${escapeHtml(p.title)}</span>
           </div>`
      )
      .join("");
  $$("[data-recent]", el.sideRecent).forEach((row) => {
    row.onclick = () => openPage(row.dataset.recent);
  });
}

function toggleFolder(path) {
  if (state.expanded.has(path)) state.expanded.delete(path);
  else state.expanded.add(path);
  saveExpanded();
  renderTree();
}

function markActiveRow() {
  $$(".tree-row[data-path]", el.tree).forEach((row) => {
    row.classList.toggle("active", !state.page ? false : row.dataset.path === state.page.path);
  });
}

/* -------------------------------------------------------------- open page */

async function openPage(path, { force = false } = {}) {
  if (!path) return;
  if (state.dirty && !force) {
    await savePage();
  }
  const seq = ++state.openSeq;
  try {
    const data = await api("/api/page?path=" + encodeURIComponent(path));
    if (seq !== state.openSeq) return;
    state.page = data.page;
    state.backlinks = data.backlinks || [];
    state.dirty = false;
    state.conflict = false;
    hideBanner();
    state.saveTimer && clearTimeout(state.saveTimer);
    state.saveTimer = 0;
    renderPage();
    markActiveRow();
    history.replaceState(null, "", "#" + encodeURI(data.page.path));
    el.scroller.scrollTop = 0;
    updateSaveState("");
  } catch (err) {
    if (err instanceof ApiError && err.code === "not_found") {
      toast("That page no longer exists", "error");
      await refreshTree();
      showEmpty();
    } else {
      toast(err.message, "error");
    }
  }
}

async function reloadFromDisk() {
  if (!state.page) return;
  const keepScroll = el.scroller.scrollTop;
  try {
    const data = await api("/api/page?path=" + encodeURIComponent(state.page.path));
    state.page = data.page;
    state.backlinks = data.backlinks || [];
    state.dirty = false;
    state.conflict = false;
    hideBanner();
    renderPage();
    el.scroller.scrollTop = keepScroll;
    toast("Reloaded from disk");
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderPage() {
  const p = state.page;
  if (!p) {
    showEmpty();
    return;
  }
  $("#welcome").classList.add("hidden");
  $("#empty").classList.add("hidden");
  el.page.classList.remove("hidden");
  $("#topbar").classList.remove("hidden");
  setChrome({ workspace: true, page: !!p });

  el.title.textContent = p.title || "";
  el.title.dataset.placeholder = "Untitled";
  setTitle(p.title || "Untitled");

  // A database without an icon of its own still reads as a database.
  const pageIcon = p.icon || (p.type === "database" ? DB_ICON : "");
  if (pageIcon) {
    el.pageIcon.innerHTML = pageGlyph(pageIcon);
    el.pageIcon.classList.remove("empty");
  } else {
    el.pageIcon.textContent = "＋ icon";
    el.pageIcon.classList.add("empty");
  }

  const isDb = p.type === "database";
  document.body.classList.toggle("is-db", isDb);
  $("#mode-seg").classList.toggle("hidden", isDb);
  if (isDb) {
    $("#write-wrap").classList.add("hidden");
    el.preview.classList.add("hidden");
    el.backlinks.classList.add("hidden");
    renderMeta();
    renderCrumbs();
    renderDbDescription();
    showDatabase();
    return;
  }
  el.db.classList.add("hidden");
  el.db.innerHTML = "";
  $("#db-desc").classList.add("hidden");
  state.db = null;
  state.dbView = null;

  el.editor.value = p.body || "";
  renderPreview();
  setTimeout(() => autoResize(el.editor), 0);
  renderMeta();
  renderBacklinks();
  renderCrumbs();
  setMode(state.readMode ? "read" : "write", false);
}

// A database page shows a view over a folder instead of a text body. The
// definition (source, fields, view) is that page's frontmatter, so the view is
// saved with the file and survives a rebuild of the index.
async function showDatabase() {
  const seq = state.openSeq;
  el.db.classList.remove("hidden");
  el.db.innerHTML = '<div class="db-loading">Loading…</div>';
  try {
    const db = await fetchDatabase(state.page.path);
    if (seq !== state.openSeq || !state.page || state.page.type !== "database") return;
    state.db = db;
    state.dbView = renderDatabase(el.db, db, dbCtx());
  } catch (err) {
    el.db.innerHTML = "";
    toast(err.message, "error");
  }
}

// The page body of a database is its description: visible above the view,
// click to edit, saved through the normal page save path.
function renderDbDescription() {
  const node = $("#db-desc");
  const body = state.page?.body || "";
  node.classList.remove("editing");
  node.classList.toggle("hidden", !body.trim());
  node.innerHTML = body.trim() ? renderMarkdown(body, mdCtx()) : "";
  node.onclick = () => editDbDescription(node);
}

function editDbDescription(node) {
  if (node.classList.contains("editing")) return;
  node.classList.add("editing");
  node.onclick = null;
  const ta = document.createElement("textarea");
  ta.className = "db-desc-input";
  ta.value = state.page.body || "";
  ta.placeholder = "Add a description…";
  ta.spellcheck = true;
  node.innerHTML = "";
  node.appendChild(ta);
  autoResize(ta);
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  ta.oninput = () => {
    state.page.body = ta.value;
    markDirtyAndSave();
    autoResize(ta);
  };
  ta.onblur = () => renderDbDescription();
}

function dbCtx() {
  return {
    openPage: (p) => openPage(p),
    toast,
    current: () => !!state.page && state.page.type === "database" && state.page.path === state.db?.path,
    refreshTree: () => {
      refreshTree(false);
    },
    deleteRow: async (row) => {
      await deletePath(row.path, false);
      await state.db?._refresh?.();
    },
  };
}

function renderPreview() {
  const body = state.page?.body || "";
  el.preview.innerHTML = body.trim()
    ? renderMarkdown(body, mdCtx())
    : '<p class="empty-doc">This page is empty.</p>';
}

function renderMeta() {
  const p = state.page;
  if (!p) {
    el.meta.innerHTML = "";
    return;
  }
  const words = (p.body || "").trim() ? (p.body.trim().match(/\S+/g) || []).length : 0;
  const chips = [];
  chips.push(`<span>Edited ${fmtDate(p.updated)}</span>`);
  if (p.created && Math.abs(p.created - p.updated) > 60e9) {
    chips.push(`<span class="dot">·</span><span>Created ${fmtDate(p.created)}</span>`);
  }
  chips.push(`<span class="dot">·</span><span>${words} word${words === 1 ? "" : "s"}</span>`);
  (p.tags || []).forEach((t) => chips.push(`<span class="chip">#${escapeHtml(t)}</span>`));
  el.meta.innerHTML = chips.join(" ");
}

function renderBacklinks() {
  const refs = state.backlinks || [];
  if (!refs.length) {
    el.backlinks.classList.add("hidden");
    return;
  }
  el.backlinks.classList.remove("hidden");
  el.backlinks.innerHTML =
    `<h3>Linked references</h3>` +
    refs
      .map(
        (r) =>
          `<button class="backlink" data-path="${escapeHtml(r.path)}">${
            r.icon ? `<span>${escapeHtml(r.icon)}</span>` : icon("file")
          }<span>${escapeHtml(r.title)}</span></button>`
      )
      .join("");
  $$(".backlink", el.backlinks).forEach((b) => {
    b.onclick = () => openPage(b.dataset.path);
  });
}

function renderCrumbs() {
  if (!state.page) {
    el.crumbs.innerHTML = state.workspace
      ? `<button data-dir="">${icon("folder")}<span style="margin-left:6px">${escapeHtml(
          baseName(state.workspace)
        )}</span></button>`
      : "";
    return;
  }
  const parts = state.page.path.split("/");
  const segs = [];
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? acc + "/" + parts[i] : parts[i];
    segs.push({ label: parts[i], path: acc });
  }
  el.crumbs.innerHTML =
    segs
      .map(
        (s) =>
          `<button data-dir="${escapeHtml(s.path)}">${escapeHtml(s.label)}</button><span class="sep">/</span>`
      )
      .join("") +
    `<span class="crumb-current">${escapeHtml(state.page.title || "Untitled")}</span>`;
  $$("[data-dir]", el.crumbs).forEach((b) => {
    b.onclick = () => {
      const p = b.dataset.dir;
      const parts2 = p.split("/");
      let acc2 = "";
      for (const seg of parts2) {
        acc2 = acc2 ? acc2 + "/" + seg : seg;
        state.expanded.add(acc2);
      }
      saveExpanded();
      renderTree();
      const row = el.tree.querySelector(`.tree-row[data-path="${CSS.escape(p)}"]`);
      row?.scrollIntoView({ block: "nearest" });
    };
  });
}

/* ------------------------------------------------------------------ modes */

function setMode(mode, persist = true) {
  state.readMode = mode === "read";
  if (persist) localStorage.setItem("not1-mode", mode);
  $$(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === mode));
  const hasPage = !!state.page;
  $("#write-wrap").classList.toggle("hidden", !hasPage || state.readMode);
  el.preview.classList.toggle("hidden", !hasPage || !state.readMode);
  if (state.readMode) renderPreview();
  else if (hasPage) setTimeout(() => autoResize(el.editor), 0);
}

function toggleMode() {
  if (state.page?.type === "database") return;
  if (!state.page) return;
  setMode(state.readMode ? "write" : "read");
}

/* ------------------------------------------------------------------- save */

function updateSaveState(kind) {
  const map = { saving: "Saving…", saved: "Saved", error: "Not saved", conflict: "Conflict" };
  el.saveState.textContent = map[kind] || "";
  el.saveState.style.color = kind === "error" || kind === "conflict" ? "#eb5757" : "";
}

function scheduleSave(delay = 650) {
  state.dirty = true;
  updateSaveState("saving");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => savePage(), delay);
}

function currentPayload(force) {
  const p = state.page;
  return {
    path: p.path,
    title: p.title || "",
    icon: p.icon || "",
    tags: p.tags || [],
    body: p.body || "",
    expectMod: force ? 0 : p.modTime,
  };
}

async function savePage({ force = false } = {}) {
  if (!state.page) return;
  if (state.saving) {
    state.saveAgain = true;
    return;
  }
  clearTimeout(state.saveTimer);
  state.saveTimer = 0;
  state.saving = true;
  const payload = currentPayload(force);
  const prevPath = payload.path;
  try {
    const res = await api("/api/page", { method: "PUT", body: payload });
    // A newer page may have been opened while this request was in flight.
    if (state.page && state.page.path === prevPath) {
      state.page = {
        ...state.page,
        ...res.page,
        body: state.page.body,
      };
      if (res.renamed) {
        history.replaceState(null, "", "#" + encodeURI(res.page.path));
        await refreshTree();
        if (state.db && state.page.type === "database") {
          state.db.path = res.page.path;
          state.db._refresh?.();
        }
      }
      state.backlinks = res.backlinks || [];
      state.dirty = false;
      state.conflict = false;
      hideBanner();
      updateSaveState("saved");
      renderMeta();
      renderBacklinks();
      renderCrumbs();
      markActiveRow();
      state.recentPages = [
        { path: res.page.path, title: res.page.title, dir: dirOf(res.page.path), updated: res.page.updated },
        ...state.recentPages.filter((r) => r.path !== res.page.path && r.path !== prevPath),
      ].slice(0, 10);
      renderSideRecent();
    }
  } catch (err) {
    if (err instanceof ApiError && err.code === "conflict") {
      updateSaveState("conflict");
      showConflict();
    } else {
      updateSaveState("error");
      toast(err.message, "error");
    }
  } finally {
    state.saving = false;
    if (state.saveAgain) {
      state.saveAgain = false;
      if (state.dirty) savePage();
    }
  }
}

function showConflict() {
  el.banner.classList.remove("hidden");
  el.banner.innerHTML = `<span>This file was changed on disk.</span><span class="spacer"></span>
    <button data-act="reload">Reload file</button>
    <button data-act="keep">Keep my version</button>`;
  el.banner.querySelector('[data-act="reload"]').onclick = () => reloadFromDisk();
  el.banner.querySelector('[data-act="keep"]').onclick = () => savePage({ force: true });
}

function hideBanner() {
  el.banner.classList.add("hidden");
  el.banner.innerHTML = "";
}

/* --------------------------------------------------------------- bindings */

function bindChrome() {
  $("#collapse-btn").innerHTML = icon("panel");
  $("#show-sidebar").innerHTML = icon("panel");
  $("#page-menu").innerHTML = icon("more");
  $("#reveal-btn").innerHTML = icon("folder-open");
  $("#theme-btn").innerHTML = icon("moon");
  $("#collapse-btn").onclick = () => setSidebar(false);
  $("#show-sidebar").onclick = () => setSidebar(true);
  $("#theme-btn").onclick = toggleTheme;
  $("#reveal-btn").onclick = () =>
    api("/api/reveal", { method: "POST", body: { path: "" } }).catch((e) => toast(e.message, "error"));
  $("#search-btn").onclick = () => openPalette();
  $("#new-page-btn").onclick = () => createPage();
  $("#new-folder-btn").onclick = () => createFolder();
  $("#page-menu").dataset.opensMenu = "1";
  $("#ws-btn").dataset.opensMenu = "1";
  $("#page-menu").onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openPageMenu(r.right - 210, r.bottom + 4, state.page?.path);
  };
  $("#ws-btn").onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    openWorkspaceMenu(r.left, r.bottom + 4);
  };
  $$(".seg-btn").forEach((b) => {
    b.onclick = () => setMode(b.dataset.mode);
  });

  el.tree.addEventListener("click", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row) return;
    const path = row.dataset.path;
    const isDir = row.dataset.dir === "1";
    if (e.target.closest(".row-more")) {
      const r = e.target.closest(".row-more").getBoundingClientRect();
      openPageMenu(r.right - 200, r.bottom + 4, path, isDir);
      return;
    }
    if (isDir) toggleFolder(path);
    else openPage(path);
  });
  el.tree.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row) return;
    e.preventDefault();
    openPageMenu(e.clientX, e.clientY, row.dataset.path, row.dataset.dir === "1");
  });
  // drag pages onto folders
  el.tree.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".tree-row");
    if (!row) return;
    e.dataTransfer.setData("text/not1-path", row.dataset.path);
    e.dataTransfer.effectAllowed = "move";
  });
  const isDropRow = (t) => {
    const row = t.closest?.(".tree-row");
    return row && (row.dataset.dir === "1" || row.dataset.path === "");
  };
  el.tree.addEventListener("dragover", (e) => {
    const row = isDropRow(e.target);
    if (!row) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    $$(".tree-row.drop-target", el.tree).forEach((r) => r.classList.remove("drop-target"));
    row.classList.add("drop-target");
  });
  el.tree.addEventListener("dragleave", () => {
    $$(".tree-row.drop-target", el.tree).forEach((r) => r.classList.remove("drop-target"));
  });
  el.tree.addEventListener("drop", async (e) => {
    const row = isDropRow(e.target);
    if (!row) return;
    e.preventDefault();
    row.classList.remove("drop-target");
    const src = e.dataTransfer.getData("text/not1-path");
    if (!src) return;
    try {
      const res = await api("/api/move", { method: "POST", body: { path: src, dir: row.dataset.path } });
      state.expanded.add(row.dataset.path);
      saveExpanded();
      await refreshTree();
      if (state.page?.path === src) {
        state.page.path = res.page.path;
        history.replaceState(null, "", "#" + encodeURI(res.page.path));
      }
      toast(`Moved to ${row.dataset.path || "workspace"}`);
    } catch (err) {
      toast(err.message, "error");
    }
  });

  el.pageIcon.dataset.opensMenu = "1";
  el.pageIcon.onclick = (e) => {
    if (!state.page) return;
    const r = e.currentTarget.getBoundingClientRect();
    openEmojiPicker(r.left, r.bottom + 6);
  };
  el.title.addEventListener("input", () => {
    if (!state.page) return;
    const t = el.title.textContent.replace(/\u200b/g, "").replace(/\n/g, " ").trim();
    state.page.title = t;
    setTitle(t || "Untitled");
    scheduleSave(900);
  });
  el.title.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      el.title.blur();
    }
  });
  el.title.addEventListener("blur", () => {
    if (!state.page) return;
    if (!el.title.textContent.trim()) {
      el.title.textContent = "Untitled";
      state.page.title = "Untitled";
    }
    if (state.dirty) savePage();
  });
  el.title.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData?.getData("text") || "").replace(/\s+/g, " ");
    document.execCommand("insertText", false, text);
  });

  $("#resizer").addEventListener("mousedown", (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = state.sidebarWidth;
    const move = (ev) => {
      const w = Math.min(460, Math.max(200, startW + ev.clientX - startX));
      setSidebarWidth(w, false);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      api("/api/config", { method: "POST", body: { sidebarWidth: state.sidebarWidth } }).catch(() => {});
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  $("#resizer").addEventListener("dblclick", () => {
    setSidebarWidth(264, true);
  });

  document.addEventListener("click", (e) => {
    if (menu && !menu.contains(e.target) && !e.target.closest("[data-opens-menu]")) closeMenu();
    if (slash.open && slash.node && !slash.node.contains(e.target) && e.target !== el.editor) closeSlash();
    if (linker.open && linker.node && !linker.node.contains(e.target) && e.target !== el.editor) closeLinker();
  });
  window.addEventListener("resize", () => {
    if (slash.open) closeSlash();
    if (linker.open) closeLinker();
    if (state.page && !state.readMode) autoResize(el.editor);
  });

  setMode(localStorage.getItem("not1-mode") === "write" ? "write" : "read", false);

  window.addEventListener("beforeunload", () => {
    if (state.dirty && state.page) {
      try {
        fetch(`/api/page?t=${encodeURIComponent(TOKEN)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(currentPayload(false)),
          keepalive: true,
        });
      } catch {}
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && state.dirty) savePage();
  });
}

function setSidebar(open) {
  document.body.classList.toggle("sidebar-hidden", !open);
  $("#show-sidebar").classList.toggle("hidden", open);
  localStorage.setItem("not1-sidebar", open ? "1" : "0");
  setTimeout(() => {
    if (state.page && !state.readMode) autoResize(el.editor);
  }, 200);
}

function setSidebarWidth(w, persist = true) {
  state.sidebarWidth = w;
  document.documentElement.style.setProperty("--sidebar-w", w + "px");
  if (persist) api("/api/config", { method: "POST", body: { sidebarWidth: w } }).catch(() => {});
}

/** Cell edits rewrite the body, so the textarea has to follow along. */
function commitBody(next) {
  if (!state.page || next === state.page.body) return;
  state.page.body = next;
  el.editor.value = next;
  autoResize(el.editor);
  scheduleSave();
}

function bindEditor() {
  const ta = el.editor;

  // Files dragged in from Finder become attachments, not a URL and not lost.
  for (const zone of [el.preview, ta, $("#write-wrap")].filter(Boolean)) {
    zone.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types?.includes("Files") || !state.page) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      zone.classList.add("drop-file");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drop-file"));
    zone.addEventListener("drop", (e) => {
      const files = [...(e.dataTransfer?.files || [])];
      zone.classList.remove("drop-file");
      if (!files.length || !state.page) return;
      e.preventDefault();
      if (state.readMode) setMode(false);
      dropFiles(files, caretTarget());
    });
  }
  el.editor.maxLength = 10_000_000;
  initCells({
    source: () => state.page?.body ?? "",
    render: (md) => renderInline(md, mdCtx()),
    commit: commitBody,
    // Re-render after a row/column change, keeping the reader where they were.
    refresh: () => {
      const y = el.scroller.scrollTop;
      renderPreview();
      el.scroller.scrollTop = y;
    },
    menu: (x, y, items) => openMenu(x, y, items, { className: "popover table-menu", search: true }),
  });
  ta.addEventListener("input", () => {
    if (!state.page) return;
    state.page.body = ta.value;
    autoResize(ta);
    if (!updateLinkerFromInput()) updateSlashFromInput();
    scheduleSave();
    if (state.readMode) renderPreview();
  });
  ta.addEventListener("keydown", onEditorKeydown);
  ta.addEventListener("paste", (e) => {
    const text = e.clipboardData?.getData("text") || "";
    const s = ta.selectionStart;
    const selected = ta.value.slice(s, ta.selectionEnd);
    if (selected && /^https?:\/\/\S+$/i.test(text.trim())) {
      e.preventDefault();
      ta.setRangeText(`[${selected}](${text.trim()})`, s, ta.selectionEnd, "end");
      ta.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  el.preview.addEventListener("contextmenu", (e) => {
    const cell = e.target.closest(".md td[data-line], .md th[data-line]");
    // While a cell is open the pointer belongs to that cell, not to the row.
    if (!cell || !state.readMode || document.querySelector("td.cell-editing")) return;
    e.preventDefault();
    closeMenu();
    openCellMenu(cell, { x: e.clientX, y: e.clientY });
  });
  // The Notion-style drag handle: one handle that tracks the hovered row.
  el.preview.addEventListener("mousemove", (e) => {
    if (!state.readMode) return hideRowGrip();
    // The header row is a column; body rows are rows.
    const th = e.target.closest(".md th[data-line]");
    if (th) return showColGrip(th);
    const td = e.target.closest(".md td[data-line]");
    if (td) return showRowGrip(td);
    scheduleGripHide();
  });
  el.preview.addEventListener("mouseleave", () => scheduleGripHide());
  el.scroller.addEventListener("scroll", () => hideRowGrip(), { passive: true });

  el.preview.addEventListener("click", async (e) => {
    const codeBtn = e.target.closest(".md-code-copy, .md-code-lang");
    if (codeBtn) {
      e.preventDefault();
      if (codeBtn.classList.contains("md-code-copy")) copyCode(codeBtn);
      else openCodeLangMenu(codeBtn);
      return;
    }
    const fileCard = e.target.closest("[data-file]");
    if (fileCard) {
      e.preventDefault();
      openVaultFile(resolveRel(dirOf(state.page?.path || ""), fileCard.dataset.file));
      return;
    }
    const check = e.target.closest('input[type="checkbox"][data-task]');
    if (check) {
      const idx = Number(check.dataset.task);
      state.page.body = toggleTask(state.page.body, idx);
      el.editor.value = state.page.body;
      markDirtyAndSave();
      renderPreview();
      return;
    }
    const wiki = e.target.closest("[data-wiki]");
    if (wiki) {
      e.preventDefault();
      openWiki(wiki.dataset.wiki);
      return;
    }
    const md = e.target.closest("[data-md]");
    if (md) {
      e.preventDefault();
      const target = resolveRel(dirOf(state.page?.path || ""), md.dataset.md);
      openPage(target);
      return;
    }
    const ext = e.target.closest("[data-external]");
    if (ext) {
      e.preventDefault();
      api("/api/open-external", { method: "POST", body: { url: ext.getAttribute("href") } }).catch((err) =>
        toast(err.message, "error")
      );
      return;
    }
    // A rendered table cell knows which markdown cell it came from, so clicking
    // it edits that cell in place (see cells.js).
    const mdCell = e.target.closest(".md td[data-line], .md th[data-line]");
    if (mdCell) {
      if (state.readMode) startCellEdit(mdCell, { x: e.clientX, y: e.clientY });
      return;
    }
    if (e.target.closest("a, button, input, img, video, audio, pre, code, table, .md-code, .md-file")) return;
    if (state.readMode) {
      setMode("write");
      el.editor.focus();
      // Put the caret at the end rather than at an arbitrary spot mid-text.
      const n = el.editor.value.length;
      el.editor.setSelectionRange(n, n);
    }
  });
}

function markDirtyAndSave() {
  state.dirty = true;
  autoResize(el.editor);
  scheduleSave();
}

function openWiki(target) {
  const t = String(target).trim();
  const path =
    state.knownTitles.get(t.toLowerCase()) ||
    state.knownTitles.get(t.slice(t.lastIndexOf("/") + 1).toLowerCase());
  if (path) {
    openPage(path);
    return;
  }
  api("/api/resolve?target=" + encodeURIComponent(target))
    .then((res) => {
      if (res.found) openPage(res.path);
      else toast(`No page named “${target}”`, "error");
    })
    .catch((err) => toast(err.message, "error"));
}

function onEditorKeydown(e) {
  const ta = el.editor;
  if (linker.open) {
    const n = linker.items.length;
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      if (n) linker.sel = (linker.sel + 1) % n;
      renderLinkerSelection();
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      if (n) linker.sel = (linker.sel - 1 + n) % n;
      renderLinkerSelection();
      return;
    }
    if (e.key === "Enter") {
      // With nothing to pick, let the newline through instead of eating it.
      if (linker.items.length) {
        e.preventDefault();
        applyLinker(linker.items[linker.sel]);
        return;
      }
      closeLinker();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeLinker();
      return;
    }
  }
  if (slash.open) {
    if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) {
      e.preventDefault();
      slash.sel = (slash.sel + 1) % slash.items.length;
      renderSlashSelection();
      return;
    }
    if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) {
      e.preventDefault();
      slash.sel = (slash.sel - 1 + slash.items.length) % slash.items.length;
      renderSlashSelection();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      applySlash(slash.items[slash.sel]);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeSlash();
      return;
    }
  }

  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey) {
    const k = e.key.toLowerCase();
    if (k === "b") {
      e.preventDefault();
      wrapSelection(ta, "**", "**", "bold");
      return;
    }
    if (k === "i") {
      e.preventDefault();
      wrapSelection(ta, "*", "*", "italic");
      return;
    }
    if (k === "k") {
      e.preventDefault();
      wrapSelection(ta, "[", "](url)", "text");
      return;
    }
    if (k === "`") {
      e.preventDefault();
      wrapSelection(ta, "`", "`", "code");
      return;
    }
  }
  if (e.key === "Tab") {
    e.preventDefault();
    indentSelection(ta, e.shiftKey);
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    if (handleEnter(ta, e)) {
      updateSlashFromInput();
      return;
    }
  }
  if (e.key === "Escape" && state.dirty) {
    // no-op: keep edits safe
  }
}

/* --------------------------------------------------------------- slash UI */

const SLASH_ITEMS = [
  { key: "h1", label: "Heading 1", desc: "Title", icon: "H1", template: "# ", match: ["h1", "heading", "title", "#"] },
  { key: "h2", label: "Heading 2", desc: "Section", icon: "H2", template: "## ", match: ["h2", "heading", "##"] },
  { key: "h3", label: "Heading 3", desc: "Subsection", icon: "H3", template: "### ", match: ["h3", "heading", "###"] },
  { key: "bullet", label: "Bulleted list", desc: "•", icon: "•", template: "- ", match: ["bullet", "list", "ul", "-"] },
  { key: "number", label: "Numbered list", desc: "1.", icon: "1.", template: "1. ", match: ["number", "ordered", "list", "ol"] },
  {
    key: "todo",
    label: "To-do",
    desc: "Checkbox",
    icon: "☑",
    template: "- [ ] ",
    match: ["todo", "task", "checkbox", "check"],
  },
  { key: "quote", label: "Quote", desc: "│", icon: "❝", template: "> ", match: ["quote", "blockquote", ">"] },
  {
    key: "callout",
    label: "Callout",
    desc: "Highlighted note",
    icon: "💡",
    template: "> [!note]\n> ",
    caret: 13,
    match: ["callout", "note", "tip", "warning"],
  },
  {
    key: "code",
    label: "Code block",
    desc: "```",
    icon: "</>",
    template: "```\n\n```",
    caret: 4,
    match: ["code", "snippet", "```"],
  },
  { key: "divider", label: "Divider", desc: "―", icon: "―", template: "\n---\n", match: ["divider", "rule", "hr", "---"] },
  {
    key: "table",
    label: "Table",
    desc: "3 × 3",
    icon: "▦",
    template: "| Column | Column | Column |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |",
    sel: [2, 8],
    match: ["table", "grid"],
  },
  { key: "link", label: "Link to page", desc: "[[", icon: "⧉", template: "[[", match: ["link", "page", "wikilink", "[["] },
  {
    key: "image",
    label: "Image",
    desc: "Upload or pick a file",
    icon: "🖼",
    action: () => attachFile("image"),
    match: ["image", "img", "picture", "photo", "upload"],
  },
  {
    key: "video",
    label: "Video",
    desc: "Upload or pick a file",
    icon: "▶",
    action: () => attachFile("video"),
    match: ["video", "movie", "clip", "media"],
  },
  {
    key: "audio",
    label: "Audio",
    desc: "Upload or pick a file",
    icon: "♪",
    action: () => attachFile("audio"),
    match: ["audio", "sound", "music", "mp3"],
  },
  {
    key: "file",
    label: "File",
    desc: "Upload a PDF or anything else",
    icon: "📎",
    action: () => attachFile("file"),
    match: ["file", "attachment", "pdf", "attach", "upload"],
  },
  {
    key: "bookmark",
    label: "Web bookmark",
    desc: "Paste a link",
    icon: "🔗",
    action: () => addBookmark(),
    match: ["bookmark", "web", "link", "url", "embed"],
  },
];

function slashQueryFromInput() {
  const ta = el.editor;
  const caret = ta.selectionStart;
  if (caret !== ta.selectionEnd) return null;
  const before = ta.value.slice(0, caret);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);
  const m = line.match(/^(\s*)\/([^\s/]*)$/);
  if (!m) return null;
  return { start: lineStart + m[1].length, query: m[2] };
}

function updateSlashFromInput() {
  const q = slashQueryFromInput();
  if (!q) {
    closeSlash();
    return;
  }
  const query = q.query.toLowerCase();
  const items = SLASH_ITEMS.filter(
    (it) => !query || it.label.toLowerCase().includes(query) || it.match.some((m) => m.includes(query))
  );
  if (!items.length) {
    closeSlash();
    return;
  }
  slash.open = true;
  slash.start = q.start;
  slash.query = q.query;
  slash.items = items;
  if (slash.sel >= items.length) slash.sel = 0;
  renderSlash();
}

function renderSlash() {
  if (!slash.node) {
    slash.node = document.createElement("div");
    slash.node.className = "slash-menu";
    document.body.appendChild(slash.node);
  }
  slash.node.innerHTML = slash.items
    .map(
      (it, i) =>
        `<button class="menu-item ${i === slash.sel ? "sel" : ""}" data-idx="${i}">
          <span class="si">${escapeHtml(it.icon)}</span>
          <span>${escapeHtml(it.label)}</span>
          <span class="desc">${escapeHtml(it.desc)}</span>
        </button>`
    )
    .join("");
  const coords = caretCoords(el.editor, el.editor.selectionStart);
  const rect = slash.node.getBoundingClientRect();
  let top = coords.top + coords.height + 6;
  if (top + rect.height > window.innerHeight - 12) top = coords.top - rect.height - 6;
  slash.node.style.left = clampLeft(coords.left, rect.width) + "px";
  slash.node.style.top = clampTop(top, rect.height) + "px";
  $$("button[data-idx]", slash.node).forEach((b) => {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => applySlash(slash.items[Number(b.dataset.idx)]);
  });
}

function renderSlashSelection() {
  if (!slash.node) return;
  $$("button[data-idx]", slash.node).forEach((b) =>
    b.classList.toggle("sel", Number(b.dataset.idx) === slash.sel)
  );
}

function closeSlash() {
  slash.open = false;
  if (slash.node) {
    slash.node.remove();
    slash.node = null;
  }
}

function applySlash(item) {
  if (!item) return;
  const ta = el.editor;
  const end = slash.start + 1 + slash.query.length;
  if (item.action) {
    const target = insertTarget(slash.start, end);
    closeSlash();
    item.action(target);
    return;
  }
  ta.focus();
  ta.setRangeText(item.template, slash.start, end, "end");
  if (item.sel) {
    // Select the placeholder so typing replaces it, like a fresh Notion table.
    ta.setSelectionRange(slash.start + item.sel[0], slash.start + item.sel[1]);
  } else if (item.caret != null) {
    const pos = slash.start + item.caret;
    ta.setSelectionRange(pos, pos);
  }
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  closeSlash();
}

/* ------------------------------------------------------------- media blocks */

// Slash commands that need more than a text template hand the caret position to
// an action: the picker runs on the server, and the markdown line is written
// when it comes back. The `/image` text is removed straight away so a cancel
// doesn't leave it behind.
function insertTarget(start, end) {
  const ta = el.editor;
  const value = ta.value.slice(0, start) + ta.value.slice(end);
  ta.value = value;
  ta.setSelectionRange(start, start);
  commitBody(value);
  return { pos: start, snapshot: value };
}

function caretTarget() {
  const ta = el.editor;
  return { pos: ta.selectionStart, snapshot: ta.value };
}

/** Insert a block on its own line(s) and leave the caret under it. */
function insertBlockAt(target, md) {
  const ta = el.editor;
  // The user may have typed while the picker was open; fall back to the caret.
  const pos = ta.value === target.snapshot ? target.pos : ta.selectionStart;
  const before = ta.value.slice(0, pos);
  const after = ta.value.slice(pos);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const text = lead + md + "\n";
  ta.value = before + text + after;
  const caret = pos + text.length;
  ta.setSelectionRange(caret, caret);
  commitBody(ta.value);
  if (!state.readMode) {
    ta.focus();
    autoResize(ta);
  }
}

const safeAlt = (s) => String(s || "file").replace(/[[\]()]/g, "").trim() || "file";

// One syntax for every attachment: a markdown image link. The extension picks
// the renderer, and the path stays relative so the vault survives a move.
function mediaMarkdown(a) {
  const alt = safeAlt(a.name.replace(/\.[^.]+$/, ""));
  return `![${alt}](${encodeURI(a.href)})`;
}

async function attachFile(kind, target = caretTarget()) {
  if (!state.page || state.page.type === "database") return;
  const page = state.page.path;
  try {
    const res = await api("/api/attach", { method: "POST", body: { page, kind } });
    if (res.cancelled) {
      markDirtyAndSave();
      return;
    }
    insertBlockAt(target, mediaMarkdown(res.attachment));
    toast(`Added ${res.attachment.name}`);
  } catch (err) {
    toast(err.message, "error");
  }
}

/** Ask for a URL in a small popover anchored at the caret. */
function askUrl(head, placeholder) {
  return new Promise((resolve) => {
    const coords = caretCoords(el.editor, el.editor.selectionStart);
    const node = document.createElement("div");
    node.className = "url-pop";
    node.dataset.opensMenu = "1";
    node.innerHTML =
      `<div class="url-head">${escapeHtml(head)}</div>` +
      `<input class="url-input" placeholder="${escapeHtml(placeholder)}" spellcheck="false" />` +
      `<button class="btn primary url-add">Add</button>`;
    document.body.appendChild(node);
    const input = $(".url-input", node);
    const rect = node.getBoundingClientRect();
    node.style.left = clampLeft(coords.left, rect.width) + "px";
    node.style.top = clampTop(coords.top + coords.height + 6, rect.height) + "px";

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      node.remove();
      resolve(value);
    };
    const submit = () => {
      const v = input.value.trim();
      if (!v) {
        input.focus();
        return;
      }
      finish(v);
    };
    $(".url-add", node).onclick = submit;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish("");
      }
      e.stopPropagation();
    });
    // Clicking the page abandons the prompt; the field keeps focus otherwise.
    setTimeout(() => input.focus(), 0);
    const away = (e) => {
      if (!node.contains(e.target)) {
        finish("");
        document.removeEventListener("mousedown", away, true);
      }
    };
    setTimeout(() => document.addEventListener("mousedown", away, true), 0);
  });
}

async function addBookmark(target = caretTarget()) {
  if (!state.page) return;
  const url = await askUrl("Paste a link", "https://…");
  if (!url) {
    markDirtyAndSave();
    return;
  }
  let title = url;
  try {
    const meta = await api("/api/bookmark", { method: "POST", body: { url } });
    title = meta.title || meta.site || url;
  } catch {
    /* offline is fine: the card just shows the host */
  }
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  insertBlockAt(target, `[${safeAlt(title).replace(/\n/g, " ")}](${href})`);
}

// Dropping files from Finder onto a page uploads them into attachments/ and
// writes the markdown line.
async function dropFiles(files, target) {
  for (const file of files) {
    const qs = new URLSearchParams({ name: file.name, page: state.page?.path || "" });
    try {
      const res = await fetch(`/api/upload?${qs}`, {
        method: "POST",
        headers: { "X-Not1-Token": TOKEN },
        body: file,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "upload failed");
      insertBlockAt(target, mediaMarkdown(data.attachment));
      toast(`Added ${data.attachment.name}`);
    } catch (err) {
      toast(err.message, "error");
    }
  }
}

/* ------------------------------------------------------------------ export */

// The renderer normally points media at /files?…; an export has to carry its
// own bytes, so it hands the server vault-relative paths to inline instead.
function exportCtx() {
  return {
    hasTitle: (t) => state.knownTitles.has(t.trim().toLowerCase()),
    fileUrl: (rel) => "not1-asset:" + resolveRel(dirOf(state.page?.path || ""), rel),
  };
}

async function exportPage(format) {
  const p = state.page;
  if (!p) return;
  if (p.type === "database") {
    toast("Databases export as markdown only for now");
    if (format !== "md") return;
  }
  const title = p.title || baseName(p.path) || "Untitled";
  const payload = {
    path: p.path,
    title,
    format,
    icon: p.icon || "",
    tags: p.tags || [],
    created: p.created || 0,
    updated: p.updated || 0,
  };
  if (format !== "md") payload.html = renderMarkdown(p.body || "", exportCtx());
  try {
    const res = await api("/api/export", { method: "POST", body: payload });
    if (res.cancelled) return;
    toast(`Exported ${res.name}`);
  } catch (err) {
    toast(err.message || "Export failed");
  }
}

/* ------------------------------------------------------- code block header */

const CODE_LANGS = [
  ["text", "Plain text"],
  ["go", "Go"],
  ["js", "JavaScript"],
  ["ts", "TypeScript"],
  ["python", "Python"],
  ["bash", "Shell"],
  ["json", "JSON"],
  ["yaml", "YAML"],
  ["html", "HTML"],
  ["css", "CSS"],
  ["sql", "SQL"],
  ["rust", "Rust"],
  ["c", "C"],
  ["cpp", "C++"],
  ["java", "Java"],
  ["markdown", "Markdown"],
];

const FENCE_LINE = /^(\s*(?:```+|~~~+)\s*)[\w+#.-]*\s*$/;

// The language lives in the fence itself, so the block stays plain markdown.
function setCodeLang(line, lang) {
  const lines = (state.page?.body || "").split("\n");
  const m = (lines[line] || "").match(FENCE_LINE);
  if (!m) return;
  lines[line] = m[1] + (lang === "text" ? "" : lang);
  commitBody(lines.join("\n"));
  renderPreview();
}

function openCodeLangMenu(btn) {
  const line = Number(btn.closest(".md-code")?.dataset.line);
  if (!Number.isFinite(line)) return;
  const r = btn.getBoundingClientRect();
  openMenu(
    r.left,
    r.bottom + 4,
    CODE_LANGS.map(([key, label]) => ({ label, action: () => setCodeLang(line, key) }))
  );
}

async function copyCode(btn) {
  const code = btn.closest(".md-code")?.querySelector("code");
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.innerText);
    const label = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => (btn.textContent = label), 1400);
  } catch {
    toast("Copy failed", "error");
  }
}

/** Open an attachment in whatever app the OS uses for it. */
async function openVaultFile(rel) {
  try {
    await api("/api/open-file", { method: "POST", body: { path: rel } });
  } catch (err) {
    toast(err.message, "error");
  }
}

/* ------------------------------------------------------- link-to-page UI */

// Popovers hang off a caret that may be scrolled out of view; keep them on
// screen either way.
function clampLeft(left, width) {
  return Math.max(12, Math.min(left, window.innerWidth - width - 16));
}

function clampTop(top, height) {
  return Math.max(12, Math.min(top, window.innerHeight - height - 12));
}


// Pages are fetched once per picker session and filtered in memory; 200 rows is
// nothing and it keeps typing instant.
let pageRefsCache = { at: 0, items: null, loading: null };

function resetPageRefsCache() {
  pageRefsCache = { at: 0, items: null, loading: null };
}

function pageRefs() {
  if (pageRefsCache.items && Date.now() - pageRefsCache.at < 20000) {
    return Promise.resolve(pageRefsCache.items);
  }
  if (!pageRefsCache.loading) {
    pageRefsCache.loading = api("/api/pages?limit=300")
      .then((res) => {
        pageRefsCache.items = res.pages || [];
        pageRefsCache.at = Date.now();
        return pageRefsCache.items;
      })
      .catch(() => [])
      .finally(() => {
        pageRefsCache.loading = null;
      });
  }
  return pageRefsCache.loading;
}

/** The text of an unclosed `[[link` before the caret, if any. */
function linkQueryFromInput() {
  const ta = el.editor;
  const caret = ta.selectionStart;
  if (caret !== ta.selectionEnd) return null;
  const m = ta.value.slice(0, caret).match(/\[\[([^\[\]\n]*)$/);
  if (!m) return null;
  return { start: caret - m[1].length - 2, query: m[1] };
}

function subseq(needle, hay) {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return needle.length === 0 ? false : i === needle.length;
}

function filterLinkItems(all, query) {
  const q = query.trim().toLowerCase();
  const self = state.page?.path;
  const pool = all.filter((p) => p.path !== self);
  if (!q) return pool.slice(0, 80);
  const head = [];
  const mid = [];
  const fuzzy = [];
  for (const p of pool) {
    const t = (p.title || "").toLowerCase();
    if (t.startsWith(q)) head.push(p);
    else if (t.includes(q)) mid.push(p);
    else if (subseq(q, t)) fuzzy.push(p);
  }
  return head.concat(mid, fuzzy).slice(0, 80);
}

/** Returns true when the picker is (or just was) driving the input. */
function updateLinkerFromInput() {
  const q = linkQueryFromInput();
  if (!q) {
    closeLinker();
    return false;
  }
  const known = pageRefsCache.items;
  linker.open = true;
  linker.start = q.start;
  linker.query = q.query;
  linker.sel = 0;
  linker.items = filterLinkItems(known || [], q.query);
  renderLinker();
  if (!known) {
    const seq = (linker.seq = (linker.seq || 0) + 1);
    pageRefs().then(() => {
      if (seq !== linker.seq || !linker.open) return;
      linker.items = filterLinkItems(pageRefsCache.items || [], linker.query);
      linker.sel = Math.min(linker.sel, Math.max(0, linker.items.length - 1));
      renderLinker();
    });
  }
  return true;
}

function renderLinker() {
  if (!linker.node) {
    linker.node = document.createElement("div");
    linker.node.className = "link-menu";
    document.body.appendChild(linker.node);
  }
  const rows = linker.items
    .map((p, i) => {
      const ic = `<span class="link-ic${p.icon && p.icon !== DB_ICON ? " emoji" : ""}">${pageGlyph(p.icon)}</span>`;
      const dir = p.dir ? `<span class="link-dir">${escapeHtml(p.dir)}</span>` : "";
      return `<button class="link-row ${i === linker.sel ? "sel" : ""}" data-idx="${i}">
        ${ic}<span class="link-title">${escapeHtml(p.title || baseName(p.path))}</span>${dir}
      </button>`;
    })
    .join("");
  linker.node.innerHTML = `<div class="link-head">Select a page</div>${rows || `<div class="link-empty">No pages match “${escapeHtml(linker.query)}”</div>`}`;
  const coords = caretCoords(el.editor, linker.start);
  const rect = linker.node.getBoundingClientRect();
  let top = coords.top + coords.height + 6;
  if (top + rect.height > window.innerHeight - 12) top = coords.top - rect.height - 6;
  linker.node.style.left = clampLeft(coords.left, rect.width) + "px";
  linker.node.style.top = clampTop(top, rect.height) + "px";
  $$("button[data-idx]", linker.node).forEach((b) => {
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => applyLinker(linker.items[Number(b.dataset.idx)]);
  });
  scrollLinkerIntoView();
}

function renderLinkerSelection() {
  if (!linker.node) return;
  $$("button[data-idx]", linker.node).forEach((b) => b.classList.toggle("sel", Number(b.dataset.idx) === linker.sel));
  scrollLinkerIntoView();
}

function scrollLinkerIntoView() {
  const on = linker.node?.querySelector(".link-row.sel");
  if (!on) return;
  const box = linker.node.getBoundingClientRect();
  const r = on.getBoundingClientRect();
  if (r.top < box.top + 28) linker.node.scrollTop -= box.top + 28 - r.top;
  else if (r.bottom > box.bottom - 4) linker.node.scrollTop += r.bottom - (box.bottom - 4);
}

function closeLinker() {
  linker.open = false;
  if (linker.node) {
    linker.node.remove();
    linker.node = null;
  }
}

function applyLinker(item) {
  if (!item) return;
  const ta = el.editor;
  const caret = ta.selectionStart;
  const end = Math.max(caret, linker.start);
  closeLinker();
  ta.focus();
  ta.setRangeText(`[[${item.title || baseName(item.path)}]]`, linker.start, end, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

/* -------------------------------------------------------------- creation */

function currentDir() {
  if (state.page) return dirOf(state.page.path);
  return "";
}

async function createPage(title = "") {
  if (state.needsWorkspace) {
    await pickFolder();
    return;
  }
  if (state.db && state.page?.type === "database") {
    state.db._newRow?.();
    return;
  }
  try {
    const dir = currentDir();
    const res = await api("/api/page", { method: "POST", body: { dir, title, kind: "page" } });
    if (dir) state.expanded.add(dir);
    saveExpanded();
    await refreshTree();
    await openPage(res.page.path, { force: true });
    focusTitle(true);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function createDatabase(title = "") {
  if (state.needsWorkspace) {
    await pickFolder();
    return;
  }
  try {
    const dir = currentDir();
    const res = await api("/api/page", { method: "POST", body: { dir, title, kind: "database" } });
    if (dir) state.expanded.add(dir);
    saveExpanded();
    await refreshTree();
    await openPage(res.page.path, { force: true });
    focusTitle(true);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function createFolder() {
  if (state.needsWorkspace) {
    await pickFolder();
    return;
  }
  try {
    const res = await api("/api/page", { method: "POST", body: { dir: currentDir(), title: "", kind: "folder" } });
    await refreshTree();
    state.expanded.add(res.page.path);
    saveExpanded();
    renderTree();
    setTimeout(() => {
      const row = el.tree.querySelector(`.tree-row[data-path="${CSS.escape(res.page.path)}"]`);
      if (row) startRename(row, res.page.path, true);
    }, 30);
  } catch (err) {
    toast(err.message, "error");
  }
}

function focusTitle(selectAll = false) {
  el.title.focus();
  if (selectAll) {
    const range = document.createRange();
    range.selectNodeContents(el.title);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

async function duplicatePage(path) {
  try {
    const data = await api("/api/page?path=" + encodeURIComponent(path));
    const title = data.page.title + " copy";
    const created = await api("/api/page", {
      method: "POST",
      body: { dir: dirOf(path), title, kind: "page" },
    });
    await api("/api/page", {
      method: "PUT",
      body: {
        path: created.page.path,
        title: created.page.title,
        icon: data.page.icon,
        tags: data.page.tags,
        body: data.page.body,
        expectMod: created.page.modTime,
      },
    });
    await refreshTree();
    await openPage(created.page.path);
    toast("Duplicated");
  } catch (err) {
    toast(err.message, "error");
  }
}

async function deletePath(path, isDir) {
  const ok = await confirmDialog({
    title: isDir ? "Delete folder?" : "Move page to trash?",
    message: isDir
      ? `“${baseName(path)}” and everything inside will be moved to .not1/trash.`
      : `“${titleOf(path)}” will be moved to .not1/trash, so nothing is lost.`,
    confirm: "Delete",
    danger: true,
  });
  if (!ok) return;
  try {
    await api("/api/delete", { method: "POST", body: { path } });
    const deletingCurrent =
      state.page && (isDir ? state.page.path === path || state.page.path.startsWith(path + "/") : state.page.path === path);
    if (deletingCurrent) {
      state.page = null;
      state.dirty = false;
    }
    await refreshTree();
    if (deletingCurrent) {
      const next = state.recentPages.find((p) => p.path !== path);
      if (next) openPage(next.path);
      else showEmpty();
    }
    toast("Moved to trash");
  } catch (err) {
    toast(err.message, "error");
  }
}

function startRename(row, path, isDir) {
  const label = row.querySelector(".row-label");
  if (!label) return;
  label.contentEditable = "true";
  label.textContent = isDir ? baseName(path) : titleOf(path);
  label.focus();
  const range = document.createRange();
  range.selectNodeContents(label);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    label.contentEditable = "false";
    const name = label.textContent.trim();
    if (!save || !name || name === (isDir ? baseName(path) : titleOf(path))) {
      renderTree();
      return;
    }
    try {
      const res = await api("/api/rename", { method: "POST", body: { path, name } });
      await refreshTree();
      if (!isDir && state.page?.path === path && res.page?.path) {
        state.page.path = res.page.path;
        state.page.title = res.page.title;
        state.page.modTime = res.page.modTime;
        el.title.textContent = res.page.title;
        history.replaceState(null, "", "#" + encodeURI(res.page.path));
        markActiveRow();
        renderCrumbs();
      }
    } catch (err) {
      toast(err.message, "error");
      renderTree();
    }
  };
  label.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      label.blur();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      finish(false);
    }
  };
  label.onblur = () => finish(true);
  label.onclick = (e) => e.stopPropagation();
}

/* ----------------------------------------------------------------- menus */

function closeMenu() {
  if (menu) {
    menu.remove();
    menu = null;
  }
}

function positionPopup(node, x, y) {
  document.body.appendChild(node);
  const rect = node.getBoundingClientRect();
  node.style.left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)) + "px";
  node.style.top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) + "px";
  menu = node;
  return node;
}

function openMenu(x, y, items, { className = "popover", search = false } = {}) {
  closeMenu();
  const node = document.createElement("div");
  node.className = className;
  const actionable = [];
  node.innerHTML = items
    .map((it) => {
      if (it === "-") return '<div class="menu-sep"></div>';
      if (it.head) return `<div class="menu-head${it.path ? " path" : ""}">${escapeHtml(it.head)}</div>`;
      actionable.push(it);
      return `<button class="menu-item ${it.danger ? "danger" : ""}" data-key="${escapeHtml(
        it.key || ""
      )}">${it.icon ? icon(it.icon) : ""}<span>${escapeHtml(it.label)}</span>${
        it.hint ? `<span class="hint">${escapeHtml(it.hint)}</span>` : ""
      }</button>`;
    })
    .join("");
  let input = null;
  if (search) {
    input = document.createElement("input");
    input.className = "menu-search";
    input.placeholder = "Search actions…";
    input.spellcheck = false;
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      $$(".menu-item", node).forEach((btn) => {
        btn.classList.toggle("off", Boolean(q) && !btn.textContent.toLowerCase().includes(q));
      });
      $$(".menu-sep", node).forEach((sep) => sep.classList.toggle("off", Boolean(q)));
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        $$(".menu-item", node)
          .find((btn) => !btn.classList.contains("off"))
          ?.click();
      }
    });
    node.prepend(input);
  }
  positionPopup(node, x, y);
  $$(".menu-item", node).forEach((btn, i) => {
    btn.onclick = () => {
      closeMenu();
      actionable[i]?.action?.();
    };
  });
  if (input) setTimeout(() => input.focus(), 0);
  return node;
}

function openPageMenu(x, y, path, isDir = false) {
  if (!path) return;
  const items = [];
  if (isDir) {
    items.push(
      { label: "New page inside", icon: "plus", action: () => createPageIn(path) },
      { label: "New subfolder", icon: "folder-plus", action: () => createFolderIn(path) },
      "-",
      { label: "Rename", icon: "edit", action: () => renameInTree(path) },
      { label: "Reveal in Finder", icon: "folder-open", action: () => reveal(path) },
      "-",
      { label: "Delete folder", icon: "trash", danger: true, action: () => deletePath(path, true) }
    );
  } else {
    items.push(
      { label: "Rename", icon: "edit", action: () => renameInTree(path) },
      { label: "Duplicate", icon: "copy", action: () => duplicatePage(path) },
      { label: "Copy page link", icon: "link", action: () => copyLink(path) },
      "-",
      { label: "Open", icon: "file", action: () => openPage(path) },
      "-",
      { label: "Export as PDF…", icon: "download", action: () => exportPage("pdf") },
      { label: "Export as HTML…", icon: "download", action: () => exportPage("html") },
      { label: "Export as Markdown…", icon: "download", action: () => exportPage("md") },
      "-",
      { label: "Reveal in Finder", icon: "folder-open", action: () => reveal(path) },
      "-",
      { label: "Move to trash", icon: "trash", danger: true, action: () => deletePath(path, false) }
    );
  }
  openMenu(x, y, items);
}

function openWorkspaceMenu(x, y) {
  openMenu(x, y, [
    { head: state.workspace || "No folder open", path: true },
    { label: "Open another folder…", icon: "folder-open", action: pickFolder },
    { label: "Reveal in Finder", icon: "external", action: () => reveal("") },
    "-",
    { label: state.theme === "dark" ? "Light mode" : "Dark mode", icon: state.theme === "dark" ? "sun" : "moon", action: toggleTheme },
    { label: "New page", icon: "plus", hint: "⌘N", action: () => createPage() },
    { label: "Search", icon: "search", hint: "⌘P", action: openPalette },
  ]);
}

function renameInTree(path) {
  const row = el.tree.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
  if (row) startRename(row, path, row.dataset.dir === "1");
}

async function createPageIn(dir) {
  try {
    state.expanded.add(dir);
    saveExpanded();
    const res = await api("/api/page", { method: "POST", body: { dir, title: "", kind: "page" } });
    await refreshTree();
    await openPage(res.page.path, { force: true });
    focusTitle(true);
  } catch (err) {
    toast(err.message, "error");
  }
}

async function createFolderIn(dir) {
  try {
    const res = await api("/api/page", { method: "POST", body: { dir, title: "", kind: "folder" } });
    await refreshTree();
    state.expanded.add(dir);
    saveExpanded();
    renderTree();
    setTimeout(() => renameInTree(res.page.path), 30);
  } catch (err) {
    toast(err.message, "error");
  }
}

function reveal(path) {
  api("/api/reveal", { method: "POST", body: { path } }).catch((err) => toast(err.message, "error"));
}

async function copyLink(path) {
  const text = `[[${titleOf(path)}]]`;
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied " + text);
  } catch {
    toast("Clipboard unavailable", "error");
  }
}

function openEmojiPicker(x, y) {
  const emojis =
    "📄 📝 📓 📔 📒 📚 📖 🔖 🗂 🗒 🗓 📅 ✅ ☑️ ⏳ ⏰ 🎯 🚀 ✨ 💡 🔥 ⭐️ 🌱 🌿 🍀 🌊 🏔 🌤 ☀️ 🌙 ⚡️ 🧠 💭 💬 🗣 📣 🔔 🔍 🔗 🧩 🧪 ⚗️ 🛠 ⚙️ 🧰 🖥 💻 ⌨️ 🖱 📱 🎧 🎨 🖌 📐 📏 ✏️ 🖊 🖋 🗑 📌 📍 🏷 💼 🏠 🏡 🏢 🗺 🧭 🚗 ✈️ 🎒 🧳 👤 👥 🐣 🐙 🦊 🐝 🌵 🍁 🍂 🌸 🌻 🍎 🍋 🍵 ☕️ 🍰 🎉 🎁 🏆 🥇 🧘".split(
      " "
    );
  closeMenu();
  const node = document.createElement("div");
  node.className = "popover";
  node.style.padding = "4px";
  node.innerHTML =
    `<div class="emoji-grid">${emojis
      .map((e) => `<button data-emoji="${escapeHtml(e)}">${e}</button>`)
      .join("")}</div><div class="menu-sep"></div><button class="menu-item" data-emoji="">${icon(
      "x"
    )}<span>Remove icon</span></button>`;
  positionPopup(node, x, y);
  $$("[data-emoji]", node).forEach((b) => {
    b.onclick = () => {
      if (!state.page) return;
      state.page.icon = b.dataset.emoji;
      if (b.dataset.emoji) state.icons[state.page.path] = b.dataset.emoji;
      else delete state.icons[state.page.path];
      closeMenu();
      renderPage();
      renderTree();
      savePage();
    };
  });
}

/* --------------------------------------------------------------- palette */

// Search snippets come straight from the markdown source. Strip the syntax so
// results read like prose, while keeping the \x01/\x02 highlight markers.
function tidySnippet(raw) {
  return String(raw)
    .split(/([\u0001\u0002])/)
    .map((part) => {
      if (part === "\u0001" || part === "\u0002") return part;
      return part
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/^>\s?/gm, "")
        .replace(/^\[!\w+\]\s*/gm, "")
        .replace(/^-\s+\[[ xX]\]\s+/gm, "")
        .replace(/^[-*+]\s+/gm, "")
        .replace(/^(?:-{3,}|\|[-: |]+\|)$/gm, "")
        .replace(/[*_`~]{1,3}([^*_`~]+)[*_`~]{1,3}/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (m, a, b) => b || a)
        .replace(/\s+/g, " ");
    })
    .join("")
    .trim();
}

function openPalette() {
  if (overlay) return;
  closeSlash();
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  scrim.innerHTML = `
    <div class="palette" role="dialog" aria-label="Search">
      <div class="palette-input">
        ${icon("search")}
        <input id="palette-input" placeholder="Search pages, or type to create…" spellcheck="false" autocomplete="off" />
        <button class="icon-btn" id="palette-close" aria-label="Close">${icon("x")}</button>
      </div>
      <div class="palette-results" id="palette-results"></div>
      <div class="palette-foot"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>esc</kbd> close</span></div>
    </div>`;
  document.body.appendChild(scrim);
  overlay = scrim;
  const input = $("#palette-input", scrim);
  input.focus();
  scrim.addEventListener("mousedown", (e) => {
    if (e.target === scrim) closePalette();
  });
  $("#palette-close", scrim).onclick = closePalette;
  input.addEventListener("input", () => {
    clearTimeout(paletteTimer);
    paletteTimer = setTimeout(() => updatePalette(input.value), 80);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closePalette();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      paletteSel = (paletteSel + 1) % Math.max(1, paletteItems.length);
      paintPalette();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      paletteSel = (paletteSel - 1 + Math.max(1, paletteItems.length)) % Math.max(1, paletteItems.length);
      paintPalette();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = paletteItems[paletteSel];
      if (item) {
        closePalette();
        item.run();
      }
    }
  });
  updatePalette("");
}

let paletteTimer = 0;
let paletteItems = [];
let paletteSel = 0;

function closePalette() {
  if (overlay) {
    overlay.remove();
    overlay = null;
  }
  paletteItems = [];
}

function paletteCommands() {
  return [
    { group: "Actions", title: "New page", icon: "＋", hint: "⌘N", run: () => createPage() },
    { group: "Actions", title: "New database", icon: "▦", run: () => createDatabase() },
    { group: "Actions", title: "New folder", icon: "🗂", run: () => createFolder() },
    { group: "Actions", title: "Open another folder…", icon: "📂", run: pickFolder },
    {
      group: "Actions",
      title: state.theme === "dark" ? "Switch to light mode" : "Switch to dark mode",
      icon: state.theme === "dark" ? "☀️" : "🌙",
      run: toggleTheme,
    },
    { group: "Actions", title: "Export page as PDF…", icon: "🖨", run: () => exportPage("pdf") },
    { group: "Actions", title: "Export page as HTML…", icon: "🌐", run: () => exportPage("html") },
    { group: "Actions", title: "Export page as Markdown…", icon: "⬇️", run: () => exportPage("md") },
    { group: "Actions", title: "Reveal workspace in Finder", icon: "🧭", run: () => reveal("") },
  ];
}

function updatePalette(query) {
  const q = query.trim();
  const results = $("#palette-results");
  if (!results) return;
  if (!q) {
    const recents = state.recentPages.map((p) => ({
      group: "Recently edited",
      title: p.title,
      sub: p.dir || "workspace",
      icon: p.icon,
      meta: fmtTime(p.updated),
      run: () => {
        closePalette();
        openPage(p.path);
      },
    }));
    paletteItems = [...paletteCommands(), ...recents];
    paletteSel = 0;
    paintPalette();
    return;
  }
  api("/api/search?q=" + encodeURIComponent(q) + "&limit=30")
    .then((data) => {
      if (!overlay) return;
      const hits = (data.results || []).map((h) => ({
        group: "Pages",
        title: h.title,
        sub: h.dir || "workspace",
        icon: h.icon,
        snippet: tidySnippet(h.snippet || ""),
        run: () => {
          closePalette();
          openPage(h.path);
        },
      }));
      // Matches first: Enter should open what the user was looking for, not
      // create a new page that happens to share the query.
      paletteItems = [
        ...hits,
        {
          group: "Create",
          title: `New page “${q}”`,
          sub: "in " + (currentDir() || "workspace"),
          icon: "＋",
          run: () => createPage(q),
        },
      ];
      paletteSel = 0;
      paintPalette();
    })
    .catch(() => {});
}

function paintPalette() {
  const box = $("#palette-results");
  if (!box) return;
  if (!paletteItems.length) {
    box.innerHTML = `<div class="palette-empty">No results</div>`;
    return;
  }
  let lastGroup = "";
  let i = 0;
  const html = [];
  for (const item of paletteItems) {
    if (item.group !== lastGroup) {
      html.push(`<div class="palette-group">${escapeHtml(item.group)}</div>`);
      lastGroup = item.group;
    }
    const snippet = item.snippet
      ? `<div class="p-sub">${escapeHtml(tidySnippet(item.snippet))
          .replace(/\u0001/g, "<mark>")
          .replace(/\u0002/g, "</mark>")}</div>`
      : `<div class="p-sub">${escapeHtml(item.sub || "")}</div>`;
    html.push(
      `<button class="palette-item ${i === paletteSel ? "sel" : ""}" data-i="${i}">
        <span class="p-icon">${pageGlyph(item.icon)}</span>
        <span class="p-main"><div class="p-title">${escapeHtml(item.title)}</div>${snippet}</span>
        ${item.hint ? `<span class="hint">${escapeHtml(item.hint)}</span>` : ""}
      </button>`
    );
    i++;
  }
  box.innerHTML = html.join("");
  $$(".palette-item", box).forEach((b) => {
    const idx = Number(b.dataset.i);
    b.onmouseenter = () => {
      paletteSel = idx;
      $$(".palette-item", box).forEach((x) => x.classList.toggle("sel", Number(x.dataset.i) === idx));
    };
    b.onclick = () => {
      const item = paletteItems[idx];
      if (item) {
        closePalette();
        item.run();
      }
    };
  });
  const sel = box.querySelector(".palette-item.sel");
  sel?.scrollIntoView({ block: "nearest" });
}

/* ------------------------------------------------------------------ misc */

function confirmDialog({ title, message, confirm = "OK", danger = false }) {
  return new Promise((resolve) => {
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.style.paddingTop = "24vh";
    scrim.innerHTML = `
      <div class="palette" style="width:min(420px,92vw)">
        <div style="padding:20px 22px 6px">
          <div style="font-size:16px;font-weight:600;letter-spacing:-0.01em">${escapeHtml(title)}</div>
          <div style="margin-top:7px;color:var(--text-soft);font-size:13px;line-height:1.55">${escapeHtml(message)}</div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;padding:16px 18px">
          <button class="btn-ghost" data-act="cancel">Cancel</button>
          <button class="btn-primary" data-act="ok" style="${danger ? "background:#eb5757;color:#fff" : ""}">${escapeHtml(
            confirm
          )}</button>
        </div>
      </div>`;
    document.body.appendChild(scrim);
    const done = (v) => {
      scrim.remove();
      document.removeEventListener("keydown", onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        done(false);
      }
    };
    document.addEventListener("keydown", onKey, true);
    scrim.querySelector('[data-act="cancel"]').onclick = () => done(false);
    scrim.querySelector('[data-act="ok"]').onclick = () => done(true);
    scrim.addEventListener("mousedown", (e) => {
      if (e.target === scrim) done(false);
    });
    scrim.querySelector('[data-act="ok"]').focus();
  });
}

function bindShortcuts() {
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "p") {
      e.preventDefault();
      if (overlay) closePalette();
      else openPalette();
      return;
    }
    if (mod && e.key.toLowerCase() === "n") {
      e.preventDefault();
      createPage();
      return;
    }
    if (mod && e.key === "\\") {
      e.preventDefault();
      setSidebar(document.body.classList.contains("sidebar-hidden"));
      return;
    }
    if (mod && e.key.toLowerCase() === "e" && state.page) {
      e.preventDefault();
      toggleMode();
      return;
    }
    if (mod && e.key.toLowerCase() === "s") {
      e.preventDefault();
      if (state.page && state.dirty) savePage();
      else updateSaveState("saved");
      return;
    }
    if (e.key === "Escape") {
      if (overlay) closePalette();
      closeMenu();
      closeSlash();
    }
  });
}

function connectEvents() {
  try {
    const es = new EventSource("/api/events?t=" + encodeURIComponent(TOKEN));
    es.onmessage = (ev) => {
      let data;
      try {
        data = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (data.type === "fs") onExternalChange(data.paths || []);
    };
    es.onerror = () => {
      /* EventSource reconnects on its own */
    };
  } catch {
    /* ignore */
  }
}

let treeRefreshTimer = 0;
let dbRefreshTimer = 0;
function onExternalChange(paths) {
  if (!state.workspace) return;
  clearTimeout(treeRefreshTimer);
  treeRefreshTimer = setTimeout(() => refreshTree(), 120);
  if (state.db && state.page?.type === "database") {
    const src = state.db.source ? state.db.source + "/" : "";
    if (!src || paths.some((p) => p === state.page.path || p.startsWith(src))) {
      clearTimeout(dbRefreshTimer);
      dbRefreshTimer = setTimeout(() => state.db?._refresh?.(), 180);
    }
  }
  const cur = state.page?.path;
  if (!cur) return;
  if (paths.includes(cur)) {
    if (state.dirty) {
      updateSaveState("conflict");
      showConflict();
    } else {
      reloadFromDisk();
    }
    return;
  }
  if (paths.some((p) => cur.startsWith(p + "/"))) {
    if (!state.dirty) openPage(cur, { force: true });
    return;
  }
  if (state.page && paths.includes(state.page.path)) return;
}

/* ----------------------------------------------------------------- boot */

function initSidebarState() {
  const hidden = localStorage.getItem("not1-sidebar") === "0";
  setSidebar(!hidden);
}

// Handy for debugging from the devtools console.
window.not1 = { state, openPage, refreshTree, setMode, savePage };

document.addEventListener("DOMContentLoaded", () => {
  initSidebarState();
  init();
});
