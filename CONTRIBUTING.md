# Contributing

Thanks for looking. This is a small program with one opinion, and the opinion is
in the README: **the files on disk are the truth, and the app is a window onto
them.** A change that stores your text anywhere else — a cache that outlives the
file, a block id, a sidecar index of attachments — will be turned down however
nice it looks.

## Getting it running

```sh
go build -o collector .
./collector -w /tmp/vault        # a folder of .md files, any folder
```

`/tmp/vault` can be an empty directory: the app will offer to create pages in
it. `-browser` serves the same UI over http instead of opening a window, and
works with `CGO_ENABLED=0` — that is how the Windows and no-cgo builds run.

The web assets are embedded with `//go:embed`, so **any edit under `web/` needs a
rebuild and a relaunch.** There is no dev server and no watch mode on purpose:
no build step means no build step to configure.

## Before you open a pull request

```sh
gofmt -l .          # must print nothing
go vet ./...
go test ./...
CGO_ENABLED=0 go build ./...          # the stub path must keep compiling
for f in web/*.js; do node --check "$f"; done
```

CI runs exactly this on macOS, Linux and Windows. If it is green there, it is
green here.

## How to send a change

- **One behaviour per commit.** The log is documentation; a commit message says
  what the program now does and why, not which files moved. Read `git log` before
  writing yours.
- **Say what breaks.** If a change touches the markdown grammar (frontmatter
  keys, the events fence, table cells), it touches people's files. Say so in the
  message, and make the parser accept what it used to accept.
- **Duplicated grammar is deliberate.** `internal/vault/events.go` and
  `web/markdown.js` both parse event lines; the Go test pins the grammar and the
  JS has to agree. Do not "unify" them into a round trip.
- **No new runtime dependencies in the UI.** `web/` is plain ES modules with no
  framework and no bundler, and it stays that way.
- **Go dependencies need a reason.** SQLite, fsnotify, the MCP SDK and the
  webview binding are the whole list.

## Reporting a bug

Include the app version (`collector -version`), your OS, and the smallest page
that shows the problem — paste the markdown, not a screenshot of it. If a file
was written wrong, the file is the bug report.

## License

Contributions are MIT, same as the project (see `LICENSE`).
