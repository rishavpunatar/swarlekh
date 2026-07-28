#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$ROOT/server/.venv/bin/python"
MODEL_ROOT="$ROOT/server/models"
GAME_NAME="GAME-1.0.3-small-onnx"
GAME_DIR="$MODEL_ROOT/$GAME_NAME"
GAME_URL="https://github.com/openvpi/GAME/releases/download/v1.0.3/$GAME_NAME.zip"
GAME_SHA256="00ba0c64115b6b874d9ea4afd3e6cf822abda2a04e52569233b0a044fd40e4e8"
RMVPE_SHA256="5370e71ac80af8b4b7c793d27efd51fd8bf962de3a7ede0766dac0befa3660fd"

if [[ ! -x "$PYTHON" ]]; then
  echo "Missing $PYTHON. Create the server environment first (see server/README.md)." >&2
  exit 1
fi

mkdir -p "$MODEL_ROOT"
if [[ -f "$GAME_DIR/encoder.onnx" && -f "$GAME_DIR/segmenter.onnx" &&
      -f "$GAME_DIR/estimator.onnx" && -f "$GAME_DIR/bd2dur.onnx" ]]; then
  echo "GAME model already installed: $GAME_DIR"
else
  if [[ -e "$GAME_DIR" ]]; then
    echo "Incomplete GAME model directory exists: $GAME_DIR" >&2
    echo "Move it aside, then run this installer again." >&2
    exit 1
  fi
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading GAME 1.0.3 small ONNX..."
  curl --fail --location --output "$TMP/$GAME_NAME.zip" "$GAME_URL"
  printf '%s  %s\n' "$GAME_SHA256" "$TMP/$GAME_NAME.zip" |
    LC_ALL=C LANG=C shasum -a 256 --check
  unzip -q "$TMP/$GAME_NAME.zip" -d "$TMP"
  mv "$TMP/$GAME_NAME" "$GAME_DIR"
  echo "Installed GAME model: $GAME_DIR"
fi

echo "Downloading and verifying RMVPE if it is not already installed..."
RMVPE_PATH="$("$PYTHON" -c \
  'from rmvpe_onnx.weights import ensure_model; print(ensure_model())')"
printf '%s  %s\n' "$RMVPE_SHA256" "$RMVPE_PATH" |
  LC_ALL=C LANG=C shasum -a 256 --check
echo "RMVPE model: $RMVPE_PATH"
echo "Singing models are ready."
