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
- Read mode by default; click the body (or `⌘E`) to edit. Autosave, with an
  optimistic-concurrency check so an edit made in vim doesn't get clobbered.
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
  across, `Esc` reverts, clicking away saves. `/table` drops in a 3×3 skeleton
  with the first cell selected.
- Tables have Notion-style menus for rows and columns. Hover a body row for the
  six-dot handle on its left, or right-click a cell: insert row above/below,
  duplicate row, clear contents, delete row. Hover the header for the handle
  above the column, or right-click a header cell: insert column left/right,
  clear contents, delete column. Both are filtered by a "Search actions…" box,
  and both rewrite the markdown rows in place — a table is just text.
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
- Live file watching via SSE: edits from another editor show up without a
  reload; unsaved changes raise a conflict banner instead of being lost.
- Light/dark theme, resizable and collapsible sidebar, both remembered.
- Databases: table, board and list views over a folder of pages (below).

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

## Shortcuts

| Key | Action |
| --- | --- |
| `⌘P` | Search / create |
| `⌘N` | New page (or a new row, inside a database) |
| `⌘E` | Toggle read/write |
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
internal/app            native window (webview_go) and stub for CGO-less builds
web/                    the UI: no framework, no build step, ES modules
```

The API is small and local: bootstrap, tree, page read/write (with `expectMod`
for conflicts), rename, move, delete, search, resolve, database read/view/cell
writes, attachment copy/upload, bookmark title lookup, and an event stream.
Every request carries a random per-run token, which is injected into the page.

## Not in scope

Sync, accounts, a block editor, rollups, relations between databases, plugins.
The point is a good desktop client for a folder of markdown, and the file format
is the promise.
