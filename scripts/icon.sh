#!/bin/bash
# Turn assets/icon.svg into the two files the app actually uses:
#
#   assets/not1.icns      what Finder, the Dock and Spotlight read out of the
#                         .app bundle that scripts/bundle.sh assembles
#   assets/not1-512.png   embedded in the binary, so a plain ./not1 shows the
#                         same icon in the Dock as the bundle does in Finder
#
# The drawing has to keep its transparent corners: the Dock draws an app icon
# exactly as it finds it, square edges and all. QuickLook flattens SVG onto
# white, so the raster comes from a Chromium in headless mode instead, which
# honours --default-background-color=00000000.
#
# The PNG/ICNS outputs are checked in; this only needs to run when
# assets/icon.svg changes. Requires macOS (iconutil, sips) and a Chromium.
set -euo pipefail
cd "$(dirname "$0")/.."

find_chromium() {
	for app in "Google Chrome" "Chromium" "Brave Browser" "Microsoft Edge" "Google Chrome Canary"; do
		for dir in "/Applications" "$HOME/Applications"; do
			bin="$dir/$app.app/Contents/MacOS/$app"
			[ -x "$bin" ] && { printf '%s' "$bin"; return 0; }
		done
	done
	return 1
}

chrome=$(find_chromium) || {
	echo "icon.sh: no Chromium found; install one, or leave assets/not1.icns and assets/not1-512.png alone" >&2
	exit 1
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

svg="$PWD/assets/icon.svg"
cat > "$tmp/page.html" <<HTML
<body style="margin:0;background:transparent">
<img src="file://$svg" width="1024" height="1024" style="display:block">
</body>
HTML

"$chrome" --headless=new --disable-gpu --hide-scrollbars \
	--default-background-color=00000000 --user-data-dir="$tmp/profile" \
	--window-size=1024,1024 --screenshot="$tmp/master.png" \
	"file://$tmp/page.html" >/dev/null 2>&1

[ -f "$tmp/master.png" ] || { echo "icon.sh: Chromium produced no screenshot" >&2; exit 1; }

# A white matte behind the tile would show up as a square in the Dock, so read
# the top-left pixel back out of the PNG and refuse to ship anything opaque.
corner=$(python3 - "$tmp/master.png" <<'PY'
import struct, sys, zlib

data = open(sys.argv[1], "rb").read()
pos, idat = 8, b""
while pos < len(data):
    n = struct.unpack(">I", data[pos:pos + 4])[0]
    kind = data[pos + 4:pos + 8]
    body = data[pos + 8:pos + 8 + n]
    if kind == b"IHDR":
        w, h, depth, color = struct.unpack(">IIBB", body[:10])
    elif kind == b"IDAT":
        idat += body
    pos += 12 + n

bpp = {2: 3, 6: 4}.get(color)          # 8-bit RGB / RGBA only
if depth != 8 or bpp is None:
    print("unsupported-png")
    raise SystemExit
raw = zlib.decompress(idat)
filt, row = raw[0], bytearray(raw[1:1 + w * bpp])

# No row above the first one, so every filter collapses to this.
for i in range(len(row)):
    left = row[i - bpp] if i >= bpp else 0
    if filt in (1, 4):
        row[i] = (row[i] + left) & 0xFF
    elif filt == 3:
        row[i] = (row[i] + left // 2) & 0xFF

print(row[3] if bpp == 4 else 255)     # alpha of the corner pixel
PY
)
[ "$corner" = "0" ] || { echo "icon.sh: the raster has no transparent corner (alpha=$corner)" >&2; exit 1; }

sips -z 1024 1024 "$tmp/master.png" --out "$tmp/square.png" >/dev/null

set="$tmp/not1.iconset"
mkdir -p "$set"
for size in 16 32 128 256 512; do
	sips -z "$size" "$size" "$tmp/square.png" --out "$set/icon_${size}x${size}.png" >/dev/null
	sips -z "$((size * 2))" "$((size * 2))" "$tmp/square.png" --out "$set/icon_${size}x${size}@2x.png" >/dev/null
done
sips -z 512 512 "$tmp/square.png" --out assets/not1-512.png >/dev/null
cp "$tmp/square.png" assets/not1-1024.png
iconutil -c icns "$set" -o assets/not1.icns

echo "assets/not1.icns"
echo "assets/not1-512.png"
echo "assets/not1-1024.png"
