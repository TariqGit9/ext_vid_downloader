// Service worker entry point

import * as tabState from "./tab-state.js";
import { setupNetworkInterceptor } from "./network-interceptor.js";
import { resolveHLS, resolveDASH, resolveDirectSize } from "./metadata-resolver.js";
import * as downloadManager from "./download-manager.js";
import { setActiveIcon, setInactiveIcon } from "./icon-animator.js";
import { generateVideoFilename, extractFilename } from "../lib/utils.js";
import { parsePlayerResponse, parseVideoplaybackUrl } from "../lib/youtube-parser.js";
import { addRefererRule } from "./referer-injector.js";

// Start download progress tracking
downloadManager.startProgressTracking();

// Keep service worker alive while stream downloads are active.
// Chrome kills idle service workers after ~30s; alarms wake them up every 25s.
chrome.alarms.create("keepAlive", { periodInMinutes: 0.4 }); // ~24s
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "keepAlive") return;
  // Touch the offscreen document and storage to reset the idle timer
  const active = downloadManager.getDownloads().some(
    (d) => d.status === "downloading" || d.status === "merging"
  );
  if (active) {
    await downloadManager.ensureOffscreen();
    // Ping offscreen so it stays alive too
    chrome.runtime.sendMessage({ action: "offscreen-ping" }).catch(() => {});
  }
});

// On worker startup, restore offscreen if there are active jobs
(async () => {
  await downloadManager.waitLoaded();
  const hasActive = downloadManager.getDownloads().some(
    (d) =>
      d.status === "downloading" ||
      d.status === "merging" ||
      d.status === "paused"
  );
  if (hasActive) {
    await downloadManager.ensureOffscreen();
  }
})();

// Handle video detection from network interceptor
function onNetworkVideoDetected(tabId, info) {
  handleVideoDetected(tabId, info);
}

setupNetworkInterceptor(onNetworkVideoDetected);

// Track which tabs have YouTube player data so we don't add raw videoplayback URLs
const tabHasYouTubePlayer = new Set();

// Process detected videos (from content script or network interceptor)
async function handleVideoDetected(tabId, info) {
  const { url, type, pageTitle, pageUrl } = info;
  if (!url) return;

  // Skip tiny segments (.ts files) - we only want manifests and direct files
  if (/\.(ts|m4s)(\?|#|$)/i.test(url) && type !== "hls" && type !== "dash") {
    return;
  }

  // Skip blob-mediasource entries — they can't be downloaded directly
  if (type === "blob-mediasource") {
    return;
  }

  // Skip raw YouTube videoplayback URLs if we already have parsed player data
  // (those are individual segment fetches — we show the structured player data instead)
  if (type === "youtube-stream" && tabHasYouTubePlayer.has(tabId)) {
    return;
  }

  // For YouTube stream URLs without player data, extract itag info
  if (type === "youtube-stream") {
    const parsed = parseVideoplaybackUrl(url);
    if (parsed && parsed.isRange) return; // Skip range/segment requests

    const videoInfo = {
      url,
      type: "youtube-stream",
      pageTitle: pageTitle || "",
      pageUrl: pageUrl || "",
      qualities: null,
      size: parsed?.contentLength || null,
      duration: null,
      resolving: false,
      resolved: true,
      youtubeItag: parsed?.itag,
      youtubeQuality: parsed?.quality,
      youtubeHasAudio: parsed?.hasAudio,
    };

    tabState.addVideo(tabId, videoInfo);
    setActiveIcon(tabId, tabState.getVideoCount(tabId));
    return;
  }

  const videoInfo = {
    url,
    type: type || "direct",
    pageTitle: pageTitle || "",
    pageUrl: pageUrl || "",
    qualities: null,
    size: info.size || null,
    duration: null,
    resolving: false,
    resolved: false,
  };

  const id = tabState.addVideo(tabId, videoInfo);
  setActiveIcon(tabId, tabState.getVideoCount(tabId));

  // Resolve metadata in background
  resolveMetadata(tabId, url, type);
}

// Handle YouTube player response from content script
function handleYouTubePlayerResponse(tabId, message) {
  try {
    const data = JSON.parse(message.playerResponse);
    const parsed = parsePlayerResponse(data);
    if (!parsed || !parsed.qualities || parsed.qualities.length === 0) return;

    tabHasYouTubePlayer.add(tabId);

    // Use the video ID as the unique URL key for dedup
    const videoKey = `youtube://${parsed.videoId}`;
    const title = parsed.title || message.pageTitle || "";

    // Build quality list — only include progressive (video+audio) and direct URLs
    const qualities = parsed.qualities
      .filter((q) => q.url) // Only streams with direct URLs (no cipher)
      .map((q) => ({
        url: q.url,
        resolution: q.width && q.height ? `${q.width}x${q.height}` : "",
        height: q.height,
        width: q.width,
        bandwidth: q.bitrate,
        label: q.label || q.quality,
        hasAudio: q.hasAudio && !q.audioOnly,
        audioOnly: q.audioOnly,
        estimatedSize: q.contentLength,
        mimeType: q.mimeType,
        itag: q.itag,
      }));

    // Separate into video+audio, video-only, audio-only
    const progressive = qualities.filter((q) => q.hasAudio && !q.audioOnly);
    const videoOnly = qualities.filter((q) => !q.hasAudio && !q.audioOnly);
    const audioOnly = qualities.filter((q) => q.audioOnly);

    // Determine which qualities to show
    // Prefer progressive (video+audio) — those are directly downloadable
    const displayQualities = [
      ...progressive,
      ...videoOnly,
      ...audioOnly,
    ];

    if (displayQualities.length === 0) {
      // All streams need signature decryption — add a note
      const cipherQualities = parsed.qualities
        .filter((q) => q.signatureCipher && !q.audioOnly)
        .map((q) => ({
          url: null,
          resolution: q.width && q.height ? `${q.width}x${q.height}` : "",
          height: q.height,
          width: q.width,
          bandwidth: q.bitrate,
          label: `${q.quality} (needs signature)`,
          hasAudio: q.hasAudio && !q.audioOnly,
          audioOnly: q.audioOnly,
          estimatedSize: q.contentLength,
          needsSignature: true,
          itag: q.itag,
        }));

      const videoInfo = {
        url: videoKey,
        type: "youtube",
        pageTitle: title,
        pageUrl: message.pageUrl || "",
        qualities: cipherQualities.length > 0 ? cipherQualities : null,
        duration: parsed.duration,
        resolved: true,
        resolving: false,
        isYouTube: true,
        videoId: parsed.videoId,
        needsSignature: true,
      };

      tabState.addVideo(tabId, videoInfo);
      setActiveIcon(tabId, tabState.getVideoCount(tabId));
      return;
    }

    const videoInfo = {
      url: videoKey,
      type: "youtube",
      pageTitle: title,
      pageUrl: message.pageUrl || "",
      qualities: displayQualities,
      duration: parsed.duration,
      resolved: true,
      resolving: false,
      isYouTube: true,
      videoId: parsed.videoId,
    };

    tabState.addVideo(tabId, videoInfo);
    setActiveIcon(tabId, tabState.getVideoCount(tabId));
  } catch (err) {
    console.error("Failed to parse YouTube player response:", err);
  }
}

async function resolveMetadata(tabId, url, type) {
  const video = tabState.getVideoByUrl(tabId, url);
  if (!video || video.resolved || video.resolving) return;

  tabState.updateVideo(tabId, url, { resolving: true });
  const pageUrl = video.pageUrl || "";

  // Set up Referer for the streaming domain so fetch succeeds
  if (pageUrl && (type === "hls" || type === "dash")) {
    await addRefererRule(url, pageUrl);
  }

  try {
    if (type === "hls") {
      const meta = await resolveHLS(url, pageUrl);
      tabState.updateVideo(tabId, url, {
        qualities: meta.qualities || null,
        isMaster: meta.isMaster,
        duration: meta.duration || null,
        encrypted: meta.encrypted,
        hasDRM: meta.hasDRM,
        audios: meta.audios || [],
        resolved: true,
        resolving: false,
      });
    } else if (type === "dash") {
      const meta = await resolveDASH(url, pageUrl);
      tabState.updateVideo(tabId, url, {
        qualities: meta.qualities || null,
        duration: meta.duration || null,
        hasAudio: meta.hasAudio,
        audioSets: meta.audioSets || [],
        resolved: true,
        resolving: false,
      });
    } else if (type === "direct") {
      const size = await resolveDirectSize(url, pageUrl);
      tabState.updateVideo(tabId, url, {
        size,
        resolved: true,
        resolving: false,
      });
    }
  } catch {
    tabState.updateVideo(tabId, url, { resolved: true, resolving: false });
  }
}

// Message handling
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { action } = message;

  // From content script - stream detected
  if (action === "streamDetected" && sender.tab) {
    handleVideoDetected(sender.tab.id, message);
    sendResponse({ ok: true });
    return true;
  }

  // From content script - YouTube player response
  if (action === "youtubePlayerResponse" && sender.tab) {
    handleYouTubePlayerResponse(sender.tab.id, message);
    sendResponse({ ok: true });
    return true;
  }

  // From popup - get videos for current tab
  if (action === "getVideos") {
    const videos = tabState.getVideos(message.tabId);
    sendResponse({ videos });
    return true;
  }

  // From popup - download a video
  if (action === "downloadVideo") {
    handleDownloadRequest(message).then((result) => sendResponse(result));
    return true;
  }

  // From popup - get download progress
  if (action === "getDownloadProgress") {
    sendResponse({ downloads: downloadManager.getDownloads() });
    return true;
  }

  // From popup - cancel a download
  if (action === "cancelDownload") {
    downloadManager.cancelDownload(message.downloadId);
    sendResponse({ ok: true });
    return true;
  }

  // From popup - resume a paused/errored download
  if (action === "resumeDownload") {
    downloadManager.resumeDownload(message.downloadId);
    sendResponse({ ok: true });
    return true;
  }

  // From popup - remove a finished/errored download from the list
  if (action === "removeDownload") {
    downloadManager.removeDownload(message.downloadId);
    sendResponse({ ok: true });
    return true;
  }

  // From offscreen document - progress updates
  if (action === "offscreen-progress") {
    const updates = {
      status: message.status || "downloading",
    };
    if (message.progress !== undefined) updates.progress = message.progress;
    if (message.segmentsComplete !== undefined) updates.segmentsComplete = message.segmentsComplete;
    if (message.segmentsTotal !== undefined) updates.segmentsTotal = message.segmentsTotal;
    if (message.bytesReceived !== undefined) updates.bytesReceived = message.bytesReceived;
    if (message.error !== undefined) updates.error = message.error;
    if (updates.status === "downloading") {
      updates.autoRetrying = false;
      updates.retryStartedAt = null;
    }
    downloadManager.updateDownload(message.downloadId, updates);
    sendResponse({ ok: true });
    return true;
  }

  // From offscreen - download complete, save blob
  if (action === "offscreen-save") {
    const dl = downloadManager.getDownload(message.downloadId);
    if (dl) {
      chrome.downloads.download(
        { url: message.blobUrl, filename: message.filename, saveAs: false },
        (chromeId) => {
          if (chrome.runtime.lastError) {
            dl.status = "error";
            dl.error = chrome.runtime.lastError.message;
          } else {
            dl.chromeDownloadId = chromeId;
            dl.status = "complete";
            dl.progress = 100;
          }
        }
      );
    }
    sendResponse({ ok: true });
    return true;
  }

  // From offscreen - download error
  if (action === "offscreen-error") {
    downloadManager.updateDownload(message.downloadId, {
      status: message.autoRetrying ? "retrying" : "error",
      error: message.error,
      resumable: !!message.resumable,
      autoRetrying: !!message.autoRetrying,
      retryStartedAt: message.autoRetrying ? Date.now() : null,
    });
    sendResponse({ ok: true });
    return true;
  }

  return true;
});

async function handleDownloadRequest(message) {
  const { url, type, quality, filename, tabId } = message;

  // Get page title and URL for filename generation and referer
  const video = tabState.getVideoByUrl(tabId, url);
  const pageTitle = video?.pageTitle || "";
  const pageUrl = video?.pageUrl || "";

  if (type === "direct") {
    const name = filename || generateVideoFilename(
      pageTitle,
      quality?.resolution,
      extractFilename(url).split(".").pop() || "mp4"
    );
    downloadManager.downloadDirect(url, name);
    return { started: true };
  }

  if (type === "hls") {
    const variantUrl = quality?.url || url;
    const ext = "ts"; // HLS downloads as TS (or mp4 if transmuxed)
    const name = filename || generateVideoFilename(
      pageTitle,
      quality?.resolution || quality?.label,
      ext
    );
    // Inject Referer header for the streaming CDN
    const referer = pageUrl || url;
    await addRefererRule(variantUrl, referer);
    await addRefererRule(url, referer);
    await downloadManager.downloadHLS(url, variantUrl, name, pageUrl);
    return { started: true };
  }

  if (type === "dash") {
    const name = filename || generateVideoFilename(
      pageTitle,
      quality?.resolution || quality?.label,
      "mp4"
    );
    const referer = pageUrl || url;
    await addRefererRule(url, referer);
    await downloadManager.downloadDASH(
      url,
      quality?.segments,
      null, // audio segments (future)
      name,
      pageUrl
    );
    return { started: true };
  }

  // YouTube direct URL download
  if (type === "youtube" || type === "youtube-stream") {
    const downloadUrl = quality?.url || url;
    if (!downloadUrl || downloadUrl.startsWith("youtube://")) {
      return { error: "No direct download URL available (signature protected)" };
    }

    // Determine extension from mime type
    const mime = quality?.mimeType || "";
    let ext = "mp4";
    if (mime.includes("webm")) ext = "webm";
    else if (mime.includes("m4a") || quality?.audioOnly) ext = "m4a";

    const qualityLabel = quality?.label || quality?.resolution || "";
    const name = filename || generateVideoFilename(pageTitle, qualityLabel, ext);
    downloadManager.downloadDirect(downloadUrl, name);
    return { started: true };
  }

  return { error: "Unknown video type" };
}

// Clean up tab state
chrome.tabs.onRemoved.addListener((tabId) => {
  tabState.clearTab(tabId);
  tabHasYouTubePlayer.delete(tabId);
  setInactiveIcon(tabId);
});

// Reset on navigation
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    tabState.clearTab(tabId);
    tabHasYouTubePlayer.delete(tabId);
    setInactiveIcon(tabId);
  }
});
