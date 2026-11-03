#!/bin/zsh
# Builds the zero-dependency macOS menu bar helper used by ordinary users.
# The Node relay remains a developer fallback; the distributed helper embeds the same protocol.
set -euo pipefail

ROOT="${0:A:h}"
SOURCE="$ROOT/main.swift"
INFO="$ROOT/Info.plist"
OUTPUT_DIR="$ROOT/../build"
APP="$OUTPUT_DIR/openGym Video Sync.app"
ZIP="$OUTPUT_DIR/openGym Video Sync.zip"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/opengym-video-sync-build.XXXXXX")"

cleanup() {
  rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$INFO" "$APP/Contents/Info.plist"

for ARCH in arm64 x86_64; do
  swiftc \
    -O \
    -parse-as-library \
    -swift-version 5 \
    -target "${ARCH}-apple-macosx12.0" \
    -framework AppKit \
    -framework Network \
    "$SOURCE" \
    -o "$BUILD_DIR/openGymVideoSync-$ARCH"
done

lipo -create \
  "$BUILD_DIR/openGymVideoSync-arm64" \
  "$BUILD_DIR/openGymVideoSync-x86_64" \
  -output "$APP/Contents/MacOS/openGymVideoSync"
chmod +x "$APP/Contents/MacOS/openGymVideoSync"

plutil -lint "$APP/Contents/Info.plist" >/dev/null
codesign --force --deep --sign - "$APP" >/dev/null

rm -f "$ZIP"
ditto -c -k --norsrc --noextattr --keepParent "$APP" "$ZIP"

print -r -- "$APP"
print -r -- "$ZIP"
