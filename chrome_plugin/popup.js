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

function refreshSiteStatus() {
  const siteLine = document.getElementById("site-line");
  const enableBtn = document.getElementById("enable-site");
  const disableBtn = document.getElementById("disable-site");
  chrome.runtime.sendMessage({ type: "getSiteBadgeStatus" }, (resp) => {
    if (chrome.runtime.lastError) {
      siteLine.textContent = "Site: (unavailable)";
      return;
    }
    if (!resp || !resp.origin) {
      siteLine.textContent = "Site: open an http(s) page, then enable badges here.";
      enableBtn.disabled = true;
      disableBtn.disabled = true;
      return;
    }
    enableBtn.disabled = false;
    disableBtn.disabled = false;
    const state = resp.enabled ? "ON" : "OFF";
    siteLine.textContent = `Site: ${resp.origin} — badges ${state}`;
    enableBtn.style.display = resp.enabled ? "none" : "block";
    disableBtn.style.display = resp.enabled ? "block" : "none";
  });
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("badge-toggle");
  const status = document.getElementById("status");
  const enableBtn = document.getElementById("enable-site");
  const disableBtn = document.getElementById("disable-site");
  const warmupBtn = document.getElementById("warmup");

  chrome.storage.local.get({ badgeModeEnabled: true, lastScan: null }, (r) => {
    // checked = badges not paused
    toggle.checked = r.badgeModeEnabled !== false;
    paintLastScan(r.lastScan);
  });

  toggle.addEventListener("change", () => {
    chrome.storage.local.set({ badgeModeEnabled: toggle.checked });
    status.textContent = toggle.checked
      ? "Global pause off — badges run on enabled sites."
      : "Global pause on — badges hidden until re-enabled.";
  });

  enableBtn.addEventListener("click", () => {
    status.textContent = "Requesting permission and injecting badges…";
    chrome.runtime.sendMessage({ type: "enableBadgesForSite" }, (resp) => {
      if (chrome.runtime.lastError) {
        status.textContent = chrome.runtime.lastError.message;
        return;
      }
      if (resp && resp.ok) {
        status.textContent = resp.injected
          ? `Badges enabled for ${resp.origin}`
          : `Enabled for ${resp.origin} (reload page if badges missing)`;
      } else {
        status.textContent = (resp && resp.error) || "Enable failed.";
      }
      refreshSiteStatus();
    });
  });

  disableBtn.addEventListener("click", () => {
    status.textContent = "Disabling badges on this site…";
    chrome.runtime.sendMessage({ type: "disableBadgesForSite" }, (resp) => {
      if (chrome.runtime.lastError) {
        status.textContent = chrome.runtime.lastError.message;
        return;
      }
      status.textContent =
        resp && resp.ok
          ? `Badges disabled for ${resp.origin}`
          : (resp && resp.error) || "Disable failed.";
      refreshSiteStatus();
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

  refreshSiteStatus();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.lastScan) paintLastScan(changes.lastScan.newValue);
    if (area === "local" && changes.enabledOrigins) refreshSiteStatus();
  });
});
