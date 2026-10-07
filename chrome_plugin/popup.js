function paintLastScan(scan) {
  const scoreEl = document.getElementById("confidence-score");
  const typeEl = document.getElementById("content-type");
  const labelEl = document.getElementById("score-label");
  const circle = document.querySelector(".score-circle");
  if (!scan) {
    scoreEl.textContent = "—";
    typeEl.textContent = "—";
    return;
  }
  labelEl.textContent = scan.label || "local score";
  typeEl.textContent = scan.contentType || "—";
  if (scan.confidence == null || Number.isNaN(Number(scan.confidence))) {
    scoreEl.textContent = scan.label === "offline" ? "offline" : "—";
    circle.style.background = "conic-gradient(#2a3b55 100%, #2a3b55 100%)";
    return;
  }
  const pct = Math.round(Number(scan.confidence) * 100);
  scoreEl.textContent = `${pct}`;
  circle.style.background = `conic-gradient(#6bc4a0 ${pct}%, #2a3b55 ${pct}%)`;
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("badge-toggle");
  const status = document.getElementById("status");
  const enableBtn = document.getElementById("enable-hosts");

  chrome.storage.local.get({ badgeModeEnabled: true, lastScan: null }, (r) => {
    toggle.checked = r.badgeModeEnabled !== false;
    paintLastScan(r.lastScan);
  });

  toggle.addEventListener("change", () => {
    chrome.storage.local.set({ badgeModeEnabled: toggle.checked });
  });

  enableBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "requestBadgeHosts" }, (resp) => {
      status.textContent = resp && resp.granted
        ? "Site access granted (optional hosts)."
        : "Host permission not granted — badges may be limited on some pages.";
    });
  });

  chrome.runtime.sendMessage({ type: "getInferenceStatus" }, (resp) => {
    if (chrome.runtime.lastError) {
      status.textContent = "Inference: starting… (mock local scores)";
      return;
    }
    const mode = (resp && resp.mode) || "mock";
    status.textContent =
      mode === "mock"
        ? "Inference: mock local scores (M1). Transformers.js wiring is M2/M3."
        : `Inference: ${mode}`;
  });

  // Also listen for live updates from context-menu flow
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.lastScan) paintLastScan(changes.lastScan.newValue);
  });
});
