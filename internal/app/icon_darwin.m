// Giving a bare executable a Dock icon. There is no bundle around `./collector`, so
// AppKit has nothing to read the .icns from; the same PNG the binary carries is
// handed to NSApplication instead. Called once, from the main thread, after the
// NSApplication exists.

#import <Cocoa/Cocoa.h>

void collectorSetDockIcon(void *bytes, int len) {
	NSData *data = [NSData dataWithBytes:bytes length:(NSUInteger)len];
	if (data == nil) {
		return;
	}
	NSImage *image = [[NSImage alloc] initWithData:data];
	if (image == nil) {
		return;
	}
	[NSApplication sharedApplication].applicationIconImage = image;
}
