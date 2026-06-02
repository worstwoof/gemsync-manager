#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

chmod +x "$ROOT/start.command" "$ROOT/setup-mac.command" "$ROOT/scripts/setup-mac.sh" 2>/dev/null || true
"$ROOT/scripts/setup-mac.sh"

read -r "?Setup finished. Press Enter to close..."
