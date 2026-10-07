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
  labelEl.textContent = scan.heuristics ? "local heuristics" : scan.label || "local score";
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


let progressTimer = null;

function setProgressUI(resp) {
  const wrap = document.getElementById("progress-wrap");
  const bar = document.getElementById("progress-bar");
  const text = document.getElementById("progress-text");
  const cancel = document.getElementById("cancel-load");
  const prog = resp && resp.progress;
  const loading =
    (resp && (resp.text === "loading" || resp.image === "loading")) ||
    (prog && prog.status && !["idle", "ready", "cancelled"].includes(prog.status));
  if (!loading && !(prog && prog.message && prog.status !== "idle")) {
    wrap.hidden = true;
    text.hidden = true;
    cancel.hidden = true;
    return;
  }
  wrap.hidden = false;
  text.hidden = false;
  cancel.hidden = false;
  const pct = typeof prog?.percent === "number" ? Math.max(0, Math.min(100, prog.percent)) : null;
  if (pct != null) {
    bar.style.width = pct + "%";
    bar.setAttribute("aria-valuenow", String(pct));
  } else {
    bar.style.width = "35%";
    bar.setAttribute("aria-valuenow", "0");
  }
  text.textContent = (prog && prog.message) || "Downloading / loading local models…";
}

function stopProgressPoll() {
  if (progressTimer) {
    clearInterval(progressTimer);
    progressTimer = null;
  }
}

function startProgressPoll() {
  stopProgressPoll();
  progressTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: "getInferenceStatus" }, (resp) => {
      if (chrome.runtime.lastError) return;
      document.getElementById("model-status").textContent = formatModelStatus(resp);
      setProgressUI(resp);
      const done =
        resp &&
        resp.text !== "loading" &&
        resp.image !== "loading" &&
        (!resp.progress || ["ready", "idle", "cancelled", "error"].includes(resp.progress.status));
      if (done && resp && resp.text !== "loading") {
        // keep polling briefly until both idle/ready/error
        if (resp.text === "ready" || resp.text === "error" || resp.text === "idle") {
          if (resp.image === "ready" || resp.image === "error" || resp.image === "idle" || resp.image === "loading") {
            if (resp.image !== "loading" && resp.text !== "loading") stopProgressPoll();
          }
        }
      }
    });
  }, 400);
}

function formatModelStatus(resp) {
  if (!resp) return "Models: starting…";
  const mode = resp.mode || "transformers";
  const t = resp.text || "?";
  const i = resp.image || "?";
  const td = resp.textDevice ? `/${resp.textDevice}` : "";
  const id = resp.imageDevice ? `/${resp.imageDevice}` : "";
  if (t === "loading" || i === "loading") {
    return "Models: loading (first run may download from Hugging Face)…";
  }
  if (t === "error" || i === "error" || mode === "mock") {
    return "Models unavailable — showing local heuristics only (not authenticity).";
  }
  return `Models: ${mode} — text ${t}${td}, image ${i}${id}`;
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

function renderSiteList(origins, pausedOrigins) {
  const ul = document.getElementById("site-list");
  ul.innerHTML = "";
  const paused = new Set(pausedOrigins || []);
  if (!origins || !origins.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "No sites enabled yet. Open a page and click Enable.";
    ul.appendChild(li);
    return;
  }
  for (const origin of origins) {
    const li = document.createElement("li");
    const span = document.createElement("span");
    span.textContent = paused.has(origin) ? `${origin} (paused)` : origin;
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
  const pauseBtn = document.getElementById("pause-site");
  const resumeBtn = document.getElementById("resume-site");

  chrome.runtime.sendMessage({ type: "getSiteBadgeStatus" }, (resp) => {
    if (chrome.runtime.lastError) {
      originEl.textContent = "(unavailable)";
      stateEl.textContent = "Unknown";
      stateEl.dataset.state = "unknown";
      return;
    }
    renderSiteList(resp && resp.enabledOrigins, resp && resp.pausedOrigins);

    if (!resp || !resp.origin || resp.restricted) {
      originEl.textContent = resp && resp.restricted
        ? "Restricted URL — open http(s) (not file:// or chrome://)"
        : "Open an http(s) page, then enable here.";
      stateEl.textContent = "No page";
      stateEl.dataset.state = "off";
      enableBtn.disabled = true;
      disableBtn.disabled = true;
      pauseBtn.disabled = true;
      resumeBtn.disabled = true;
      enableBtn.hidden = false;
      disableBtn.hidden = true;
      pauseBtn.hidden = true;
      resumeBtn.hidden = true;
      return;
    }

    originEl.textContent = resp.origin;
    originEl.title = resp.tabUrl || resp.origin;
    enableBtn.disabled = false;
    disableBtn.disabled = false;
    pauseBtn.disabled = false;
    resumeBtn.disabled = false;

    if (!resp.enabled) {
      stateEl.textContent = "OFF — not enabled";
      stateEl.dataset.state = "off";
      enableBtn.hidden = false;
      disableBtn.hidden = true;
      pauseBtn.hidden = true;
      resumeBtn.hidden = true;
    } else if (resp.sitePaused) {
      stateEl.textContent = "PAUSED on this site";
      stateEl.dataset.state = "off";
      enableBtn.hidden = true;
      disableBtn.hidden = false;
      pauseBtn.hidden = true;
      resumeBtn.hidden = false;
    } else {
      stateEl.textContent = "ON for this site";
      stateEl.dataset.state = "on";
      enableBtn.hidden = true;
      disableBtn.hidden = false;
      pauseBtn.hidden = false;
      resumeBtn.hidden = true;
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
    const bad = !resp || resp.mode === "mock" || resp.text === "error" || resp.image === "error";
    const loading = resp && (resp.text === "loading" || resp.image === "loading");
    modelStatus.dataset.state = loading ? "loading" : bad ? "error" : "ok";
  });
}

function refreshAll() {
  refreshSiteStatus();
  refreshModels();
}

document.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const enableBtn = document.getElementById("enable-site");
  const disableBtn = document.getElementById("disable-site");
  const pauseBtn = document.getElementById("pause-site");
  const resumeBtn = document.getElementById("resume-site");
  const clearAll = document.getElementById("clear-all");
  const warmupBtn = document.getElementById("warmup");
  const retryBtn = document.getElementById("retry-models");

  chrome.storage.local.get({ lastScan: null }, (r) => paintLastScan(r.lastScan));

  enableBtn.addEventListener("click", () => {
    status.textContent = "Requesting site permission…";
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) {
        status.textContent = "No active http(s) tab.";
        return;
      }
      const origin = originPatternFromUrl(tab.url);
      if (!origin) {
        status.textContent = "Restricted or non-http(s) URL. Serve sample over http.";
        return;
      }
      chrome.permissions.request({ origins: [origin] }, (granted) => {
        if (chrome.runtime.lastError) {
          status.textContent = chrome.runtime.lastError.message;
          return;
        }
        if (!granted) {
          status.textContent = "Permission denied for this site.";
          return;
        }
        chrome.runtime.sendMessage(
          { type: "enableBadgesForSite", origin, tabId: tab.id, permissionGranted: true },
          (resp) => {
            if (chrome.runtime.lastError) {
              status.textContent = chrome.runtime.lastError.message;
              return;
            }
            status.textContent =
              resp && resp.ok
                ? resp.injected
                  ? `Enabled on ${resp.origin}`
                  : `Enabled on ${resp.origin} — reload if badges missing`
                : (resp && resp.error) || "Enable failed.";
            refreshAll();
          }
        );
      });
    });
  });

  pauseBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "pauseBadgesForSite" }, (resp) => {
      status.textContent =
        resp && resp.ok ? `Paused on ${resp.origin}` : (resp && resp.error) || "Pause failed.";
      refreshAll();
    });
  });

  resumeBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "resumeBadgesForSite" }, (resp) => {
      status.textContent =
        resp && resp.ok ? `Resumed on ${resp.origin}` : (resp && resp.error) || "Resume failed.";
      refreshAll();
    });
  });

  disableBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "disableBadgesForSite" }, (resp) => {
      status.textContent =
        resp && resp.ok ? `Disabled ${resp.origin}` : (resp && resp.error) || "Disable failed.";
      refreshAll();
    });
  });

  clearAll.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "clearAllBadgeOrigins" }, (resp) => {
      status.textContent =
        resp && resp.ok
          ? `Cleared ${((resp.cleared || []).length)} site(s)`
          : (resp && resp.error) || "Clear failed.";
      refreshAll();
    });
  });

  function runWarmup() {
    status.textContent = "Loading models (HF download on first run)…";
    document.getElementById("model-status").dataset.state = "loading";
    document.getElementById("model-status").textContent =
      "Models: loading (first run may download from Hugging Face)…";
    setProgressUI({ text: "loading", image: "loading", progress: { status: "starting", percent: 0, message: "starting…" } });
    startProgressPoll();
    chrome.runtime.sendMessage({ type: "warmupModels", which: "both" }, (resp) => {
      stopProgressPoll();
      if (chrome.runtime.lastError) {
        status.textContent = chrome.runtime.lastError.message;
        document.getElementById("model-status").dataset.state = "error";
        setProgressUI(null);
        return;
      }
      document.getElementById("model-status").textContent = formatModelStatus(resp);
      setProgressUI(resp);
      const textBad = resp && (resp.text === "error" || (resp.text && resp.text.status === "error"));
      const imageBad = resp && (resp.image === "error" || (resp.image && resp.image.status === "error"));
      const bad = !resp || resp.ok === false || textBad || imageBad || resp.cancelled;
      document.getElementById("model-status").dataset.state = bad ? "error" : "ok";
      status.textContent = resp && resp.cancelled
        ? "Load cancelled — local heuristics may be used until models load."
        : bad
          ? "Models unavailable — local heuristics only (retry anytime)."
          : "Model load finished.";
      if (!bad) {
        document.getElementById("progress-wrap").hidden = true;
        document.getElementById("progress-text").hidden = true;
        document.getElementById("cancel-load").hidden = true;
      }
    });
  }

  warmupBtn.addEventListener("click", runWarmup);
  retryBtn.addEventListener("click", runWarmup);

  refreshAll();
  status.textContent = "Ready — Enable badges on this site (or Alt+Shift+L).";

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.lastScan) paintLastScan(changes.lastScan.newValue);
    if (changes.enabledOrigins || changes.pausedOrigins) refreshSiteStatus();
  });
});
