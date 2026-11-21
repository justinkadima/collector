// Command not1 is a local-first Notion-style notes app: markdown files in a
// folder you own, indexed in SQLite, wrapped in a native desktop window.
package main

import (
	"context"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"not1/internal/app"
	"not1/internal/config"
	"not1/internal/index"
	"not1/internal/mcpsrv"
	"not1/internal/server"
	"not1/internal/vault"
)

//go:embed web
var embedded embed.FS

// version tracks the git tag without the leading v, so `git tag v0.1` and
// `not1 -version` never disagree. Release builds can pin it:
//
//	go build -ldflags "-X main.version=0.2" -o not1 .
var version = "0.1"

func main() {
	// `not1 mcp` runs the Model Context Protocol server on stdin/stdout instead
	// of opening a window, so an agent can work on the same vault. It is a
	// subcommand rather than a flag because MCP clients configure a command line.
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		runMCP(os.Args[2:])
		return
	}

	var (
		workspace = flag.String("w", "", "folder to open (defaults to the last workspace)")
		port      = flag.Int("port", 0, "port to listen on (0 picks a free one)")
		browser   = flag.Bool("browser", false, "open in the default browser instead of a native window")
		debug     = flag.Bool("debug", false, "enable the web inspector")
		showVer   = flag.Bool("version", false, "print version and exit")
	)
	flag.Parse()

	if *showVer {
		fmt.Println("not1 " + version)
		return
	}

	web, err := fs.Sub(embedded, "web")
	if err != nil {
		log.Fatal(err)
	}

	store := config.Load()
	srv := server.New(store, web, "")
	defer srv.Close()

	root := *workspace
	if root == "" {
		root = store.Get().LastWorkspace
	}
	if root != "" {
		if _, err := srv.OpenWorkspace(root); err != nil {
			log.Printf("could not open %s: %v", root, err)
		} else {
			log.Printf("workspace: %s", root)
		}
	}

	url, err := srv.Listen(*port)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	title := "not1"
	if ws := store.Get().LastWorkspace; ws != "" {
		title = "not1 — " + filepath.Base(ws)
	}

	if *browser || os.Getenv("NOT1_BROWSER") == "1" {
		fmt.Printf("not1 running at %s\n", url)
		if os.Getenv("NOT1_NO_OPEN") != "1" {
			_ = openBrowser(url)
		}
		waitForSignal()
		return
	}

	if err := app.Run(url, title, *debug); err != nil {
		log.Printf("native window unavailable (%v); falling back to the browser", err)
		fmt.Printf("not1 running at %s\n", url)
		_ = openBrowser(url)
		waitForSignal()
	}
}

// runMCP serves the vault over stdio. stdout is the protocol channel, so
// diagnostics go to stderr only.
func runMCP(args []string) {
	fs := flag.NewFlagSet("mcp", flag.ExitOnError)
	workspace := fs.String("w", "", "folder to serve (defaults to the last workspace)")
	verbose := fs.Bool("log", false, "log tool calls to stderr")
	fs.Parse(args)

	root := *workspace
	if root == "" {
		root = config.Load().Get().LastWorkspace
	}
	if root == "" {
		log.Fatal("no vault: pass -w /path/to/vault or open one in not1 first")
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		log.Fatalf("workspace %s: %v", root, err)
	}
	v, err := vault.New(abs)
	if err != nil {
		log.Fatalf("open vault %s: %v", abs, err)
	}
	ix, err := index.Open(v.IndexPath())
	if err != nil {
		log.Fatalf("open index: %v", err)
	}
	defer ix.Close()
	if err := mcpsrv.Sync(v, ix); err != nil {
		log.Fatalf("index %s: %v", abs, err)
	}

	log.SetOutput(os.Stderr)
	log.SetPrefix("not1 mcp: ")
	if *verbose {
		log.Printf("serving %s", abs)
	}
	srv := mcpsrv.New(v, ix)
	if err := srv.Run(context.Background(), &mcp.StdioTransport{}); err != nil {
		log.Fatalf("mcp: %v", err)
	}
}

func waitForSignal() {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
	<-ch
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
