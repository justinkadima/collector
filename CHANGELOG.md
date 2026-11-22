# Changelog

What changed, and whether it touches the files you own. Versions are the git
tags; the app prints the same number with `collector -version`.

Nothing here has ever rewritten a page it wasn't asked to. When a release
changes the markdown grammar it says so, and the old shape keeps working.

## 0.7.1 — 2026-11-22

**Files:** nothing moves.

- The module path is `github.com/justinkadima/collector`, so
  `go install github.com/justinkadima/collector@latest` works.
- MIT license, a screenshot, and a README written for someone who has never
  heard of the app.
- Continuous integration: gofmt, vet, tests and a build on macOS, Linux and
  Windows.

## 0.7.0 — 2026-11-22

**Files:** a vault's `.not1/` folder becomes `.collector/`, and the app's own
settings move to `Application Support/Collector/`. Pages are untouched.

- The app is called Collector: binary, window, bundle, MCP server name, auth
  header, environment variables.
- The rename happens on first start by itself — a vault's cache folder is
  renamed in place, so the trash keeps every deleted page.

## 0.6.0 — 2026-11-22

**Files:** new content in an ```events fence is now read as an event.

- Events live in the page that owns them, inside an ```events fence — an
  ordinary code block that any other editor renders as code.
- The calendar is a third column, not a window: a month grid with dots per day,
  a list of the selected day, and a click that opens the page at the line that
  defines the event.
- `/events` and the `+` on a day each write their own block, dated, with the
  title already selected.
- One event, one block: day, optional time or range, title, and a multiline
  description under it. All four edit where they are read, by splicing source
  lines.

## 0.5.0 — 2026-11-22

**Files:** nothing.

- An icon: one SVG that becomes the `.icns` in the bundle and the runtime Dock
  tile of a loose executable.
- `scripts/bundle.sh` builds `dist/Collector.app`.

## 0.4.0 — 2026-11-22

**Files:** nothing.

- Blocks can be dragged into a different order from the gutter handle; a
  dropped block moves as its source lines, and a table keeps its rows.
- Tables have their own row and column menus, which take precedence over the
  block handle at the table's edge.
- The edit overlay follows its block when the page above it reflows.
- A table's cells, row handles and column handles are reachable in every
  position, header row included.

## 0.3.0 — 2026-11-22

**Files:** nothing.

- There is no read mode and no write mode: the rendered page is the editor, and
  clicking a block edits that line of the `.md` in place.
- Clicking empty paper writes where you clicked; `/table` arrives with blank
  lines around it; `Esc` in a cell commits and drops a paragraph under the
  table.

## 0.2.0 — 2026-11-22

**Files:** nothing.

- `collector mcp` serves the same vault over the Model Context Protocol:
  `vault_info`, `search_pages`, `list_pages`, `read_page`, `create_page`,
  `append_to_page`, `update_page`, `delete_page`, `query_database`.
- The index is rebuilt on startup, because the vault may have changed while
  nothing was watching it.

## 0.1.0 — 2026-11-21

The first working app.

- A folder of markdown as a vault: sidebar tree, pages with icons and
  frontmatter, `[[wiki links]]` with backlinks, full-text search over SQLite
  FTS5, autosave with an optimistic-concurrency check, deletes that move files
  to `.collector/trash/` instead of unlinking them.
- Databases as pages: the frontmatter is the schema, each row is a file, with
  table, board and list views.
- Markdown tables that render as a grid and edit in place, attachments in one
  syntax chosen by extension, bookmark cards, code fences with a language
  header, and export to HTML, PDF and a byte-for-byte markdown copy.
