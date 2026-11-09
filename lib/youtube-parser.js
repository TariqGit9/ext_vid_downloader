// YouTube-specific video extraction

// itag -> quality mapping
const ITAG_MAP = {
  // Video + Audio (progressive)
  18: { quality: "360p", type: "video/mp4", hasAudio: true },
  22: { quality: "720p", type: "video/mp4", hasAudio: true },
  37: { quality: "1080p", type: "video/mp4", hasAudio: true },
  38: { quality: "3072p", type: "video/mp4", hasAudio: true },
  82: { quality: "360p", type: "video/mp4; 3D", hasAudio: true },
  83: { quality: "480p", type: "video/mp4; 3D", hasAudio: true },
  84: { quality: "720p", type: "video/mp4; 3D", hasAudio: true },
  85: { quality: "1080p", type: "video/mp4; 3D", hasAudio: true },

  // Video only (adaptive) - MP4
  133: { quality: "240p", type: "video/mp4", hasAudio: false },
  134: { quality: "360p", type: "video/mp4", hasAudio: false },
  135: { quality: "480p", type: "video/mp4", hasAudio: false },
  136: { quality: "720p", type: "video/mp4", hasAudio: false },
  137: { quality: "1080p", type: "video/mp4", hasAudio: false },
  138: { quality: "2160p", type: "video/mp4", hasAudio: false },
  160: { quality: "144p", type: "video/mp4", hasAudio: false },
  264: { quality: "1440p", type: "video/mp4", hasAudio: false },
  266: { quality: "2160p", type: "video/mp4", hasAudio: false },
  298: { quality: "720p60", type: "video/mp4", hasAudio: false },
  299: { quality: "1080p60", type: "video/mp4", hasAudio: false },
  304: { quality: "720p60", type: "video/mp4", hasAudio: false },
  305: { quality: "1080p60", type: "video/mp4", hasAudio: false },

  // Video only (adaptive) - WebM
  167: { quality: "360p", type: "video/webm", hasAudio: false },
  168: { quality: "480p", type: "video/webm", hasAudio: false },
  169: { quality: "720p", type: "video/webm", hasAudio: false },
  170: { quality: "1080p", type: "video/webm", hasAudio: false },
  218: { quality: "480p", type: "video/webm", hasAudio: false },
  219: { quality: "480p", type: "video/webm", hasAudio: false },
  242: { quality: "240p", type: "video/webm", hasAudio: false },
  243: { quality: "360p", type: "video/webm", hasAudio: false },
  244: { quality: "480p", type: "video/webm", hasAudio: false },
  245: { quality: "480p", type: "video/webm", hasAudio: false },
  246: { quality: "480p", type: "video/webm", hasAudio: false },
  247: { quality: "720p", type: "video/webm", hasAudio: false },
  248: { quality: "1080p", type: "video/webm", hasAudio: false },
  271: { quality: "1440p", type: "video/webm", hasAudio: false },
  272: { quality: "2160p", type: "video/webm", hasAudio: false },
  302: { quality: "720p60", type: "video/webm", hasAudio: false },
  303: { quality: "1080p60", type: "video/webm", hasAudio: false },
  308: { quality: "1440p60", type: "video/webm", hasAudio: false },
  313: { quality: "2160p", type: "video/webm", hasAudio: false },
  315: { quality: "2160p60", type: "video/webm", hasAudio: false },

  // Audio only
  139: { quality: "48kbps", type: "audio/m4a", hasAudio: true, audioOnly: true },
  140: { quality: "128kbps", type: "audio/m4a", hasAudio: true, audioOnly: true },
  141: { quality: "256kbps", type: "audio/m4a", hasAudio: true, audioOnly: true },
  171: { quality: "128kbps", type: "audio/webm", hasAudio: true, audioOnly: true },
  172: { quality: "256kbps", type: "audio/webm", hasAudio: true, audioOnly: true },
  249: { quality: "50kbps", type: "audio/webm", hasAudio: true, audioOnly: true },
  250: { quality: "70kbps", type: "audio/webm", hasAudio: true, audioOnly: true },
  251: { quality: "160kbps", type: "audio/webm", hasAudio: true, audioOnly: true },
};

/**
 * Parse YouTube player response JSON to extract video streams.
 * @param {object} playerResponse - The ytInitialPlayerResponse or /player API response
 * @returns {object} Parsed video info with qualities
 */
export function parsePlayerResponse(playerResponse) {
  if (!playerResponse) return null;

  const videoDetails = playerResponse.videoDetails || {};
  const streamingData = playerResponse.streamingData || {};

  const title = videoDetails.title || "";
  const duration = parseInt(videoDetails.lengthSeconds) || 0;
  const videoId = videoDetails.videoId || "";
  const channelName = videoDetails.author || "";
  const thumbnail = videoDetails.thumbnail?.thumbnails?.slice(-1)[0]?.url || "";

  const qualities = [];

  // Progressive streams (video + audio combined) — these are direct downloadable
  const formats = streamingData.formats || [];
  for (const fmt of formats) {
    const itag = fmt.itag;
    const itagInfo = ITAG_MAP[itag] || {};
    const url = fmt.url || null;

    // If URL is missing, it needs signature decryption (signatureCipher)
    const signatureCipher = fmt.signatureCipher || fmt.cipher || null;

    if (!url && !signatureCipher) continue;

    qualities.push({
      itag,
      url: url || null,
      signatureCipher,
      quality: fmt.qualityLabel || itagInfo.quality || fmt.quality || "Unknown",
      mimeType: fmt.mimeType || itagInfo.type || "video/mp4",
      hasAudio: true,
      audioOnly: false,
      width: fmt.width || 0,
      height: fmt.height || 0,
      contentLength: parseInt(fmt.contentLength) || null,
      bitrate: fmt.bitrate || 0,
      fps: fmt.fps || 30,
      label: fmt.qualityLabel || itagInfo.quality || "Unknown",
    });
  }

  // Adaptive streams (video-only and audio-only)
  const adaptiveFormats = streamingData.adaptiveFormats || [];
  for (const fmt of adaptiveFormats) {
    const itag = fmt.itag;
    const itagInfo = ITAG_MAP[itag] || {};
    const url = fmt.url || null;
    const signatureCipher = fmt.signatureCipher || fmt.cipher || null;

    if (!url && !signatureCipher) continue;

    const mime = fmt.mimeType || itagInfo.type || "";
    const isAudio = mime.startsWith("audio") || itagInfo.audioOnly;

    qualities.push({
      itag,
      url: url || null,
      signatureCipher,
      quality: fmt.qualityLabel || itagInfo.quality || fmt.quality || (isAudio ? fmt.audioQuality : "Unknown"),
      mimeType: mime,
      hasAudio: isAudio,
      audioOnly: isAudio,
      width: fmt.width || 0,
      height: fmt.height || 0,
      contentLength: parseInt(fmt.contentLength) || null,
      bitrate: fmt.bitrate || 0,
      fps: fmt.fps || 0,
      label: isAudio
        ? `Audio ${fmt.audioQuality || itagInfo.quality || ""} (${mime.split(";")[0]})`
        : `${fmt.qualityLabel || itagInfo.quality || "?"} (${mime.includes("webm") ? "WebM" : "MP4"}, no audio)`,
    });
  }

  // Sort: progressive first (has audio), then by height descending
  qualities.sort((a, b) => {
    // Progressive (video+audio) first
    if (a.hasAudio && !a.audioOnly && (!b.hasAudio || b.audioOnly)) return -1;
    if (b.hasAudio && !b.audioOnly && (!a.hasAudio || a.audioOnly)) return 1;
    // Audio only last
    if (a.audioOnly && !b.audioOnly) return 1;
    if (b.audioOnly && !a.audioOnly) return -1;
    // Then by height/bitrate
    return (b.height || b.bitrate) - (a.height || a.bitrate);
  });

  return {
    title,
    duration,
    videoId,
    channelName,
    thumbnail,
    qualities,
    isYouTube: true,
  };
}

/**
 * Decode a signatureCipher string into its components.
 * Note: Actually decrypting the signature requires YouTube's player JS.
 */
export function parseSignatureCipher(cipherStr) {
  const params = new URLSearchParams(cipherStr);
  return {
    url: params.get("url"),
    s: params.get("s"),        // encrypted signature
    sp: params.get("sp") || "signature", // signature parameter name
  };
}

/**
 * Check if a videoplayback URL contains itag info and extract it.
 */
export function parseVideoplaybackUrl(url) {
  try {
    const u = new URL(url);
    const itag = parseInt(u.searchParams.get("itag"));
    const range = u.searchParams.get("range");
    const clen = parseInt(u.searchParams.get("clen")) || null;
    const info = ITAG_MAP[itag] || null;

    return {
      itag,
      info,
      contentLength: clen,
      isRange: !!range,
      quality: info?.quality || "Unknown",
      hasAudio: info?.hasAudio ?? false,
      audioOnly: info?.audioOnly ?? false,
    };
  } catch {
    return null;
  }
}
