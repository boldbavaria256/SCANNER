#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/app/src/main/assets/opencv.js"
URL="https://docs.opencv.org/4.13.0/opencv.js"
mkdir -p "$(dirname "$TARGET")"
if [[ -f "$TARGET" ]] && [[ $(wc -c < "$TARGET") -ge 5000000 ]]; then
  echo "OpenCV.js already bundled: $TARGET"
  exit 0
fi
curl -fL --retry 3 "$URL" -o "$TARGET.tmp"
if [[ $(wc -c < "$TARGET.tmp") -lt 5000000 ]]; then
  echo "Downloaded OpenCV.js is unexpectedly small." >&2
  rm -f "$TARGET.tmp"
  exit 1
fi
mv "$TARGET.tmp" "$TARGET"
echo "Bundled OpenCV.js: $TARGET"
