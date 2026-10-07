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
  if (t === "loading" || i === "loading") {
    line = `Models: loading (first run may download from Hugging Face)…`;
  } else if (t === "error" || i === "error" || mode === "mock") {
    line = `Models unavailable — using local heuristics only (not authenticity).`;
    if (resp.textError) line += ` Text: ${String(resp.textError).slice(0, 80)}`;
  }
  return line;
}

function originPatternFromUrl(urlString) {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host}/*`;
  } catch (_) {
    return null;
  }
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
      chrome.runtime.sendMessage({ type: "disableBadgeOrigin", origin }, () => refreshAll());
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
      modelStatus.dataset.state = "loading";
      return;
    }
    modelStatus.textContent = formatModelStatus(resp);
    const bad =
      !resp ||
      resp.mode === "mock" ||
      resp.text === "error" ||
      resp.image === "error";
    const loading = resp && (resp.text === "loading" || resp.image === "loading");
    modelStatus.dataset.state = loading ? "loading" : bad ? "error" : "ok";
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
  const retryBtn = document.getElementById("retry-models");

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
    status.textContent = "Requesting site permission…";
    // Gesture-safe ladder (Diligence pack):
    // 1) tabs.query callback is still in the user-gesture chain
    // 2) permissions.request MUST be the first async permissions call (no await before it)
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) {
        status.textContent = "No active http(s) tab.";
        return;
      }
      const origin = originPatternFromUrl(tab.url);
      if (!origin) {
        status.textContent = "Badges only work on http(s) pages.";
        return;
      }
      // First chrome.permissions.* call in this turn = request (not contains).
      chrome.permissions.request({ origins: [origin] }, (granted) => {
        if (chrome.runtime.lastError) {
          status.textContent = chrome.runtime.lastError.message;
          return;
        }
        if (!granted) {
          status.textContent = "Permission denied for this site.";
          return;
        }
        status.textContent = "Permission OK — injecting…";
        chrome.runtime.sendMessage(
          {
            type: "enableBadgesForSite",
            origin,
            tabId: tab.id,
            permissionGranted: true,
          },
          (resp) => {
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
          }
        );
      });
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

  function runWarmup(which) {
    status.textContent = "Loading models (HF download on first run)…";
    document.getElementById("model-status").dataset.state = "loading";
    document.getElementById("model-status").textContent =
      "Models: loading (first run may download from Hugging Face)…";
    chrome.runtime.sendMessage({ type: "warmupModels", which: which || "both" }, (resp) => {
      if (chrome.runtime.lastError) {
        status.textContent = chrome.runtime.lastError.message;
        document.getElementById("model-status").dataset.state = "error";
        return;
      }
      document.getElementById("model-status").textContent = formatModelStatus(resp);
      const bad = !resp || resp.ok === false || resp.text?.status === "error" || resp.image?.status === "error";
      document.getElementById("model-status").dataset.state = bad ? "error" : "ok";
      status.textContent = bad
        ? "Models unavailable — local heuristics only (retry anytime)."
        : "Model load finished.";
    });
  }

  warmupBtn.addEventListener("click", () => runWarmup("both"));
  if (retryBtn) retryBtn.addEventListener("click", () => runWarmup("both"));

  refreshAll();
  status.textContent = "Ready — Enable badges on this site to inject.";

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.lastScan) paintLastScan(changes.lastScan.newValue);
    if (changes.enabledOrigins) refreshSiteStatus();
  });
});
