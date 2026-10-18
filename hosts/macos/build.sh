#!/usr/bin/env bash
# Build hosts/macos/build/<name>.app from the resources src/pack-app.js wrote.
#
#   node src/pack-app.js project.sb3 --target macos        # writes build/
#   hosts/macos/build.sh                                   # compiles + packages
#
# Needs macOS + clang (Xcode or the Command Line Tools). Nothing is downloaded:
# Cocoa, WebKit and zlib are part of the SDK.
#
# The result is  bundle = host code + gzip(packed html)  — the .app is a
# directory, so the payload is a plain file under Contents/Resources instead of
# an embedded resource (which is what the Linux host has to do to stay one file).

set -euo pipefail
cd "$(dirname "$0")"

BUILD=build
MIN_MACOS="${MIN_MACOS:-11.0}"

die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this script only runs on macOS (uname says $(uname -s))"
command -v clang >/dev/null || die "clang not found; install the Xcode Command Line Tools"
[ -f "$BUILD/app.meta" ] || die "build/app.meta is missing — run: node src/pack-app.js <project.sb3> --target macos"
[ -f "$BUILD/Info.plist" ] || die "build/Info.plist is missing — rerun src/pack-app.js"

meta() { sed -n "s/^$1=//p" "$BUILD/app.meta" | head -1; }

NAME="$(meta name)";   [ -n "$NAME" ]  || NAME=bl-player
TITLE="$(meta title)"; [ -n "$TITLE" ] || TITLE="$NAME"
APP="$BUILD/$NAME.app"

if grep -q '^gzip=0$' "$BUILD/app.meta"; then
  # The file keeps its name; `gzip=0` is what tells the host the bytes are raw.
  echo "note: payload stored uncompressed (gzip=0)"
fi

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/app.meta"          "$APP/Contents/Resources/app.meta"
cp "$BUILD/app.html.gz"       "$APP/Contents/Resources/app.html.gz"
cp "$BUILD/Info.plist"        "$APP/Contents/Info.plist"

echo "==> compiling src/main.m"
# -fobjc-arc: the host is small and ARC keeps the COM-ish refcounting out of it.
# No -O3: startup is dominated by the page, not by 1700 lines of host code.
clang -fobjc-arc -O2 -Wall -Wextra -mmacosx-version-min="$MIN_MACOS" \
  -framework Cocoa -framework WebKit -lz \
  src/main.m -o "$APP/Contents/MacOS/$NAME"

# An icon is optional and it is a .png at this point: iconutil wants an .iconset
# directory of exact sizes, and sips is the only resampler guaranteed present.
if [ -f "$BUILD/app.png" ]; then
  echo "==> building AppIcon.icns"
  ICONSET="$BUILD/AppIcon.iconset"
  rm -rf "$ICONSET"
  mkdir -p "$ICONSET"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$BUILD/app.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$BUILD/app.png" \
      --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
fi

# Ad-hoc signature: arm64 refuses to launch an unsigned binary, and signing also
# makes the bundle behave with Gatekeeper on the machine that built it. It is not
# notarized — distributing it to other Macs still needs a Developer ID (README 9.1).
echo "==> ad-hoc signing"
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 \
  || echo "warning: ad-hoc codesign failed; the app may refuse to start on Apple silicon" >&2

echo "==> packaging"
rm -f "$BUILD/$NAME.zip" "$BUILD/$NAME.dmg"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$BUILD/$NAME.zip"
if command -v hdiutil >/dev/null; then
  # A volume name cannot contain '/', and a title legally can.
  hdiutil create -quiet -volname "${TITLE//\//-}" -srcfolder "$APP" -ov -format UDZO \
    "$BUILD/$NAME.dmg" >/dev/null || rm -f "$BUILD/$NAME.dmg"
fi

ABS="$(cd "$BUILD" && pwd)"
echo "BUILD OK  $NAME  ($TITLE)"
echo "ARTIFACT $ABS/$NAME.app"
echo "ARTIFACT $ABS/$NAME.zip"
if [ -f "$BUILD/$NAME.dmg" ]; then echo "ARTIFACT $ABS/$NAME.dmg"; fi
