// Shared utilities

export function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return "";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function formatBitrate(bps) {
  if (!bps) return "";
  if (bps >= 1000000) return (bps / 1000000).toFixed(1) + " Mbps";
  if (bps >= 1000) return (bps / 1000).toFixed(0) + " Kbps";
  return bps + " bps";
}

export function cleanFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .substring(0, 200);
}

export function extractFilename(url) {
  try {
    const urlObj = new URL(url);
    let name = urlObj.pathname.split("/").pop() || "video";
    name = name.split("?")[0];
    return decodeURIComponent(name);
  } catch {
    return "video";
  }
}

export function generateVideoFilename(pageTitle, resolution, ext) {
  let name = pageTitle || "video";
  // Clean common suffixes
  name = name
    .replace(/\s*[-|]\s*(YouTube|Reddit|Twitter|X|Vimeo|Facebook|TikTok).*$/i, "")
    .trim();
  name = cleanFilename(name);
  if (resolution) name += `_${resolution}`;
  return name + "." + (ext || "mp4");
}

export function getQualityLabel(height, bandwidth) {
  if (height >= 2160) return "4K";
  if (height >= 1440) return "1440p";
  if (height >= 1080) return "1080p";
  if (height >= 720) return "720p";
  if (height >= 480) return "480p";
  if (height >= 360) return "360p";
  if (height >= 240) return "240p";
  if (height > 0) return height + "p";
  if (bandwidth) return formatBitrate(bandwidth);
  return "Unknown";
}
