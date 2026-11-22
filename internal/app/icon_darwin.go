//go:build darwin && cgo

package app

/*
#cgo LDFLAGS: -framework Cocoa
#include <stdlib.h>
void collectorSetDockIcon(void *bytes, int len);
*/
import "C"

// setDockIcon hands the icon to AppKit so a plain `collector` binary looks like the
// app it is. Called on the main thread, which is where Run() lives.
func setDockIcon(png []byte) {
	if len(png) == 0 {
		return
	}
	buf := C.CBytes(png)
	defer C.free(buf)
	C.collectorSetDockIcon(buf, C.int(len(png)))
}
