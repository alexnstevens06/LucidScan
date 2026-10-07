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

function formatModelStatus(resp) {
  if (!resp) return "Models: starting…";
  const mode = resp.mode || "transformers";
  const t = resp.text || "?";
  const i = resp.image || "?";
  const td = resp.textDevice ? `/${resp.textDevice}` : "";
  const id = resp.imageDevice ? `/${resp.imageDevice}` : "";
  let line = `Models: ${mode} — text ${t}${td}, image ${i}${id}`;
  if (t === "error" || i === "error") {
    line += " · models unavailable — local heuristics only";
  } else if (mode === "mock") {
    line += " · heuristics fallback";
  }
  return line;
}

function renderSiteList(origins) {
  const ul = document.getElementById("site-list");
  ul.innerHTML = "";
  if (!origins || !origins.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites enabled yet.";
    ul.appendChild(li);
    return;
  }
  for (const origin of origins) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = origin;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn tiny";
    btn.textContent = "Disable";
    btn.addEventListener("click", () => {
      chrome.runtime.sendMessage({ type: "disableBadgeOrigin", origin }, () => {
        refreshAll();
      });
    });
    li.append(span, btn);
    ul.appendChild(li);
  }
}

function refreshSiteStatus() {
  const originEl = document.getElementById("site-origin");
  const stateEl = document.getElementById("site-state");
  const enableBtn = document.getElementById("enable-site");
  const disableBtn = document.getElementById("disable-site");
  chrome.runtime.sendMessage({ type: "getSiteBadgeStatus" }, (resp) => {
    if (chrome.runtime.lastError) {
      originEl.textContent = "(unavailable)";
      stateEl.textContent = "Unknown";
      stateEl.dataset.state = "unknown";
      return;
    }
    renderSiteList(resp && resp.enabledOrigins);

    if (!resp || !resp.origin) {
      originEl.textContent = "Open an http(s) page, then enable here.";
      originEl.title = "";
      stateEl.textContent = "No page";
      stateEl.dataset.state = "off";
      enableBtn.disabled = true;
      disableBtn.disabled = true;
      enableBtn.hidden = false;
      disableBtn.hidden = true;
      return;
    }

    originEl.textContent = resp.origin;
    originEl.title = resp.tabUrl || resp.origin;
    enableBtn.disabled = false;
    disableBtn.disabled = false;

    if (resp.enabled) {
      stateEl.textContent = "Badges ON for this site";
      stateEl.dataset.state = "on";
      enableBtn.hidden = true;
      disableBtn.hidden = false;
    } else {
      stateEl.textContent = "Badges OFF — click Enable";
      stateEl.dataset.state = "off";
      enableBtn.hidden = false;
      disableBtn.hidden = true;
    }
  });
}

function refreshModels() {
  const modelStatus = document.getElementById("model-status");
  chrome.runtime.sendMessage({ type: "getInferenceStatus" }, (resp) => {
    if (chrome.runtime.lastError) {
      modelStatus.textContent = "Models: starting…";
      return;
    }
    modelStatus.textContent = formatModelStatus(resp);
  });
}

function refreshAll() {
  refreshSiteStatus();
  refreshModels();
}

document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.getElementById("badge-toggle");
  const status = document.getElementById("status");
  const enableBtn = document.getElementById("enable-site");
  const disableBtn = document.getElementById("disable-site");
  const clearAll = document.getElementById("clear-all");
  const warmupBtn = document.getElementById("warmup");

  chrome.storage.local.get({ badgeModeEnabled: true, lastScan: null }, (r) => {
    toggle.checked = r.badgeModeEnabled !== false;
    paintLastScan(r.lastScan);
  });

  toggle.addEventListener("change", () => {
    chrome.storage.local.set({ badgeModeEnabled: toggle.checked });
    status.textContent = toggle.checked
      ? "Global pause off — badges can show on enabled sites."
      : "Paused everywhere — site enables kept; badges hidden.";
  });

  enableBtn.addEventListener("click", () => {
    status.textContent = "Requesting permission and injecting…";
    chrome.runtime.sendMessage({ type: "enableBadgesForSite" }, (resp) => {
      if (chrome.runtime.lastError) {
        status.textContent = chrome.runtime.lastError.message;
        return;
      }
      if (resp && resp.ok) {
        status.textContent = resp.injected
          ? `Enabled on ${resp.origin}`
          : `Enabled on ${resp.origin} — reload if badges missing`;
      } else {
        status.textContent = (resp && resp.error) || "Enable failed.";
      }
      refreshAll();
    });
  });

  disableBtn.addEventListener("click", () => {
    status.textContent = "Disabling this site…";
    chrome.runtime.sendMessage({ type: "disableBadgesForSite" }, (resp) => {
      status.textContent =
        resp && resp.ok ? `Disabled ${resp.origin}` : (resp && resp.error) || "Disable failed.";
      refreshAll();
    });
  });

  clearAll.addEventListener("click", () => {
    status.textContent = "Clearing all enabled sites…";
    chrome.runtime.sendMessage({ type: "clearAllBadgeOrigins" }, (resp) => {
      status.textContent =
        resp && resp.ok
          ? `Cleared ${((resp.cleared || []).length)} site(s)`
          : (resp && resp.error) || "Clear failed.";
      refreshAll();
    });
  });

  warmupBtn.addEventListener("click", () => {
    status.textContent = "Loading models (HF download on first run)…";
    chrome.runtime.sendMessage({ type: "warmupModels", which: "both" }, (resp) => {
      if (chrome.runtime.lastError) {
        status.textContent = chrome.runtime.lastError.message;
        return;
      }
      document.getElementById("model-status").textContent = formatModelStatus(resp);
      status.textContent =
        resp && resp.ok === false
          ? "Models unavailable — local heuristics only"
          : "Model load finished (see status).";
    });
  });

  refreshAll();
  status.textContent = "Ready — enable this site to show badges.";

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.lastScan) paintLastScan(changes.lastScan.newValue);
    if (changes.enabledOrigins) refreshSiteStatus();
  });
});
