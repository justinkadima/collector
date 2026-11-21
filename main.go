// Command not1 is a local-first Notion-style notes app: markdown files in a
// folder you own, indexed in SQLite, wrapped in a native desktop window.
package main

import (
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

	"not1/internal/app"
	"not1/internal/config"
	"not1/internal/server"
)

//go:embed web
var embedded embed.FS

// version tracks the git tag without the leading v, so `git tag v0.1` and
// `not1 -version` never disagree. Release builds can pin it:
//
//	go build -ldflags "-X main.version=0.2" -o not1 .
var version = "0.1"

func main() {
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
