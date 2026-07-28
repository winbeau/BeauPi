#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="${BEAUPI_BIN_DIR:-$HOME/.local/bin}"
TARGET="$BIN_DIR/beaupi"
SOURCE="$REPO_ROOT/beaupi-test.sh"

mkdir -p "$BIN_DIR"
ln -sfn "$SOURCE" "$TARGET"

printf 'Installed development command: %s -> %s\n' "$TARGET" "$SOURCE"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf 'Add %s to PATH before running beaupi.\n' "$BIN_DIR" ;;
esac
