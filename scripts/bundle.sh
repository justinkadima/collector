#!/bin/bash
# Build Collector.app for macOS.
#
#   ./scripts/bundle.sh            → dist/Collector.app, version from main.go
#   ./scripts/bundle.sh 0.5        → …with CFBundleShortVersionString 0.5
#   ./scripts/bundle.sh --run      → build it and open it
#
# The bundle is just a folder with a fixed shape: the executable, an Info.plist
# that names the icon, and the .icns that Finder and the Dock read. Nothing is
# installed, nothing is copied outside dist/.
set -euo pipefail
cd "$(dirname "$0")/.."

run=0
version=""
for arg in "$@"; do
	case "$arg" in
	--run) run=1 ;;
	*) version="$arg" ;;
	esac
done
if [ -z "$version" ]; then
	version=$(sed -n 's/^var version = "\(.*\)".*/\1/p' main.go)
fi
[ -n "$version" ] || { echo "bundle.sh: could not read the version from main.go" >&2; exit 1; }

[ -f assets/collector.icns ] || { echo "bundle.sh: assets/collector.icns is missing (run scripts/icon.sh)" >&2; exit 1; }

app="dist/Collector.app"
rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"

go build -ldflags "-X main.version=$version" -o "$app/Contents/MacOS/Collector" .
cp assets/collector.icns "$app/Contents/Resources/collector.icns"

cat > "$app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Collector</string>
	<key>CFBundleDisplayName</key><string>Collector</string>
	<key>CFBundleExecutable</key><string>Collector</string>
	<key>CFBundleIdentifier</key><string>app.collector.desktop</string>
	<key>CFBundleIconFile</key><string>collector</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleShortVersionString</key><string>$version</string>
	<key>CFBundleVersion</key><string>$version</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>LSMinimumSystemVersion</key><string>11.0</string>
	<key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>NSHumanReadableCopyright</key><string>Your files are yours.</string>
</dict>
</plist>
PLIST

plutil -lint "$app/Contents/Info.plist" >/dev/null || { echo "bundle.sh: Info.plist is malformed" >&2; exit 1; }

# Ad-hoc signature: enough for the local machine to treat the bundle as one app
# (stable identity for the Dock, the window's menu bar, and screen recording
# prompts) without any developer certificate.
codesign --force --sign - --timestamp=none "$app" >/dev/null 2>&1 ||
	echo "bundle.sh: codesign skipped (the bundle still runs)" >&2

echo "$app  ($version)"
[ "$run" = 1 ] && open "$app"
exit 0
