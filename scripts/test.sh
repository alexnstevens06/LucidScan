#!/usr/bin/env bash
# LucidScan offline checks (no browser, no network): manifest/policy + Node unit tests.
set -euo pipefail
cd "$(dirname "$0")/.."
for f in chrome_plugin/background.js chrome_plugin/content.js chrome_plugin/popup.js; do node --check "$f"; done
python3 chrome_plugin/scripts/health_check.py
# Pass the test files explicitly. Node 22 treats a directory argument as a script
# (MODULE_NOT_FOUND) instead of walking it; Node 20 still recurses. *.test.js is the
# same set either way (helpers extract.js / fake-page.js are not tests).
node --test chrome_plugin/test/unit/*.test.js
