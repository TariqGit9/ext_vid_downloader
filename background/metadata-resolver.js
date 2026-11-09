// Resolve metadata for detected videos (quality variants, size, duration)

import { parseM3U8 } from "../lib/m3u8-parser.js";
import { parseMPD } from "../lib/mpd-parser.js";
import { getQualityLabel, formatBitrate } from "../lib/utils.js";

/**
 * Build fetch options with proper Referer/Origin headers.
 */
function fetchOpts(referer) {
  const headers = {};
  if (referer) {
    try {
      const origin = new URL(referer).origin;
      headers["Referer"] = referer;
      headers["Origin"] = origin;
    } catch {}
  }
  return { headers, credentials: "omit" };
}

/**
 * Fetch and parse HLS manifest to get quality variants.
 */
export async function resolveHLS(url, pageUrl) {
  try {
    const opts = fetchOpts(pageUrl || url);
    const response = await fetch(url, opts);
    if (!response.ok) return { error: `Failed to fetch manifest: ${response.status}` };
    const text = await response.text();
    const manifest = parseM3U8(text, url);

    if (manifest.isMaster && manifest.variants.length > 0) {
      const qualities = manifest.variants.map((v) => ({
        url: v.url,
        resolution: v.resolution,
        height: v.height,
        width: v.width,
        bandwidth: v.bandwidth,
        codecs: v.codecs,
        label: getQualityLabel(v.height, v.bandwidth),
        estimatedSize: null,
      }));
      return {
        isMaster: true,
        qualities,
        audios: manifest.audios,
      };
    }

    // Media playlist (or master with 0 variants — treat as media)
    return {
      isMaster: false,
      segments: manifest.segments?.length || 0,
      duration: manifest.totalDuration || 0,
      encrypted: manifest.encrypted || false,
      hasDRM: manifest.hasDRM || false,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Fetch and parse DASH manifest to get quality variants.
 */
export async function resolveDASH(url, pageUrl) {
  try {
    const opts = fetchOpts(pageUrl || url);
    const response = await fetch(url, opts);
    if (!response.ok) return { error: `Failed to fetch manifest: ${response.status}` };
    const text = await response.text();
    const manifest = parseMPD(text, url);

    if (manifest.error) return manifest;

    const videoSets = manifest.adaptationSets.filter(
      (a) => a.type === "video"
    );
    const audioSets = manifest.adaptationSets.filter(
      (a) => a.type === "audio"
    );

    const qualities = [];
    for (const vs of videoSets) {
      for (const rep of vs.representations) {
        qualities.push({
          url: url,
          representationId: rep.id,
          resolution: rep.resolution,
          height: rep.height,
          width: rep.width,
          bandwidth: rep.bandwidth,
          codecs: rep.codecs,
          label: getQualityLabel(rep.height, rep.bandwidth),
          segments: rep.segments,
          estimatedSize: manifest.duration
            ? Math.round((rep.bandwidth * manifest.duration) / 8)
            : null,
        });
      }
    }

    return {
      qualities,
      duration: manifest.duration,
      hasAudio: audioSets.length > 0,
      audioSets,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Get size of a direct video via HEAD request.
 */
export async function resolveDirectSize(url, pageUrl) {
  try {
    const opts = fetchOpts(pageUrl || url);
    opts.method = "HEAD";
    const response = await fetch(url, opts);
    const size = response.headers.get("content-length");
    return size ? parseInt(size) : null;
  } catch {
    return null;
  }
}
