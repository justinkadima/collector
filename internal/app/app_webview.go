//go:build cgo && (darwin || linux || windows)

// Package app wraps the UI in a native OS window (WebKit / WebView2 / GTK).
package app

import (
	"errors"

	webview "github.com/webview/webview_go"
)

func Run(url, title string, debug bool) error {
	w := webview.New(debug)
	if w == nil {
		return errors.New("webview init failed")
	}
	defer w.Destroy()
	w.SetTitle(title)
	w.SetSize(1280, 860, webview.HintNone)

	// The page title lives in the frontend; mirror it into the window chrome.
	_ = w.Bind("not1SetTitle", func(s string) string {
		w.Dispatch(func() { w.SetTitle(s) })
		return ""
	})

	w.Navigate(url)
	w.Run()
	return nil
}
