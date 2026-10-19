#!/usr/bin/env bash
# LucidScan offline checks (no browser, no network): manifest/policy + Node unit tests.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in chrome_plugin/background.js chrome_plugin/content.js chrome_plugin/popup.js; do node --check "$f"; done
python3 chrome_plugin/scripts/health_check.py
node --test chrome_plugin/test/unit/
