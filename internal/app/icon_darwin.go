//go:build darwin && cgo

package app

/*
#cgo LDFLAGS: -framework Cocoa
#include <stdlib.h>
void not1SetDockIcon(void *bytes, int len);
*/
import "C"

// setDockIcon hands the icon to AppKit so a plain `not1` binary looks like the
// app it is. Called on the main thread, which is where Run() lives.
func setDockIcon(png []byte) {
	if len(png) == 0 {
		return
	}
	buf := C.CBytes(png)
	defer C.free(buf)
	C.not1SetDockIcon(buf, C.int(len(png)))
}
