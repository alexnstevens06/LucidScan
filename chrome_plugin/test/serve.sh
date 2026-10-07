#!/usr/bin/env bash
# Serve LucidScan sample page over http so Enable badges works (file:// is blocked).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-8765}"
cd "$ROOT"
echo "LucidScan sample server"
echo "  Extension root: $ROOT"
echo "  Open: http://127.0.0.1:${PORT}/test/sample.html"
echo "  Then: LucidScan popup → Enable badges on this site (or Alt+Shift+L)"
echo "  Ctrl+C to stop"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
