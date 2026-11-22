//go:build !cgo || !(darwin || linux || windows)

package app

import "errors"

// Run is unavailable when the binary is built without cgo or on an
// unsupported platform; main falls back to the browser.
func Run(url, title string, debug bool, icon []byte) error {
	return errors.New("native window not supported in this build")
}
