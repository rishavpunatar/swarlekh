#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_DIR="${SWARLEKH_DATA_DIR:-$ROOT/evaluation/data}"
ZIP="$DATA_DIR/vocadito.zip"
DEST="$DATA_DIR/vocadito"
URL="https://zenodo.org/api/records/5578807/files/vocadito.zip/content"
EXPECTED_MD5="dea40fd18f14d899643c4ba221b33a46"

mkdir -p "$DATA_DIR" "$DEST"
if [[ ! -f "$ZIP" ]]; then
  curl -fL --retry 3 --progress-bar "$URL" -o "$ZIP"
fi

if command -v md5 >/dev/null 2>&1; then
  ACTUAL_MD5="$(md5 -q "$ZIP")"
else
  ACTUAL_MD5="$(md5sum "$ZIP" | awk '{print $1}')"
fi

if [[ "$ACTUAL_MD5" != "$EXPECTED_MD5" ]]; then
  echo "Checksum mismatch for $ZIP" >&2
  echo "Expected $EXPECTED_MD5, got $ACTUAL_MD5" >&2
  exit 1
fi

unzip -q -o "$ZIP" -d "$DEST"
echo "Vocadito ready at $DEST"
