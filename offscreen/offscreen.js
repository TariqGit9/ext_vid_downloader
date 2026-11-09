// Offscreen document - handles long-running download tasks
// (Service workers get killed after 30s, this stays alive)

import { parseM3U8 } from "../lib/m3u8-parser.js";
import { transmuxTStoMP4 } from "../lib/mp4-muxer.js";

const MAX_CONCURRENT = 4;
const SEGMENT_RETRY_LIMIT = 3;
const SEGMENT_TIMEOUT_MS = 30000;

// Active download state — keyed by downloadId — for resume/cancel
const activeJobs = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "offscreen-download-hls") {
    downloadHLS(message);
    sendResponse({ ok: true });
  }
  if (message.action === "offscreen-download-dash") {
    downloadDASH(message);
    sendResponse({ ok: true });
  }
  if (message.action === "offscreen-cancel") {
    cancelJob(message.downloadId);
    sendResponse({ ok: true });
  }
  if (message.action === "offscreen-resume") {
    resumeJob(message.downloadId);
    sendResponse({ ok: true });
  }
  if (message.action === "offscreen-ping") {
    sendResponse({ alive: true, jobs: activeJobs.size });
  }
  return true;
});

function cancelJob(downloadId) {
  const job = activeJobs.get(downloadId);
  if (job) {
    job.cancelled = true;
    if (job.abortController) job.abortController.abort();
  }
}

function resumeJob(downloadId) {
  const job = activeJobs.get(downloadId);
  if (!job || job.running) return;
  job.cancelled = false;
  job.abortController = new AbortController();
  // Re-run the segment download phase with existing buffers preserved
  if (job.type === "hls") {
    runMediaPlaylist(job).catch((err) => {
      chrome.runtime.sendMessage({
        action: "offscreen-error",
        downloadId,
        error: err.message,
      });
    });
  } else if (job.type === "dash") {
    runDashSegments(job).catch((err) => {
      chrome.runtime.sendMessage({
        action: "offscreen-error",
        downloadId,
        error: err.message,
      });
    });
  }
}

/**
 * Build fetch options with proper Referer/Origin headers.
 */
function fetchOpts(referer, signal) {
  const headers = {};
  if (referer) {
    try {
      const origin = new URL(referer).origin;
      headers["Referer"] = referer;
      headers["Origin"] = origin;
    } catch {}
  }
  return { headers, credentials: "omit", signal };
}

/**
 * Fetch with timeout and retry. Honors Retry-After header for 429/503.
 * For rate-limit errors, retries longer with progressive backoff.
 */
async function fetchWithRetry(url, baseOpts, retries = SEGMENT_RETRY_LIMIT) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), SEGMENT_TIMEOUT_MS);
      const opts = { ...baseOpts, signal: ac.signal };
      const resp = await fetch(url, opts);
      clearTimeout(timer);
      if (!resp.ok) {
        const err = new Error(`HTTP ${resp.status}`);
        err.status = resp.status;
        // Read Retry-After if present
        const retryAfter = resp.headers.get("retry-after");
        if (retryAfter) {
          const seconds = parseInt(retryAfter);
          if (!isNaN(seconds)) err.retryAfterMs = seconds * 1000;
        }
        throw err;
      }
      return resp;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        let waitMs;
        if (err.status === 429 || err.status === 503) {
          // Rate limited — wait longer (server-suggested or 5s/10s/20s)
          waitMs = err.retryAfterMs || 5000 * Math.pow(2, attempt);
        } else {
          // Generic retry — 500ms, 1s, 2s
          waitMs = 500 * Math.pow(2, attempt);
        }
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }
  throw lastErr || new Error("Fetch failed");
}

/**
 * Returns true if an error indicates a transient/retryable condition
 * that we should auto-resume from after a delay.
 */
function isRetryableError(err) {
  if (!err) return false;
  const msg = err.message || "";
  if (err.status === 429 || err.status === 503 || err.status === 502 || err.status === 504) {
    return true;
  }
  if (msg.includes("HTTP 429") || msg.includes("HTTP 503") ||
      msg.includes("HTTP 502") || msg.includes("HTTP 504")) {
    return true;
  }
  // Network errors
  if (msg.includes("Failed to fetch") || msg.includes("network") ||
      msg.includes("aborted") || msg.includes("timeout")) {
    return true;
  }
  return false;
}

async function downloadHLS({ downloadId, manifestUrl, variantUrl, filename, pageUrl }) {
  const opts = fetchOpts(pageUrl || manifestUrl);

  try {
    const response = await fetchWithRetry(variantUrl, opts);
    const text = await response.text();
    const manifest = parseM3U8(text, variantUrl);

    if (manifest.isMaster) {
      if (manifest.variants.length === 0) {
        const fallback = parseM3U8(
          text.replace(/#EXT-X-STREAM-INF[^\n]*/g, ""),
          variantUrl
        );
        if (fallback.segments && fallback.segments.length > 0) {
          return startMediaPlaylistJob(downloadId, fallback, variantUrl, filename, pageUrl);
        }
        throw new Error("No variants or segments found in playlist");
      }
      const best = manifest.variants[0];
      return downloadHLS({
        downloadId,
        manifestUrl,
        variantUrl: best.url,
        filename,
        pageUrl,
      });
    }

    return startMediaPlaylistJob(downloadId, manifest, variantUrl, filename, pageUrl);
  } catch (err) {
    chrome.runtime.sendMessage({
      action: "offscreen-error",
      downloadId,
      error: err.message,
    });
  }
}

async function startMediaPlaylistJob(downloadId, manifest, baseUrl, filename, pageUrl) {
  if (manifest.hasDRM) {
    chrome.runtime.sendMessage({
      action: "offscreen-error",
      downloadId,
      error: "This video is DRM protected and cannot be downloaded",
    });
    return;
  }

  const segments = manifest.segments;
  if (!segments || segments.length === 0) {
    chrome.runtime.sendMessage({
      action: "offscreen-error",
      downloadId,
      error: "No segments found in playlist",
    });
    return;
  }

  // Initialize or load existing job
  let job = activeJobs.get(downloadId);
  if (!job) {
    job = {
      type: "hls",
      downloadId,
      manifest,
      baseUrl,
      filename,
      pageUrl,
      buffers: new Array(segments.length),
      bytesTotal: 0,
      decryptionKey: null,
      cancelled: false,
      running: false,
      abortController: new AbortController(),
    };
    activeJobs.set(downloadId, job);
  }

  return runMediaPlaylist(job);
}

async function runMediaPlaylist(job) {
  if (job.running) return;
  job.running = true;
  // Reset auto-retry counter once we successfully resume past the previous failure
  let progressedAfterRetry = false;

  try {
    const { manifest, baseUrl, pageUrl, buffers } = job;
    const segments = manifest.segments;
    const total = segments.length;
    const opts = fetchOpts(pageUrl || baseUrl);

    // Set up AES-128 decryption key (only fetch once)
    if (
      !job.decryptionKey &&
      manifest.encrypted &&
      segments[0]?.encryptionMethod === "AES-128" &&
      segments[0]?.keyUrl
    ) {
      const keyResponse = await fetchWithRetry(segments[0].keyUrl, opts);
      const keyData = await keyResponse.arrayBuffer();
      job.decryptionKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "AES-CBC" },
        false,
        ["decrypt"]
      );
    }

    // Count already-completed buffers
    let completed = buffers.filter((b) => b).length;
    reportProgress(job.downloadId, {
      segmentsTotal: total,
      segmentsComplete: completed,
      progress: Math.round((completed / total) * 100),
      bytesReceived: job.bytesTotal,
      status: "downloading",
    });

    const semaphore = new Semaphore(MAX_CONCURRENT);

    const downloadSegment = async (index) => {
      if (job.cancelled || buffers[index]) return; // Skip if already done or cancelled
      await semaphore.acquire();
      try {
        if (job.cancelled || buffers[index]) return;
        const seg = segments[index];
        const segOpts = fetchOpts(pageUrl || baseUrl);
        const resp = await fetchWithRetry(seg.url, segOpts);
        let data = await resp.arrayBuffer();

        if (seg.encrypted && seg.encryptionMethod === "AES-128" && job.decryptionKey) {
          const iv = seg.iv
            ? hexToBuffer(seg.iv.replace(/^0x/, ""))
            : createSequenceIV(index);
          data = await crypto.subtle.decrypt(
            { name: "AES-CBC", iv },
            job.decryptionKey,
            data
          );
        }

        if (job.cancelled) return;
        buffers[index] = new Uint8Array(data);
        job.bytesTotal += data.byteLength;
        completed++;
        // Successful segment — reset retry counter
        job.autoRetryCount = 0;

        reportProgress(job.downloadId, {
          segmentsTotal: total,
          segmentsComplete: completed,
          progress: Math.round((completed / total) * 100),
          bytesReceived: job.bytesTotal,
          status: "downloading",
        });
      } finally {
        semaphore.release();
      }
    };

    await Promise.all(segments.map((_, i) => downloadSegment(i)));

    if (job.cancelled) {
      reportProgress(job.downloadId, { status: "paused" });
      job.running = false;
      return;
    }

    // Verify all segments downloaded
    const missing = buffers.findIndex((b) => !b);
    if (missing >= 0) {
      throw new Error(`Segment ${missing} failed after retries`);
    }

    reportProgress(job.downloadId, { status: "merging", progress: 95 });

    let initBuffer = null;
    if (manifest.initSegment) {
      const initResp = await fetchWithRetry(manifest.initSegment, opts);
      initBuffer = new Uint8Array(await initResp.arrayBuffer());
    }

    const totalSize = (initBuffer?.byteLength || 0) +
      buffers.reduce((sum, b) => sum + (b?.byteLength || 0), 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;

    if (initBuffer) {
      merged.set(initBuffer, 0);
      offset += initBuffer.byteLength;
    }

    for (const buf of buffers) {
      if (buf) {
        merged.set(buf, offset);
        offset += buf.byteLength;
      }
    }

    let ext = "mp4";
    let outputData = merged;
    let mimeType = "video/mp4";

    // If segments are .m4s, they're already fragmented MP4 — just save as mp4
    if (manifest.initSegment || segments[0]?.url?.includes(".m4s")) {
      ext = "mp4";
    } else {
      // Raw TS — transmux to fragmented MP4 for VLC compatibility
      try {
        reportProgress(job.downloadId, { status: "merging", progress: 97 });
        outputData = await transmuxTStoMP4(merged);
        ext = "mp4";
        mimeType = "video/mp4";
      } catch (muxErr) {
        // Fallback: save as TS if transmux fails
        console.warn("TS->MP4 transmux failed, saving as .ts:", muxErr);
        ext = "ts";
        mimeType = "video/mp2t";
      }
    }

    let { filename } = job;
    if (!filename.endsWith("." + ext)) {
      filename = filename.replace(/\.[^.]+$/, "") + "." + ext;
    }

    const blob = new Blob([outputData], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage({
      action: "offscreen-save",
      downloadId: job.downloadId,
      blobUrl,
      filename,
    });

    activeJobs.delete(job.downloadId);
  } catch (err) {
    job.running = false;
    const retryable = isRetryableError(err);
    chrome.runtime.sendMessage({
      action: "offscreen-error",
      downloadId: job.downloadId,
      error: err.message,
      resumable: true,
      autoRetrying: retryable,
    });

    // Auto-resume on rate-limit / transient errors
    if (retryable && !job.cancelled) {
      const attempt = (job.autoRetryCount = (job.autoRetryCount || 0) + 1);
      if (attempt <= 20) {
        // 15s, 30s, 60s, then cap at 60s
        const delay = Math.min(15000 * Math.pow(2, attempt - 1), 60000);
        setTimeout(() => {
          if (job.cancelled || !activeJobs.has(job.downloadId)) return;
          chrome.runtime.sendMessage({
            action: "offscreen-progress",
            downloadId: job.downloadId,
            status: "downloading",
            error: null,
          });
          if (job.type === "hls") {
            runMediaPlaylist(job).catch(() => {});
          } else if (job.type === "dash") {
            runDashSegments(job).catch(() => {});
          }
        }, delay);
      }
    }
  }
}

async function downloadDASH({ downloadId, mpdUrl, videoSegments, audioSegments, filename, pageUrl }) {
  const opts = fetchOpts(pageUrl || mpdUrl);

  try {
    if (!videoSegments || videoSegments.type === "single") {
      const url = videoSegments?.url || mpdUrl;
      const resp = await fetchWithRetry(url, opts);
      const data = await resp.arrayBuffer();

      const blob = new Blob([data], { type: "video/mp4" });
      const blobUrl = URL.createObjectURL(blob);

      chrome.runtime.sendMessage({
        action: "offscreen-save",
        downloadId,
        blobUrl,
        filename,
      });
      return;
    }

    const segList = videoSegments.segments || [];
    let job = activeJobs.get(downloadId);
    if (!job) {
      job = {
        type: "dash",
        downloadId,
        videoSegments,
        filename,
        pageUrl,
        mpdUrl,
        buffers: new Array(segList.length),
        initBuffer: null,
        bytesTotal: 0,
        cancelled: false,
        running: false,
        abortController: new AbortController(),
      };
      activeJobs.set(downloadId, job);
    }

    return runDashSegments(job);
  } catch (err) {
    chrome.runtime.sendMessage({
      action: "offscreen-error",
      downloadId,
      error: err.message,
    });
  }
}

async function runDashSegments(job) {
  if (job.running) return;
  job.running = true;

  try {
    const { videoSegments, pageUrl, mpdUrl, buffers } = job;
    const segList = videoSegments.segments || [];
    const total = segList.length;
    const opts = fetchOpts(pageUrl || mpdUrl);

    if (!job.initBuffer && videoSegments.initUrl) {
      const initResp = await fetchWithRetry(videoSegments.initUrl, opts);
      job.initBuffer = new Uint8Array(await initResp.arrayBuffer());
    }

    let completed = buffers.filter((b) => b).length;
    reportProgress(job.downloadId, {
      segmentsTotal: total,
      segmentsComplete: completed,
      progress: Math.round((completed / total) * 100),
      bytesReceived: job.bytesTotal,
      status: "downloading",
    });

    const semaphore = new Semaphore(MAX_CONCURRENT);

    const downloadSegment = async (index) => {
      if (job.cancelled || buffers[index]) return;
      await semaphore.acquire();
      try {
        if (job.cancelled || buffers[index]) return;
        const seg = segList[index];
        const resp = await fetchWithRetry(seg.url, opts);
        const data = await resp.arrayBuffer();

        if (job.cancelled) return;
        buffers[index] = new Uint8Array(data);
        job.bytesTotal += data.byteLength;
        completed++;
        // Successful segment — reset retry counter
        job.autoRetryCount = 0;

        reportProgress(job.downloadId, {
          segmentsTotal: total,
          segmentsComplete: completed,
          progress: Math.round((completed / total) * 100),
          bytesReceived: job.bytesTotal,
          status: "downloading",
        });
      } finally {
        semaphore.release();
      }
    };

    await Promise.all(segList.map((_, i) => downloadSegment(i)));

    if (job.cancelled) {
      reportProgress(job.downloadId, { status: "paused" });
      job.running = false;
      return;
    }

    const missing = buffers.findIndex((b) => !b);
    if (missing >= 0) {
      throw new Error(`Segment ${missing} failed after retries`);
    }

    reportProgress(job.downloadId, { status: "merging", progress: 95 });

    const totalSize = (job.initBuffer?.byteLength || 0) +
      buffers.reduce((sum, b) => sum + (b?.byteLength || 0), 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;

    if (job.initBuffer) {
      merged.set(job.initBuffer, 0);
      offset += job.initBuffer.byteLength;
    }

    for (const buf of buffers) {
      if (buf) {
        merged.set(buf, offset);
        offset += buf.byteLength;
      }
    }

    const blob = new Blob([merged], { type: "video/mp4" });
    const blobUrl = URL.createObjectURL(blob);

    chrome.runtime.sendMessage({
      action: "offscreen-save",
      downloadId: job.downloadId,
      blobUrl,
      filename: job.filename,
    });

    activeJobs.delete(job.downloadId);
  } catch (err) {
    job.running = false;
    const retryable = isRetryableError(err);
    chrome.runtime.sendMessage({
      action: "offscreen-error",
      downloadId: job.downloadId,
      error: err.message,
      resumable: true,
      autoRetrying: retryable,
    });

    // Auto-resume on rate-limit / transient errors
    if (retryable && !job.cancelled) {
      const attempt = (job.autoRetryCount = (job.autoRetryCount || 0) + 1);
      if (attempt <= 20) {
        // 15s, 30s, 60s, then cap at 60s
        const delay = Math.min(15000 * Math.pow(2, attempt - 1), 60000);
        setTimeout(() => {
          if (job.cancelled || !activeJobs.has(job.downloadId)) return;
          chrome.runtime.sendMessage({
            action: "offscreen-progress",
            downloadId: job.downloadId,
            status: "downloading",
            error: null,
          });
          if (job.type === "hls") {
            runMediaPlaylist(job).catch(() => {});
          } else if (job.type === "dash") {
            runDashSegments(job).catch(() => {});
          }
        }, delay);
      }
    }
  }
}

function reportProgress(downloadId, data) {
  chrome.runtime.sendMessage({
    action: "offscreen-progress",
    downloadId,
    ...data,
  });
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.queue = [];
  }
  acquire() {
    if (this.count < this.max) {
      this.count++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }
  release() {
    this.count--;
    if (this.queue.length > 0) {
      this.count++;
      this.queue.shift()();
    }
  }
}

function hexToBuffer(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes.buffer;
}

function createSequenceIV(sequenceNumber) {
  const iv = new ArrayBuffer(16);
  const view = new DataView(iv);
  view.setUint32(12, sequenceNumber);
  return iv;
}
