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

function formatStatus(resp) {
  if (!resp) return "Inference: starting…";
  const mode = resp.mode || "transformers";
  const t = resp.text || "?";
  const i = resp.image || "?";
  const td = resp.textDevice ? `/${resp.textDevice}` : "";
  const id = resp.imageDevice ? `/${resp.imageDevice}` : "";
  return `Inference: ${mode} — text ${t}${td}, image ${i}${id}`;
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("badge-toggle");
  const status = document.getElementById("status");
  const enableBtn = document.getElementById("enable-hosts");
  const warmupBtn = document.getElementById("warmup");

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
        : "Host permission not granted — some cross-origin images may stay pending.";
    });
  });

  warmupBtn.addEventListener("click", () => {
    status.textContent = "Loading local models (first run downloads from Hugging Face)…";
    chrome.runtime.sendMessage({ type: "warmupModels", which: "both" }, (resp) => {
      if (chrome.runtime.lastError) {
        status.textContent = "Warmup error: " + chrome.runtime.lastError.message;
        return;
      }
      status.textContent = formatStatus(resp) + (resp && resp.ok === false ? " (failed)" : "");
    });
  });

  chrome.runtime.sendMessage({ type: "getInferenceStatus" }, (resp) => {
    if (chrome.runtime.lastError) {
      status.textContent = "Inference: starting…";
      return;
    }
    status.textContent = formatStatus(resp);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.lastScan) paintLastScan(changes.lastScan.newValue);
  });
});
