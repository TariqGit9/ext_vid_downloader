// Central download manager - handles direct, HLS, and DASH downloads
// Persists to chrome.storage.session so it survives service worker restarts

const downloads = new Map(); // downloadId -> download state
const STORAGE_KEY = "downloads";
let loaded = false;
let loadPromise = null;

async function ensureLoaded() {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const data = await chrome.storage.session.get(STORAGE_KEY);
      const stored = data[STORAGE_KEY];
      if (Array.isArray(stored)) {
        for (const dl of stored) {
          // Mark in-flight downloads as paused on resume — segments are still in offscreen
          if (dl.status === "downloading" || dl.status === "merging") {
            dl.status = "paused";
            dl.error = "Download was interrupted (worker restart) — click Resume";
            dl.resumable = true;
          }
          downloads.set(dl.id, dl);
        }
      }
    } catch {}
    loaded = true;
  })();
  return loadPromise;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(persist, 200);
}

async function persist() {
  saveTimer = null;
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY]: [...downloads.values()],
    });
  } catch {}
}

ensureLoaded();

export async function waitLoaded() {
  await ensureLoaded();
}

export function getDownloads() {
  return [...downloads.values()];
}

export function getDownload(id) {
  return downloads.get(id);
}

export function createDownload(info) {
  const id = crypto.randomUUID();
  const download = {
    id,
    url: info.url,
    filename: info.filename,
    type: info.type, // 'direct' | 'hls' | 'dash'
    status: "pending",
    progress: 0,
    bytesReceived: 0,
    totalBytes: 0,
    segmentsTotal: 0,
    segmentsComplete: 0,
    error: null,
    chromeDownloadId: null,
    startedAt: Date.now(),
    quality: info.quality || null,
    // Stash everything needed to restart the job after a worker death:
    manifestUrl: info.manifestUrl || null,
    variantUrl: info.variantUrl || null,
    pageUrl: info.pageUrl || null,
    videoSegments: info.videoSegments || null,
  };
  downloads.set(id, download);
  scheduleSave();
  return download;
}

export function updateDownload(id, updates) {
  const dl = downloads.get(id);
  if (dl) {
    Object.assign(dl, updates);
    scheduleSave();
  }
}

export function removeDownload(id) {
  downloads.delete(id);
  scheduleSave();
}

/**
 * Cancel an in-progress download.
 */
export function cancelDownload(id) {
  const dl = downloads.get(id);
  if (!dl) return;
  if (dl.type === "direct" && dl.chromeDownloadId) {
    chrome.downloads.cancel(dl.chromeDownloadId);
  } else {
    chrome.runtime.sendMessage({ action: "offscreen-cancel", downloadId: id });
  }
  dl.status = "paused";
  dl.resumable = true;
  scheduleSave();
}

/**
 * Resume a paused or errored stream download.
 * Re-issues the original download command — offscreen.js preserves any
 * already-downloaded segments via its activeJobs map.
 */
export async function resumeDownload(id) {
  const dl = downloads.get(id);
  if (!dl) return;

  dl.status = "downloading";
  dl.error = null;
  dl.resumable = false;
  scheduleSave();

  await ensureOffscreen();

  // Try to resume in-place first (offscreen still has buffers)
  chrome.runtime.sendMessage({ action: "offscreen-resume", downloadId: id });

  // Fallback: re-start the job from scratch using stored manifest/segment info
  // (This handles the case where the offscreen document was also killed.)
  setTimeout(async () => {
    const cur = downloads.get(id);
    if (!cur || cur.status !== "downloading") return;
    // If progress hasn't moved in 3s, restart from stored manifest
    const startBytes = cur.bytesReceived;
    setTimeout(() => {
      const after = downloads.get(id);
      if (!after || after.status !== "downloading") return;
      if (after.bytesReceived === startBytes) {
        restartStreamJob(after);
      }
    }, 3000);
  }, 100);
}

function restartStreamJob(dl) {
  if (dl.type === "hls" && dl.manifestUrl) {
    chrome.runtime.sendMessage({
      action: "offscreen-download-hls",
      downloadId: dl.id,
      manifestUrl: dl.manifestUrl,
      variantUrl: dl.variantUrl || dl.manifestUrl,
      filename: dl.filename,
      pageUrl: dl.pageUrl,
    });
  } else if (dl.type === "dash" && dl.manifestUrl) {
    chrome.runtime.sendMessage({
      action: "offscreen-download-dash",
      downloadId: dl.id,
      mpdUrl: dl.manifestUrl,
      videoSegments: dl.videoSegments,
      audioSegments: null,
      filename: dl.filename,
      pageUrl: dl.pageUrl,
    });
  }
}

/**
 * Download a direct video file using chrome.downloads API.
 */
export function downloadDirect(url, filename) {
  const dl = createDownload({ url, filename, type: "direct" });
  dl.status = "downloading";

  chrome.downloads.download(
    { url, filename, saveAs: false },
    (chromeId) => {
      if (chrome.runtime.lastError) {
        dl.status = "error";
        dl.error = chrome.runtime.lastError.message;
        scheduleSave();
        return;
      }
      dl.chromeDownloadId = chromeId;
      scheduleSave();
    }
  );

  return dl;
}

/**
 * Download HLS stream via offscreen document.
 */
export async function downloadHLS(manifestUrl, variantUrl, filename, pageUrl) {
  const dl = createDownload({
    url: manifestUrl,
    filename,
    type: "hls",
    manifestUrl,
    variantUrl: variantUrl || manifestUrl,
    pageUrl,
  });
  dl.status = "downloading";
  scheduleSave();

  try {
    await ensureOffscreen();

    chrome.runtime.sendMessage({
      action: "offscreen-download-hls",
      downloadId: dl.id,
      manifestUrl,
      variantUrl: variantUrl || manifestUrl,
      filename,
      pageUrl,
    });
  } catch (err) {
    dl.status = "error";
    dl.error = err.message;
    scheduleSave();
  }

  return dl;
}

/**
 * Download DASH stream via offscreen document.
 */
export async function downloadDASH(mpdUrl, videoSegments, audioSegments, filename, pageUrl) {
  const dl = createDownload({
    url: mpdUrl,
    filename,
    type: "dash",
    manifestUrl: mpdUrl,
    pageUrl,
    videoSegments,
  });
  dl.status = "downloading";
  scheduleSave();

  try {
    await ensureOffscreen();

    chrome.runtime.sendMessage({
      action: "offscreen-download-dash",
      downloadId: dl.id,
      mpdUrl,
      videoSegments,
      audioSegments,
      filename,
      pageUrl,
    });
  } catch (err) {
    dl.status = "error";
    dl.error = err.message;
    scheduleSave();
  }

  return dl;
}

// Track chrome.downloads progress
let progressInterval = null;

export function startProgressTracking() {
  if (progressInterval) return;

  chrome.downloads.onChanged.addListener((delta) => {
    for (const dl of downloads.values()) {
      if (dl.chromeDownloadId === delta.id) {
        if (delta.state?.current === "complete") {
          dl.status = "complete";
          dl.progress = 100;
          scheduleSave();
        } else if (delta.state?.current === "interrupted") {
          dl.status = "error";
          dl.error = "Download interrupted";
          scheduleSave();
        }
      }
    }
  });

  progressInterval = setInterval(() => {
    const activeDirect = [...downloads.values()].filter(
      (d) => d.type === "direct" && d.chromeDownloadId && d.status === "downloading"
    );

    for (const dl of activeDirect) {
      chrome.downloads.search({ id: dl.chromeDownloadId }, (results) => {
        if (results?.[0]) {
          dl.bytesReceived = results[0].bytesReceived;
          dl.totalBytes = results[0].totalBytes;
          if (results[0].totalBytes > 0) {
            dl.progress = Math.round(
              (results[0].bytesReceived / results[0].totalBytes) * 100
            );
          }
          scheduleSave();
        }
      });
    }
  }, 500);
}

let offscreenCreated = false;

export async function ensureOffscreen() {
  if (offscreenCreated) return;

  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["BLOBS"],
        justification: "Download and merge video stream segments",
      });
    }
    offscreenCreated = true;
  } catch (err) {
    if (!err.message.includes("already exists")) {
      throw err;
    }
    offscreenCreated = true;
  }
}
