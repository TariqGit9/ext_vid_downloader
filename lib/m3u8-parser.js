// Lightweight HLS M3U8 manifest parser

/**
 * Parse an M3U8 manifest string.
 * @param {string} text - raw manifest content
 * @param {string} baseUrl - base URL for resolving relative paths
 * @returns {object} parsed manifest
 */
export function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());

  // A playlist is only "master" if it has #EXT-X-STREAM-INF (variant streams).
  // #EXT-X-MEDIA alone (audio tracks) does NOT make it a master playlist.
  const hasStreamInf = lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"));

  if (hasStreamInf) {
    return parseMasterPlaylist(lines, baseUrl);
  }
  return parseMediaPlaylist(lines, baseUrl);
}

function resolveUrl(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

function parseMasterPlaylist(lines, baseUrl) {
  const variants = [];
  const audios = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Audio tracks
    if (line.startsWith("#EXT-X-MEDIA") && line.includes('TYPE=AUDIO')) {
      const uri = extractAttr(line, "URI");
      const name = extractAttr(line, "NAME") || "Audio";
      const groupId = extractAttr(line, "GROUP-ID");
      if (uri) {
        audios.push({ name, groupId, url: resolveUrl(uri, baseUrl) });
      }
    }

    // Video variants
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const bandwidth = parseInt(extractAttr(line, "BANDWIDTH")) || 0;
      const resolution = extractAttr(line, "RESOLUTION") || "";
      const codecs = extractAttr(line, "CODECS") || "";
      const audioGroup = extractAttr(line, "AUDIO");
      const frameRate = extractAttr(line, "FRAME-RATE");

      // Next non-comment line is the URL
      let url = "";
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith("#")) {
          url = resolveUrl(lines[j].trim(), baseUrl);
          i = j;
          break;
        }
      }

      const [width, height] = resolution.split("x").map(Number);
      variants.push({
        bandwidth,
        resolution,
        width: width || 0,
        height: height || 0,
        codecs,
        audioGroup,
        frameRate: frameRate ? parseFloat(frameRate) : null,
        url,
      });
    }
  }

  // Sort by bandwidth descending (highest quality first)
  variants.sort((a, b) => b.bandwidth - a.bandwidth);

  return { isMaster: true, variants, audios };
}

function parseMediaPlaylist(lines, baseUrl) {
  const segments = [];
  let totalDuration = 0;
  let encrypted = false;
  let encryptionMethod = null;
  let keyUrl = null;
  let iv = null;
  let initSegment = null;
  let currentDuration = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line.startsWith("#EXTINF")) {
      const match = line.match(/#EXTINF:([0-9.]+)/);
      currentDuration = match ? parseFloat(match[1]) : 0;
    } else if (line.startsWith("#EXT-X-KEY")) {
      const method = extractAttr(line, "METHOD");
      if (method && method !== "NONE") {
        encrypted = true;
        encryptionMethod = method;
        const uri = extractAttr(line, "URI");
        if (uri) keyUrl = resolveUrl(uri, baseUrl);
        iv = extractAttr(line, "IV");
      } else {
        encrypted = false;
        encryptionMethod = null;
      }
    } else if (line.startsWith("#EXT-X-MAP")) {
      const uri = extractAttr(line, "URI");
      if (uri) initSegment = resolveUrl(uri, baseUrl);
    } else if (!line.startsWith("#") && line.length > 0) {
      const segUrl = resolveUrl(line, baseUrl);
      segments.push({
        url: segUrl,
        duration: currentDuration,
        encrypted,
        encryptionMethod,
        keyUrl,
        iv,
      });
      totalDuration += currentDuration;
      currentDuration = 0;
    }
  }

  const hasDRM = segments.some(
    (s) =>
      s.encryptionMethod === "SAMPLE-AES" ||
      s.encryptionMethod === "SAMPLE-AES-CTR"
  );

  return {
    isMaster: false,
    segments,
    totalDuration,
    encrypted: segments.some((s) => s.encrypted),
    hasDRM,
    initSegment,
  };
}

function extractAttr(line, name) {
  // Handle both quoted and unquoted values
  const quotedMatch = line.match(new RegExp(name + '="([^"]*)"'));
  if (quotedMatch) return quotedMatch[1];

  const unquotedMatch = line.match(
    new RegExp(name + "=([^,\\s]+)")
  );
  if (unquotedMatch) return unquotedMatch[1];

  return null;
}
