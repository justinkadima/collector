# Changelog

What changed, and whether it touches the files you own. Versions are the git
tags; the app prints the same number with `collector -version`.

Nothing here has ever rewritten a page it wasn't asked to. When a release
changes the markdown grammar it says so, and the old shape keeps working.

## 0.7.5 — 2026-11-24

**Files:** nothing moves, and no page is rewritten. The index gains a column it
fills itself.

- Writing was interrupted by the app reloading the page from disk. Every file
  change was reported to the window as "this page changed", and the window
  reloaded — losing the block being edited and the caret in it. In a vault that
  a sync service keeps in step, that is not an occasional event: a file can be
  rewritten with the bytes it already had, and the reload happened anyway.
  - **A file is now compared by its bytes, not its timestamp.** If the content
    did not change, the page did not change: the new stamp is recorded so the
    next save is not a conflict, and the editor, the caret and the scroll
    position stay exactly where they were.
  - **A page is never reloaded while a block is open or a change is unsaved.**
    A real edit from another program asks first — *Reload file* or *Keep my
    version* — instead of taking the sentence out of your hands.
  - **A folder changing is not this page changing.** Something else inside it
    was written; the tree refreshes and the open page is left alone.
  - A conflict that turns out not to be one is settled without asking: if the
    file still holds what we last wrote, only the stamp moved, so the new stamp
    is taken and the write is repeated.
- Our own writes were recognised by a one-and-a-half second timer, which also
  swallowed somebody else's write made in that window. They are now recognised
  by their bytes and the stamp they were given, so a save by another program
  is never mistaken for ours.

## 0.7.4 — 2026-11-23

**Files:** nothing moves.

- A block can be deleted, a table included. Shift-clicking a block selected it
  and the click that follows immediately cleared the selection, so the blocks a
  gesture had just marked could not be acted on — and a table could not be
  marked at all, because a click inside it starts editing a cell. A click that
  ends a selection now belongs to the selection.
- Backspace at the start of the block under a table no longer writes into the
  table: it merged the paragraph into the table's last row. Text never merges
  into a block that is an object — a table, a divider, media, a code fence —
  because there is no line there for prose to join. Backspace next to one marks
  it instead, and the next Backspace deletes it.
- Deleting blocks leaves one empty line where they were, not the pile of empty
  lines that surrounded them.
- A table can be deleted from its own menus. Columns have a handle again: a `⋮`
  above the header of the column you are hovering, which opens that column's
  menu, next to the `⋯` at the row's left that opens the row's. Both menus end
  with **Delete table** — the table you want gone is the table you were just
  clicking in, and neither menu had a way to say so. What is left behind is one
  empty line and the caret, so the page is ready to be written in.

## 0.7.3 — 2026-11-22

**Files:** nothing moves. A blank line still means what it has always meant:
a new block.

- `/text` inserts a text block. Line breaks stay inside it, so a long note or a
  paste from another document is one block rather than one block per line; only
  an empty line ends it. `Enter` inside a block keeps the line in that block,
  `Enter` at the end of one starts the next.
- Closing the calendar works: the `X` in its header was calling the browser's
  `window.close()`, which does nothing, and the toolbar button could stop
  toggling the panel off. The panel's own visibility is now the only state, and
  `Esc` closes it too (except while you are typing).
- A block written on an empty line under a paragraph used to join that
  paragraph — one paragraph, two lines — because in markdown a run of non-blank
  lines *is* a paragraph. The empty line it needs is now written with it, so
  `Enter` at the end of a paragraph, or a click on the paper below one, really
  does start a new block.

## 0.7.2 — 2026-11-22

**Files:** nothing moves.

- A board with no grouping opened the "Choose a property" menu in the top-left
  corner of the window instead of under the button. Choosing a property now
  groups the board where you clicked.
- The first release published by CI rather than by hand: `git tag` is the whole
  release, and the build refuses to attach a binary whose `-version` disagrees
  with the tag.

## 0.7.1 — 2026-11-22

**Files:** nothing moves.

- The module path is `github.com/justinkadima/collector`, so
  `go install github.com/justinkadima/collector@latest` works.
- MIT license, a recorded demo, and a README written for someone who has never
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
