#!/usr/bin/env bash
# Build hosts/android/build/<name>-<version>.apk from the resources
# src/pack-app.js wrote.
#
#   node src/pack-app.js project.sb3 --target android      # writes build/
#   hosts/android/build.sh                                 # compiles + signs
#
# No Gradle and no androidx: this is aapt2 + javac + d8 + zipalign + apksigner,
# all of which ship in the Android SDK/JDK you already installed. A Gradle project
# would drag in an AGP/Gradle/JDK version matrix and a dependency resolution step
# for the sake of one Activity that only uses framework classes.
#
# Environment:
#   ANDROID_HOME (or ANDROID_SDK_ROOT)   required; CI has it preinstalled
#   BL_KEYSTORE, BL_KEYSTORE_PASS, BL_KEY_PASS, BL_KEY_ALIAS
#                                       sign with a real key. Without them the APK
#                                       is signed with a generated debug key,
#                                       which is installable but not publishable.
#
# The output is  apk = host code + gzip(packed html)  — the payload rides in
# assets/, which is a zip entry inside the APK, so it stays compressed.

set -euo pipefail
cd "$(dirname "$0")"

BUILD=build
MIN_SDK="${MIN_SDK:-24}"

die() { echo "error: $*" >&2; exit 1; }
meta() { sed -n "s/^$1=//p" "$BUILD/app.meta" | head -1; }

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
[ -n "$SDK" ] || die "ANDROID_HOME / ANDROID_SDK_ROOT is not set"
[ -d "$SDK" ] || die "$SDK does not exist"
[ -f "$BUILD/AndroidManifest.xml" ] \
  || die "build/AndroidManifest.xml is missing — run: node src/pack-app.js <project.sb3> --target android"

BUILD_TOOLS="$(ls -d "$SDK"/build-tools/*/ 2>/dev/null | sort -V | tail -1)"
PLATFORM="$(ls -d "$SDK"/platforms/android-*/ 2>/dev/null | sort -V | tail -1)"
[ -n "$BUILD_TOOLS" ] || die "no build-tools installed under $SDK/build-tools"
[ -n "$PLATFORM" ] || die "no platforms installed under $SDK/platforms"

AAPT2="$BUILD_TOOLS/aapt2"
D8="$BUILD_TOOLS/d8"
ZIPALIGN="$BUILD_TOOLS/zipalign"
APKSIGNER="$BUILD_TOOLS/apksigner"
for tool in "$AAPT2" "$D8" "$ZIPALIGN" "$APKSIGNER"; do
  [ -x "$tool" ] || die "$tool is missing (build-tools $BUILD_TOOLS is incomplete)"
done
command -v javac >/dev/null || die "javac not found; install a JDK (17 works)"
command -v keytool >/dev/null || die "keytool not found; it ships with the JDK"
command -v zip >/dev/null || die "zip not found"

TARGET_SDK="$(basename "$PLATFORM")"
TARGET_SDK="${TARGET_SDK#android-}"

NAME="$(meta name)";       [ -n "$NAME" ]    || NAME=bl-player
VERSION="$(meta version)"; [ -n "$VERSION" ] || VERSION=1.0.0

APK_DIR="$BUILD/apk"
rm -rf "$APK_DIR"
mkdir -p "$APK_DIR/classes" "$APK_DIR/dex"

# 1. Resources -> flat compiled entries. --dir res would also work but a zip is
#    what link expects next and it keeps the intermediate inspectable.
echo "==> aapt2 compile"
"$AAPT2" compile --dir res -o "$APK_DIR/res.zip"

# 2. Manifest + resources + assets -> an unsigned APK. -A is what puts
#    app.html.gz/app.meta where AssetManager.open() looks for them.
echo "==> aapt2 link (min sdk $MIN_SDK, target sdk $TARGET_SDK)"
"$AAPT2" link \
  -o "$APK_DIR/base.apk" \
  -I "$PLATFORM/android.jar" \
  --manifest "$BUILD/AndroidManifest.xml" \
  -A "$BUILD/assets" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  "$APK_DIR/res.zip"

# 3. Java -> .class. -source 8 is the level d8 is happiest with and the host uses
#    no newer language features; --release cannot be combined with -bootclasspath.
echo "==> javac"
javac -source 8 -target 8 -encoding UTF-8 \
  -bootclasspath "$PLATFORM/android.jar" \
  -d "$APK_DIR/classes" \
  java/dev/bilup/player/MainActivity.java

# 4. .class -> dex. d8 also desugars, which is why -source 8 is enough.
echo "==> d8"
# shellcheck disable=SC2046
"$D8" --min-api "$MIN_SDK" --lib "$PLATFORM/android.jar" \
  --output "$APK_DIR/dex" \
  $(find "$APK_DIR/classes" -name '*.class')

# 5. classes.dex lives at the archive root, so it is added with -j (junk paths).
echo "==> packaging"
(cd "$APK_DIR" && zip -q -j base.apk dex/classes.dex)
# zipalign before signing: it rewrites the archive, which would invalidate a
# signature made earlier. apksigner after zipalign is the required order.
"$ZIPALIGN" -f 4 "$APK_DIR/base.apk" "$APK_DIR/aligned.apk"

# 6. Sign. A debug key keeps the output installable out of the box; publishing
#    needs the four BL_* variables above (Play refuses a debug certificate).
if [ -n "${BL_KEYSTORE:-}" ]; then
  KEYSTORE="$BL_KEYSTORE"
  STORE_PASS="${BL_KEYSTORE_PASS:-}"
  KEY_PASS="${BL_KEY_PASS:-$STORE_PASS}"
  KEY_ALIAS="${BL_KEY_ALIAS:-}"
  [ -n "$STORE_PASS" ] || die "BL_KEYSTORE_PASS is empty"
  [ -n "$KEY_ALIAS" ] || die "BL_KEY_ALIAS is empty"
  echo "==> signing with $KEYSTORE"
else
  KEYSTORE="$BUILD/debug.keystore"
  STORE_PASS=android
  KEY_PASS=android
  KEY_ALIAS=androiddebugkey
  if [ ! -f "$KEYSTORE" ]; then
    echo "==> generating a debug keystore (installable, not publishable)"
    keytool -genkeypair -keystore "$KEYSTORE" \
      -storepass "$STORE_PASS" -keypass "$KEY_PASS" \
      -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
      -dname "CN=Android Debug,O=Android,C=US" >/dev/null
  fi
fi

APK="$BUILD/$NAME-$VERSION.apk"
rm -f "$APK"
"$APKSIGNER" sign \
  --ks "$KEYSTORE" \
  --ks-pass "pass:$STORE_PASS" \
  --key-pass "pass:$KEY_PASS" \
  --ks-key-alias "$KEY_ALIAS" \
  --out "$APK" \
  "$APK_DIR/aligned.apk"
"$APKSIGNER" verify "$APK" >/dev/null || die "the APK did not verify after signing"

ABS="$(cd "$BUILD" && pwd)"
echo "BUILD OK  $NAME $VERSION  (min sdk $MIN_SDK, target sdk $TARGET_SDK)"
echo "ARTIFACT $ABS/$NAME-$VERSION.apk"
