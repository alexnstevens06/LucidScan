#!/usr/bin/env python3
"""Validate LucidScan chrome_plugin/ for Load unpacked (no network)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # chrome_plugin/
REQUIRED = [
    "manifest.json",
    "background.js",
    "content.js",
    "offscreen.html",
    "offscreen.js",
    "popup.html",
    "popup.js",
    "popup.css",
    "lib/transformers.min.js",
    "lib/ort-wasm-simd-threaded.jsep.wasm",
    "lib/ort-wasm-simd-threaded.jsep.mjs",
    "test/sample.html",
]
CLAIM_PATTERNS = ("Detect AI", "AI-detected", "100% human", "AI verified")


def main() -> int:
    errors: list[str] = []
    for rel in REQUIRED:
        p = ROOT / rel
        if not p.is_file():
            errors.append(f"missing file: {rel}")
        elif p.stat().st_size == 0:
            errors.append(f"empty file: {rel}")

    man_path = ROOT / "manifest.json"
    if man_path.is_file():
        try:
            m = json.loads(man_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            errors.append(f"manifest.json invalid JSON: {e}")
            m = None
        if m is not None:
            if m.get("manifest_version") != 3:
                errors.append("manifest_version must be 3")
            for key in ("name", "version", "background", "action"):
                if key not in m:
                    errors.append(f"manifest missing key: {key}")
            bg = m.get("background") or {}
            if not bg.get("service_worker"):
                errors.append("background.service_worker required")
            csp = (m.get("content_security_policy") or {}).get("extension_pages", "")
            if "wasm-unsafe-eval" not in csp:
                errors.append("CSP extension_pages should allow wasm-unsafe-eval")
            # Inject-only: must NOT declare broad static content_scripts
            if m.get("content_scripts"):
                errors.append(
                    "content_scripts should be absent (inject-only after Enable badges on this site)"
                )
            perms = set(m.get("permissions") or [])
            for need in ("scripting", "activeTab", "storage"):
                if need not in perms:
                    errors.append(f"permissions missing: {need}")
            if not m.get("optional_host_permissions"):
                errors.append("optional_host_permissions missing for per-site enable")

    # Scan UI sources for accuracy-claim strings (allow negation in comments/docs)
    for rel in ("popup.html", "popup.js", "background.js", "content.js", "offscreen.js"):
        p = ROOT / rel
        if not p.is_file():
            continue
        text = p.read_text(encoding="utf-8", errors="replace")
        for pat in CLAIM_PATTERNS:
            # Allow mentions that explicitly say never/not to claim
            for i, line in enumerate(text.splitlines(), 1):
                if pat in line and not any(
                    n in line.lower()
                    for n in ("never", "not an", "no authenticity", "don't", "do not", "— never")
                ):
                    # background context menu titles must not say Detect AI
                    if pat in line:
                        errors.append(f"possible accuracy-claim in {rel}:{i}: {line.strip()[:100]}")

    if errors:
        print("FAIL")
        for e in errors:
            print(" -", e)
        return 1
    print("PASS")
    print(f" root: {ROOT}")
    print(f" manifest: {json.loads(man_path.read_text())['name']} v{json.loads(man_path.read_text())['version']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
