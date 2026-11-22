//go:build !darwin || !cgo

package app

// setDockIcon is a no-op away from AppKit: Windows takes its icon from the
// executable's resources and Linux from the .desktop file, neither of which a
// running process can set.
func setDockIcon([]byte) {}
