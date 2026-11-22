//go:build cgo && (darwin || linux || windows)

// Package app wraps the UI in a native OS window (WebKit / WebView2 / GTK).
package app

import (
	"errors"

	webview "github.com/webview/webview_go"
)

// Run opens the native window. `icon` is a PNG, if the binary carries one: it
// gives an unbundled executable the same Dock icon as the .app.
func Run(url, title string, debug bool, icon []byte) error {
	w := webview.New(debug)
	if w == nil {
		return errors.New("webview init failed")
	}
	defer w.Destroy()
	w.SetTitle(title)
	w.SetSize(1280, 860, webview.HintNone)

	// The page title lives in the frontend; mirror it into the window chrome.
	_ = w.Bind("collectorSetTitle", func(s string) string {
		w.Dispatch(func() { w.SetTitle(s) })
		return ""
	})

	// On the main thread, once the application object exists.
	w.Dispatch(func() { setDockIcon(icon) })

	w.Navigate(url)
	w.Run()
	return nil
}
