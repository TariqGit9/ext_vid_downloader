import { formatBytes, formatDuration, getQualityLabel, cleanFilename } from "../lib/utils.js";

const videoListEl = document.getElementById("video-list");
const downloadsListEl = document.getElementById("downloads-list");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh-btn");
const saveAsToggle = document.getElementById("save-as-toggle");
const renameModal = document.getElementById("rename-modal");
const renameInput = document.getElementById("rename-input");
const renameExtEl = document.getElementById("rename-ext");
const renameOk = document.getElementById("rename-ok");
const renameCancel = document.getElementById("rename-cancel");

let currentTabId = null;
let allVideos = [];
let videosRendered = false;
let saveAsAlways = false;

// Load saved "Save As" preference
chrome.storage.local.get("saveAsAlways").then((data) => {
  saveAsAlways = !!data.saveAsAlways;
  saveAsToggle.checked = saveAsAlways;
});

saveAsToggle.addEventListener("change", () => {
  saveAsAlways = saveAsToggle.checked;
  chrome.storage.local.set({ saveAsAlways });
});

// Tab switching
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// Refresh button
refreshBtn.addEventListener("click", () => {
  refreshBtn.style.transform = "rotate(360deg)";
  setTimeout(() => (refreshBtn.style.transform = ""), 300);
  videosRendered = false;
  loadVideos();
  if (currentTabId) {
    chrome.tabs.sendMessage(currentTabId, { action: "rescanPage" }).catch(() => {});
  }
});

async function loadVideos() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  currentTabId = tab.id;

  const response = await chrome.runtime.sendMessage({
    action: "getVideos",
    tabId: tab.id,
  });

  const newVideos = response?.videos || [];

  // Only re-render if video count changed (avoid destroying button states)
  if (!videosRendered || newVideos.length !== allVideos.length) {
    allVideos = newVideos;
    renderVideos();
    videosRendered = true;
  }
}

function getTypeIcon(type) {
  switch (type) {
    case "hls": return "⚡";
    case "dash": return "◈";
    case "youtube":
    case "youtube-stream": return "▶";
    default: return "▶";
  }
}

function getTypeBadge(type) {
  switch (type) {
    case "youtube":
    case "youtube-stream": return "YouTube";
    default: return type.toUpperCase();
  }
}

function renderVideos() {
  if (allVideos.length === 0) {
    videoListEl.innerHTML = `
      <div class="empty-state">
        <div class="icon">📡</div>
        <p>No videos detected on this page.<br>Try playing a video first.</p>
      </div>`;
    statusEl.textContent = "No videos found";
    return;
  }

  statusEl.textContent = `${allVideos.length} video(s) detected`;
  videoListEl.innerHTML = "";

  allVideos.forEach((video, index) => {
    const item = document.createElement("div");
    item.className = "video-item";

    const title = video.pageTitle || extractName(video.url);
    const type = video.type || "direct";
    const typeBadge = getTypeBadge(type);
    const typeClass = type.startsWith("youtube") ? "youtube" : type;

    let warningHTML = "";
    let buttonsHTML = "";

    if (video.hasDRM) {
      warningHTML = `<div class="drm-warning">🔒 DRM protected — cannot download</div>`;
      buttonsHTML = `<button class="download-btn" disabled>Protected</button>`;
    } else if (video.qualities && video.qualities.length > 0) {
      const downloadable = video.qualities.filter((q) => q.url && !q.needsSignature);

      if (downloadable.length === 0) {
        warningHTML = `<div class="drm-warning">🔐 All streams are signature-protected.</div>`;
        buttonsHTML = `<button class="download-btn" disabled>Not Available</button>`;
      } else {
        // Separate button for each quality, plus a small rename icon
        buttonsHTML = `<div class="quality-buttons">` +
          downloadable.map((q) => {
            const origIdx = video.qualities.indexOf(q);
            const label = q.label || getQualityLabel(q.height, q.bandwidth);
            const audioTag = q.audioOnly ? " Audio" : q.hasAudio === false ? " (no audio)" : "";
            const size = q.estimatedSize ? ` · ${formatBytes(q.estimatedSize)}` : "";
            return `<div class="quality-row-btn">
              <button class="quality-btn" data-video="${index}" data-quality="${origIdx}">
                <span class="q-label">${label}${audioTag}</span>
                <span class="q-detail">${q.mimeType ? q.mimeType.split(";")[0] : ""}${size}</span>
              </button>
              <button class="rename-btn" data-video="${index}" data-quality="${origIdx}" title="Save as...">✎</button>
            </div>`;
          }).join("") +
          `</div>`;
      }

      if (video.needsSignature && downloadable.length > 0) {
        warningHTML = `<div class="drm-warning">🔐 Some qualities need signature decryption.</div>`;
      }
    } else if (video.resolving) {
      buttonsHTML = `<div class="resolving">Analyzing stream</div>`;
    } else {
      // Direct video or HLS/DASH without quality variants — single download button + rename
      buttonsHTML = `<div class="quality-row-btn">
        <button class="quality-btn single-btn" data-video="${index}" data-quality="-1">
          <span class="q-label">Download</span>
          <span class="q-detail">${video.size ? formatBytes(video.size) : type.toUpperCase()}</span>
        </button>
        <button class="rename-btn" data-video="${index}" data-quality="-1" title="Save as...">✎</button>
      </div>`;
    }

    const durationMeta = video.duration ? `<span>${formatDuration(video.duration)}</span>` : "";
    const sizeMeta = video.size && !video.qualities ? `<span>${formatBytes(video.size)}</span>` : "";
    const displayUrl = video.url?.startsWith("youtube://")
      ? `youtube.com/watch?v=${video.videoId || video.url.replace("youtube://", "")}`
      : video.url;

    item.innerHTML = `
      <div class="video-header">
        <div class="video-icon ${typeClass}">${getTypeIcon(type)}</div>
        <div class="video-info">
          <div class="video-title" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
          <div class="video-meta">
            <span class="badge ${typeClass}">${typeBadge}</span>
            ${sizeMeta}
            ${durationMeta}
          </div>
        </div>
        <button class="copy-btn" data-url="${escapeHtml(video.url)}" title="Copy URL">📋</button>
      </div>
      <div class="video-url">${escapeHtml(displayUrl)}</div>
      ${warningHTML}
      ${buttonsHTML}
    `;

    videoListEl.appendChild(item);
  });

  // Quality/download button handlers
  document.querySelectorAll(".quality-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const button = e.target.closest(".quality-btn");
      const videoIdx = parseInt(button.dataset.video);
      const qualityIdx = parseInt(button.dataset.quality);
      const video = allVideos[videoIdx];
      if (!video) return;
      const quality = qualityIdx >= 0 ? video.qualities[qualityIdx] : null;

      // If "Save As" toggle is on, ask for filename first
      let customFilename = null;
      if (saveAsAlways) {
        customFilename = await promptForFilename(video, quality);
        if (customFilename === null) return; // user cancelled
      }

      startDownload(button, video, quality, customFilename);
    });
  });

  // Rename buttons — always prompt for a filename
  document.querySelectorAll(".rename-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const button = e.target.closest(".rename-btn");
      const videoIdx = parseInt(button.dataset.video);
      const qualityIdx = parseInt(button.dataset.quality);
      const video = allVideos[videoIdx];
      if (!video) return;
      const quality = qualityIdx >= 0 ? video.qualities[qualityIdx] : null;

      const customFilename = await promptForFilename(video, quality);
      if (customFilename === null) return;

      // Find the matching quality button to mark as downloading
      const qBtn = button
        .closest(".quality-row-btn")
        .querySelector(".quality-btn");
      startDownload(qBtn, video, quality, customFilename);
    });
  });

  // Copy URL handlers
  document.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const button = e.target.closest(".copy-btn");
      const url = button.dataset.url;
      navigator.clipboard.writeText(url).then(() => {
        button.textContent = "✓";
        setTimeout(() => (button.textContent = "📋"), 1500);
      });
    });
  });
}

function updateDownloads() {
  chrome.runtime.sendMessage({ action: "getDownloadProgress" }, (response) => {
    if (!response?.downloads) return;

    const downloads = response.downloads;
    if (downloads.length === 0) {
      downloadsListEl.innerHTML = `
        <div class="empty-state">
          <div class="icon">📥</div>
          <p>No active downloads</p>
        </div>`;
      return;
    }

    downloadsListEl.innerHTML = "";

    downloads.forEach((dl) => {
      const item = document.createElement("div");
      item.className = "download-item";

      let progressClass = "";
      let statusText = "";
      let statusDetail = "";
      let statusClass = "";

      switch (dl.status) {
        case "complete":
          progressClass = "complete";
          statusText = "Complete";
          statusClass = "status-complete";
          break;
        case "paused":
          progressClass = "paused";
          statusText = "Paused";
          statusClass = "status-paused";
          if (dl.segmentsTotal > 0) {
            statusDetail = `${dl.segmentsComplete}/${dl.segmentsTotal} segments`;
          }
          break;
        case "retrying": {
          progressClass = "retrying";
          const errMsg = (dl.error || "").replace(/^HTTP\s+/, "");
          statusText = `Rate limited (${errMsg}) — auto-retrying`;
          statusClass = "status-retrying";
          if (dl.segmentsTotal > 0) {
            statusDetail = `${dl.segmentsComplete}/${dl.segmentsTotal} segments`;
          }
          break;
        }
        case "error":
          progressClass = "error";
          statusText = "Error: " + (dl.error || "Failed");
          statusClass = "status-error";
          if (dl.segmentsTotal > 0) {
            statusDetail = `${dl.segmentsComplete}/${dl.segmentsTotal} segments`;
          }
          break;
        case "merging":
          progressClass = "merging";
          statusText = "Merging segments...";
          statusClass = "status-merging";
          break;
        case "downloading":
          statusText = `${dl.progress}%`;
          if (dl.segmentsTotal > 0) {
            statusDetail = `${dl.segmentsComplete}/${dl.segmentsTotal} segments`;
          }
          if (dl.bytesReceived > 0) {
            statusDetail += (statusDetail ? " · " : "") + formatBytes(dl.bytesReceived);
          }
          break;
        default:
          statusText = "Starting...";
      }

      const isStream = dl.type === "hls" || dl.type === "dash";
      const canResume =
        isStream && (dl.status === "error" || dl.status === "paused");
      const canCancel =
        dl.status === "downloading" ||
        dl.status === "merging" ||
        dl.status === "retrying";
      const canRemove =
        dl.status === "complete" ||
        dl.status === "error" ||
        dl.status === "paused";

      let actionsHTML = "";
      if (canResume) {
        actionsHTML += `<button class="dl-action resume" data-id="${dl.id}" title="Resume">▶ Resume</button>`;
      }
      if (canCancel) {
        actionsHTML += `<button class="dl-action cancel" data-id="${dl.id}" title="Pause">⏸ Pause</button>`;
      }
      if (canRemove) {
        actionsHTML += `<button class="dl-action remove" data-id="${dl.id}" title="Remove from list">✕</button>`;
      }

      item.innerHTML = `
        <div class="dl-filename">${escapeHtml(dl.filename || "video")}</div>
        <div class="progress-bar">
          <div class="progress-fill ${progressClass}" style="width: ${dl.progress || 0}%"></div>
        </div>
        <div class="dl-status">
          <span class="status-text ${statusClass}">${statusText}</span>
          <span class="status-detail">${statusDetail}</span>
        </div>
        ${actionsHTML ? `<div class="dl-actions">${actionsHTML}</div>` : ""}
      `;

      downloadsListEl.appendChild(item);
    });

    // Wire action buttons
    document.querySelectorAll(".dl-action.resume").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const id = e.target.closest(".dl-action").dataset.id;
        chrome.runtime.sendMessage({ action: "resumeDownload", downloadId: id });
      });
    });
    document.querySelectorAll(".dl-action.cancel").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const id = e.target.closest(".dl-action").dataset.id;
        chrome.runtime.sendMessage({ action: "cancelDownload", downloadId: id });
      });
    });
    document.querySelectorAll(".dl-action.remove").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const id = e.target.closest(".dl-action").dataset.id;
        chrome.runtime.sendMessage({ action: "removeDownload", downloadId: id });
      });
    });
  });
}

function startDownload(button, video, quality, customFilename) {
  if (button) {
    button.disabled = true;
    const labelEl = button.querySelector(".q-label");
    if (labelEl) labelEl.textContent = "Starting...";
    button.classList.add("downloading");
  }

  chrome.runtime.sendMessage({
    action: "downloadVideo",
    url: video.url,
    type: video.type,
    quality,
    tabId: currentTabId,
    filename: customFilename || null,
  });

  setTimeout(() => {
    document.querySelector('.tab[data-tab="downloads"]').click();
  }, 500);
}

function defaultFilename(video, quality) {
  let title = video.pageTitle || extractName(video.url) || "video";
  // Strip site suffixes
  title = title
    .replace(/\s*[-|]\s*(YouTube|Reddit|Twitter|X|Vimeo|Facebook|TikTok).*$/i, "")
    .trim();
  let base = cleanFilename(title);
  if (quality?.resolution) base += "_" + quality.resolution;
  else if (quality?.label) base += "_" + cleanFilename(quality.label.split(" ")[0]);
  return base;
}

function guessExtension(video, quality) {
  const mime = quality?.mimeType || "";
  if (quality?.audioOnly) return mime.includes("webm") ? "webm" : "m4a";
  if (mime.includes("webm")) return "webm";
  if (video.type === "hls") return "ts";
  if (video.type === "dash") return "mp4";
  if (video.type === "youtube" || video.type === "youtube-stream") return "mp4";
  // Try to extract from URL
  try {
    const path = new URL(video.url).pathname;
    const m = path.match(/\.([a-z0-9]+)$/i);
    if (m) return m[1];
  } catch {}
  return "mp4";
}

function promptForFilename(video, quality) {
  return new Promise((resolve) => {
    const ext = guessExtension(video, quality);
    const base = defaultFilename(video, quality);

    renameInput.value = base;
    renameExtEl.textContent = "." + ext;
    renameModal.hidden = false;
    setTimeout(() => {
      renameInput.focus();
      renameInput.select();
    }, 0);

    const cleanup = () => {
      renameModal.hidden = true;
      renameOk.removeEventListener("click", onOk);
      renameCancel.removeEventListener("click", onCancel);
      renameInput.removeEventListener("keydown", onKey);
    };

    const onOk = () => {
      let name = renameInput.value.trim();
      if (!name) {
        renameInput.focus();
        return;
      }
      // Strip extension if user typed it, then re-append the canonical one
      name = name.replace(/\.[^./\\]+$/, "");
      const final = cleanFilename(name) + "." + ext;
      cleanup();
      resolve(final);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };
    const onKey = (e) => {
      if (e.key === "Enter") onOk();
      else if (e.key === "Escape") onCancel();
    };

    renameOk.addEventListener("click", onOk);
    renameCancel.addEventListener("click", onCancel);
    renameInput.addEventListener("keydown", onKey);
  });
}

function extractName(url) {
  try {
    const u = new URL(url);
    return u.pathname.split("/").pop() || u.hostname;
  } catch {
    return "video";
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Initialize
loadVideos();

// Poll — only update downloads frequently, video list only when count changes
setInterval(updateDownloads, 500);
setInterval(loadVideos, 3000);

updateDownloads();
