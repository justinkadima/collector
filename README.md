# not1

A Notion-shaped notes app that is really just a folder of markdown files.

Point it at a directory — a project, an Obsidian vault, a folder of notes — and
it gives you a sidebar tree, a page view with icons, backlinks, and full-text
search. Everything it shows is read from `.md` files on disk. When you rename a
page, the file is renamed. When you edit a page, the file is written. If you
delete the app, your notes are still there, unchanged.

```
go build -o not1 .
./not1                 # opens the last workspace in a native window
./not1 -w ~/Notes      # or a specific folder
./not1 -browser        # run as a local web app instead of a window
```

Requires Go 1.22+ and, for the native window, CGO. On macOS the window is
WebKit; on Linux/Windows it is GTK/WebView2. With `CGO_ENABLED=0` the binary
still builds and runs with `-browser`.

On macOS there is also a bundle, which is what Finder, the Dock, Spotlight and
the window's menu bar like best:

```
./scripts/bundle.sh           # dist/not1.app
./scripts/bundle.sh --run     # …and open it
```

`./not1` on its own is already a normal app window; the bundle only adds the
things a loose executable cannot have — a name in the menu bar, an icon Finder
can read, and something double-clickable. The icon itself is one SVG
(`assets/icon.svg`): an ink tile, a page you own, and one block in the accent
blue. `scripts/icon.sh` turns it into `assets/not1.icns` (for the bundle) and
`assets/not1-512.png` (embedded in the binary, so the loose executable hands the
same drawing to `NSApplication` and the Dock tile matches). Both outputs are
checked in; the script only needs a Chromium when the drawing changes, because
QuickLook flattens SVG onto white and a matte would show up as a square around
the tile.

## The contract with your files

- **Markdown is the source of truth.** The app never keeps a copy of your text
  anywhere else.
- **One page = one `.md` file.** Nested folders in the vault become nested
  folders in the sidebar, hidden folders (`.git`, `.not1`) excluded.
- **The filename is the title.** Renaming a page renames the file; the title is
  never stored separately, so the tree can't drift away from what's on disk.
- **Metadata lives in frontmatter**, and only the keys that exist are written:

  ```markdown
  ---
  icon: 🚀
  tags: [projects, 2026]
  pinned: true
  ---
  ```

  `created` and `updated` are added on first write and maintained afterwards.
  Strip everything between the fences and the page is plain markdown again.
- **Index is disposable.** Search, backlinks and the page list come from
  `<vault>/.not1/index.db` (SQLite + FTS5). Delete that folder and everything is
  rebuilt by walking the vault. Nothing is lost.
- **Delete is a move, not an unlink.** Removed pages and folders go to
  `<vault>/.not1/trash/<timestamp>/`.
- **Attachments are ordinary files** in `<vault>/attachments/`, referenced by a
  page-relative markdown link. The app copies a file in once and never again;
  delete the link and the file is still yours to keep or delete.

## What it does

- Sidebar tree with inline rename, drag-to-move, new page/folder, trash.
- **The page is the editor.** There is no read mode and no write mode: click a
  block and it becomes a text field shaped exactly like what you clicked — same
  font, same size, in the same place — with its markdown markers (`## `, `- `,
  the fences) hidden while you type and put back when you leave. Nothing about
  the file changes: you are editing that line of the `.md`.
- **Blocks are the unit.** `Enter` splits at the caret and carries the marker
  over — a bullet stays a bullet, an ordered list counts up, a heading becomes a
  heading again. `Enter` on an empty bullet or heading *ends* the structure
  instead of adding another empty one, so leaving a list is one keypress.
  `Backspace` at the start of a bullet whose neighbour isn't a bullet drops the
  marker rather than gluing the text onto the paragraph above; `Backspace` after
  the first character merges the block into the one above. `↑`/`↓` at the top and
  bottom line walk to the neighbouring block, `Tab`/`Shift-Tab` indent.
- **The edit box is the block.** Clicking a paragraph, heading or bullet lays a
  plain textarea exactly over it, in its own font and colour, and the textarea
  is what you type into; the marker (`- `, `## `, `1. `) is hidden while you
  edit and written back when you are done. The overlay stays on its block even
  when the page above it changes height — an image finishing its decode, a
  window resize — so it never drifts off to the wrong place.
- **Whole blocks can be selected and cut.** `Shift`-click another block, drag
  across blocks, or `Shift`-`↑`/`↓` from the edge of the block you are editing to
  wash a run of blocks, then `Delete`/`Backspace` removes exactly those lines
  from the file, or just start typing to replace the run. `Esc` drops the
  selection. Inside one block, ordinary text selection still applies.
- **Blocks can be dragged into a different order.** Hover a block and a six-dot
  handle appears in the gutter; drag it up or down and a line shows where the
  block will land. The block moves as its source lines — a heading stays a
  heading, a table keeps its rows, a list item takes its indented children — and
  a single blank line is left between whatever ends up adjoining. Dropping the
  handle of a block inside a selection moves the whole selection. Dragging to
  the edge of the window scrolls the page. A table is grabbed from the gutter,
  not from its own edge: there the handles belong to its rows and columns.
- Autosave, with an optimistic-concurrency check so an edit made in vim doesn't
  get clobbered.
- `[[Wiki links]]` resolve by path or by name, and every page shows its
  backlinks. `⌘`-click or plain click opens them in place.
- Typing `[[` opens a page browser at the caret, like Notion's link picker: every
  page listed by icon and title, most recent first, with its folder on the right.
  Keep typing to filter (prefix, substring, then subsequence — `[[sprn` finds
  "Sprint notes"), `↑`/`↓`/`Tab` to move, `Enter` or a click to insert
  `[[Page title]]`, `Esc` to back out and leave the `[[` alone. `/link` opens the
  same picker.
- `⌘P` searches everything (SQLite FTS5) with highlighted snippets, or creates a
  page when nothing matches.
- `/` at the start of a line inserts headings, lists, to-dos, quotes, callouts,
  code, dividers, tables.
- A markdown table renders as an even grid with hairline borders, and its cells
  edit in place: click one, type, and the text is spliced back into the row of
  the `.md` file. `Enter` saves and drops a row, `Tab`/`Shift-Tab` save and move
  across, `Esc` saves and puts a paragraph under the table (`Shift`-`Esc`
  throws the edit away), clicking away saves. `/table` drops in a 3×3 skeleton
  with the first cell selected, and a blank line above and below it — a table
  can't interrupt a paragraph in ordinary markdown, and a table is the one block
  you can't press `Enter` out of, so the line to write on is already there.
  Clicking empty paper always writes where you clicked: between two blocks it
  opens (or makes) the line at that height, under the last block it grows the
  page.
- Tables have Notion-style menus for rows and columns. Hover any row — the
  header row included — for an ellipsis at its left, or right-click a cell:
  insert row above/below, duplicate row, clear contents, delete row. The header
  row's handle opens the column menu, because a header cell *is* the column's
  label: insert column left/right, clear contents, delete column. Both are
  filtered by a "Search actions…" box, and both rewrite the markdown rows in
  place — a table is just text.
- **Attachments, one syntax.** `/image`, `/video`, `/audio` and `/file` open the
  native file picker, copy the file into `<vault>/attachments/`, and drop a
  page-relative markdown link at the caret: `![screenshot](../attachments/screenshot.png)`.
  Dropping files on the page does the same thing. The extension decides how it
  renders — a video gets a player, an mp3 gets audio controls, a PDF gets a file
  card — so nothing but the extension and the path is stored, and the link still
  resolves in any other editor. Names are slugified and never overwritten
  (`shot.png`, `shot-2.png`).
- **A lone link is a bookmark card.** `/bookmark` asks for a URL, fetches the
  title once on the server, and writes `[Title](https://…)` on its own line —
  plain markdown that happens to render as a card. A pasted `https://…` line
  does the same.
- **Code blocks stay fences.** Fenced code renders with a header bar showing the
  language and a Copy button; click the language to change it, which rewrites
  that one fence line. Highlighting is a small built-in tokenizer — no
  dependency, and an unknown language is just escaped.
- **Events live in the page that owns them.** Write an ```events fence and each
  line is an event: `2026-11-24 09:30 Standup`, `2026-11-24 14:00-15:00 Design
  review`, or just `2026-11-26 Justin's birthday` for an all-day one. Blank
  lines and `#` comments are ignored. Nothing else stores them — the fence is an
  ordinary code block, so the file still reads fine in vim or Obsidian, and
  deleting the index loses no events. `/events` starts one, dated today.
- **The calendar is a column, not a window.** The toolbar's calendar opens a
  month on the right; the page keeps its width while you read it. Days with
  events carry dots (a faint one for an all-day event), the selected day lists
  its events underneath, and clicking one opens the page scrolled to the line
  that defines it. The `+` on a day writes `2026-12-03 ` into the page's last
  events fence and leaves the caret there, so you type the title and nothing
  else. With no page open it opens your "Calendar" page, or makes one.
- Live file watching via SSE: edits from another editor show up without a
  reload; unsaved changes raise a conflict banner instead of being lost.
- Light/dark theme, resizable and collapsible sidebar, both remembered.
- Databases: table, board and list views over a folder of pages (below).
- **The same vault over MCP**, so an agent can search and edit your notes
  (below): `not1 mcp -w ~/Notes`.

## Databases

A database is a page. There is no second store: the page's frontmatter is the
schema, and every row is an ordinary markdown file whose frontmatter keys are
its cells. Edit a cell and the file changes; edit the file in vim and the cell
changes.

```markdown
---
type: database
source: Tasks            # folder of rows, relative to this page
fields: status:select, due:date, done:checkbox
options-status: todo, doing, done
view: board
group-by: status
sort: due
filter: status != done
---

Where the work lives.
```

- **A database looks like one.** `type: database` is the whole trick: the sidebar,
  the page header and the `[[` picker draw a database glyph for it, and nothing
  icon-shaped is written into the file. Set `icon:` in the frontmatter (or click
  the icon) to override that with an emoji, like any page.
- **Rows are files.** `source: Tasks` on `Tasks.md` points at the sibling folder
  `Tasks/`; each `.md` in it is one row, titled by its filename. Renaming the
  database page renames that folder with it.
- **Fields are inferred.** A key that appears in the frontmatter of any row is
  a column; `fields:` pins the type (`text`, `number`, `date`, `select`,
  `checkbox`) and the order. Unpinned keys are typed by looking at the values.
- **`options-<key>` holds select choices**, so a new option is just a comma.
- **Views are a line of frontmatter.** `view: table | board | list`,
  `group-by`, `sort` + `sort-dir`, `filter`. Switching the view in the UI
  rewrites that line — that's the whole persistence layer.
- **The filter language is one clause** — `key op value` with `=`, `!=`, `~`,
  `>`, `<`, `>=`, `<=`. An unparseable filter is ignored rather than blanking
  the view.
- **The page body is the database's description**, rendered above the view and
  edited by clicking it.
- **Delete a row and the file goes to `.not1/trash/`**, never away.
- **Cells edit in place.** Click a cell and it becomes an input: `Enter` saves
  and drops a row, `Tab` saves and moves right, `Esc` puts the old value back,
  clicking elsewhere saves. Arrow keys walk the grid, typing on a cell replaces
  its value, `Delete` clears it, `Enter` on the last row adds a new one. Select
  and date columns open a picker instead — type to filter options, `Enter` to
  pick, or type a value that doesn't exist yet to add it.
- **The `⋯` on a column header** (or right-click, or `alt`-click) renames the
  property, changes its type, or removes it.

## Agents: the MCP server

`not1 mcp -w ~/Notes` speaks the Model Context Protocol on stdin/stdout, so an
agent — Claude Desktop, Claude Code, anything MCP-capable — can search, read and
write the same vault you have open. Same files, same frontmatter, no second
store: a tool call is a normal page write, and the app's file watcher picks it up
in about a second.

| Tool | What it's for |
| --- | --- |
| `vault_info` | vault path, page count, recently edited — the orienting call |
| `search_pages` | FTS over titles and bodies, with `«highlighted»` snippets |
| `list_pages` | flat listing, optionally confined to a folder |
| `read_page` | frontmatter fields, body, backlinks, and `modTime` |
| `create_page` | new page from a title (+ optional body, icon, folder) |
| `append_to_page` | add markdown at the end — cannot overwrite |
| `update_page` | replace body and/or title, icon, tags |
| `delete_page` | move to `.not1/trash/` |
| `query_database` | a database page as typed fields and rows |

Two things keep agents honest, both borrowed from the app itself:

- **`read_page` returns `modTime`, `update_page` accepts it.** Pass it back and a
  write that would clobber a concurrent edit fails instead (the same
  optimistic-concurrency rule the UI uses).
- **Appending is the default way to add text.** `append_to_page` re-reads and
  retries on contention, so "add this to my notes" can't eat the page.

Delete never unlinks, paths are vault-relative (`Projects/Roadmap.md`), and the
index is rebuilt on startup — the vault may have changed while nothing was
watching it, and search should not lie.

Point a client at it:

```json
{
  "mcpServers": {
    "not1": {
      "command": "/Users/you/bin/not1",
      "args": ["mcp", "-w", "/Users/you/Notes"]
    }
  }
}
```

That is `~/Library/Application Support/Claude/claude_desktop_config.json` for
Claude Desktop, `.mcp.json` in a project for Claude Code. `-w` falls back to the
last workspace you opened in the app. stdout is the protocol channel, so
diagnostics go to stderr; add `-log` to see what it's serving.

## Shortcuts

| Key | Action |
| --- | --- |
| `⌘P` | Search / create |
| `⌘N` | New page (or a new row, inside a database) |
| `Esc` | Drop a block selection |
| `⌘\` | Show/hide sidebar |
| `⌘S` | Save now |
| `Esc` | Close menu / palette |

## Layout

```
main.go                 flags, embedded web assets, window or browser
internal/config         app settings (last workspace, theme) — never vault data
internal/vault          the filesystem: read/parse/write/move/delete + frontmatter
internal/index          SQLite FTS5 index, backlinks, snippets (rebuildable)
internal/server         HTTP API + SSE file watcher
internal/mcpsrv         the same vault over MCP, for agents (not1 mcp)
internal/app            native window (webview_go) and stub for CGO-less builds
web/                    the UI: no framework, no build step, ES modules
```

`scripts/` holds the two macOS chores: `icon.sh` (SVG → PNG + ICNS) and
`bundle.sh` (build → `dist/not1.app`).

The API is small and local: bootstrap, tree, page read/write (with `expectMod`
for conflicts), rename, move, delete, search, resolve, database read/view/cell
writes, attachment copy/upload, bookmark title lookup, export, the agenda (a
date range of events, read out of the fences), and a change stream. Every request carries a random per-run token, which is injected into the
page. The MCP server in `internal/mcpsrv` is a second door onto the same code:
it opens the vault directly instead of going through HTTP, and is the only part
of the program that expects a client other than the UI.

## Not in scope

Sync, accounts, block ids or nesting containers, rollups, relations between
databases, plugins, and calendars that live elsewhere: events are yours, in your
files, and importing Google Calendar is a different program's job. A block here is a line with a source range, not an object in
a sidecar store — which is exactly why the file stays editable in vim.
The point is a good desktop client for a folder of markdown, and the file format
is the promise.
