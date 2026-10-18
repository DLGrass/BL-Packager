#!/usr/bin/env bash
# Build hosts/linux/build/bl-player from the resources src/pack-app.js wrote.
#
#   node src/pack-app.js project.sb3 --target linux        # writes build/
#   hosts/linux/build.sh                                   # compiles + packages
#
# Needs a C compiler and the GTK3 + WebKit2GTK development packages:
#   Debian/Ubuntu  sudo apt install build-essential pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev
#   Fedora         sudo dnf install gcc pkgconf-pkg-config gtk3-devel webkit2gtk4.1-devel
#   Arch           sudo pacman -S base-devel pkgconf gtk3 webkit2gtk-4.1
#
# WebKitGTK 4.0 is not supported: 4.1 is the same engine with a different (and
# current) ABI, and the probe uses webkit_web_view_evaluate_javascript, which 4.0
# does not have. The version check below says so instead of failing at link time.
#
# The payload is embedded, not shipped beside the binary: build/blob.S is nothing
# but two .incbin directives, so `bl-player` is one file that can be copied
# anywhere. That is what makes the size story `binary = host + gzip(html)`.

set -euo pipefail
cd "$(dirname "$0")"

BUILD=build
die() { echo "error: $*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "this script only runs on Linux (uname says $(uname -s))"
command -v cc >/dev/null || die "no C compiler (build-essential)"
command -v pkg-config >/dev/null || die "pkg-config not found"
pkg-config --exists gtk+-3.0 || die "GTK3 development files missing (libgtk-3-dev)"
pkg-config --exists webkit2gtk-4.1 \
  || die "WebKit2GTK 4.1 development files missing (libwebkit2gtk-4.1-dev)"
pkg-config --atleast-version=2.40 webkit2gtk-4.1 \
  || die "WebKit2GTK 2.40+ is required for webkit_web_view_evaluate_javascript (found $(pkg-config --modversion webkit2gtk-4.1))"
[ -f "$BUILD/app.meta" ] \
  || die "build/app.meta is missing — run: node src/pack-app.js <project.sb3> --target linux"

meta() { sed -n "s/^$1=//p" "$BUILD/app.meta" | head -1; }

NAME="$(meta name)";       [ -n "$NAME" ]    || NAME=bl-player
VERSION="$(meta version)"; [ -n "$VERSION" ] || VERSION=1.0.0
ID="$(meta id)";           [ -n "$ID" ]      || ID=dev.bilup.player
ARCH="$(uname -m)"

if grep -q '^gzip=0$' "$BUILD/app.meta"; then
  echo "note: payload stored uncompressed (gzip=0)"
fi

# .incbin is the whole trick: the assembler pastes the bytes into .rodata and the
# linker does not care how big they are, so nothing has to parse a container at
# runtime or find a file next to the executable.
echo "==> generating build/blob.S"
cat > "$BUILD/blob.S" <<'ASM'
    .section .rodata
    .balign 16
    .global payload_start
payload_start:
    .incbin "build/app.html.gz"
    .global payload_end
payload_end:
    .balign 16
    .global meta_start
meta_start:
    .incbin "build/app.meta"
    .global meta_end
meta_end:
    .text
ASM

echo "==> compiling src/main.c"
# -Wextra on purpose: this host is ~500 lines and every warning it can give is a
# warning about an unused callback parameter or a signed/unsigned slip.
cc -O2 -Wall -Wextra \
  -o "$BUILD/bl-player" \
  src/main.c "$BUILD/blob.S" \
  $(pkg-config --cflags --libs gtk+-3.0 webkit2gtk-4.1) \
  -lz -lpthread

# Symbols in a 600-line host are worth little; the payload's bytes are what the
# binary is made of, and stripping only touches the code side.
if command -v strip >/dev/null; then strip --strip-unneeded "$BUILD/bl-player" || true; fi

# A tarball with the standard install layout, so `make install`-style copying
# puts the .desktop file where a launcher will actually find the icon.
echo "==> packaging"
PKG="$BUILD/$NAME-linux"
rm -rf "$PKG"
mkdir -p "$PKG/share/icons/hicolor/256x256/apps"
cp "$BUILD/bl-player" "$PKG/bl-player"
cp "$BUILD/bl-player.desktop" "$PKG/bl-player.desktop"
if [ -f "$BUILD/app.png" ]; then
  cp "$BUILD/app.png" "$PKG/share/icons/hicolor/256x256/apps/$ID.png"
fi
TARBALL="$BUILD/$NAME-$VERSION-linux-$ARCH.tar.gz"
rm -f "$TARBALL"
tar -czf "$TARBALL" -C "$BUILD" "$NAME-linux"

ABS="$(cd "$BUILD" && pwd)"
echo "BUILD OK  $NAME  ($(du -h "$BUILD/bl-player" | cut -f1) on disk)"
echo "ARTIFACT $ABS/bl-player"
echo "ARTIFACT $ABS/$NAME-$VERSION-linux-$ARCH.tar.gz"
