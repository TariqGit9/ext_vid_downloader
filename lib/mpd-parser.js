// Lightweight DASH MPD manifest parser

/**
 * Parse an MPD manifest string.
 * @param {string} text - raw MPD XML content
 * @param {string} baseUrl - base URL for resolving relative paths
 * @returns {object} parsed manifest with adaptation sets and representations
 */
export function parseMPD(text, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "application/xml");
  const mpd = doc.querySelector("MPD");
  if (!mpd) return { error: "Invalid MPD" };

  const mediaPresentationDuration = mpd.getAttribute(
    "mediaPresentationDuration"
  );
  const duration = mediaPresentationDuration
    ? parseDuration(mediaPresentationDuration)
    : 0;

  // Get base URL
  const baseUrlEl = mpd.querySelector("BaseURL");
  const mpdBaseUrl = baseUrlEl
    ? resolveUrl(baseUrlEl.textContent.trim(), baseUrl)
    : baseUrl;

  const periods = mpd.querySelectorAll("Period");
  const adaptationSets = [];

  periods.forEach((period) => {
    const periodBaseEl = period.querySelector("BaseURL");
    const periodBase = periodBaseEl
      ? resolveUrl(periodBaseEl.textContent.trim(), mpdBaseUrl)
      : mpdBaseUrl;

    period.querySelectorAll("AdaptationSet").forEach((as) => {
      const mimeType = as.getAttribute("mimeType") || "";
      const contentType = as.getAttribute("contentType") || "";
      const lang = as.getAttribute("lang") || "";
      const isVideo =
        mimeType.startsWith("video") || contentType === "video";
      const isAudio =
        mimeType.startsWith("audio") || contentType === "audio";

      const asBaseEl = as.querySelector("BaseURL");
      const asBase = asBaseEl
        ? resolveUrl(asBaseEl.textContent.trim(), periodBase)
        : periodBase;

      // Segment template at AdaptationSet level
      const segTemplate = as.querySelector("SegmentTemplate");

      const representations = [];
      as.querySelectorAll("Representation").forEach((rep) => {
        const id = rep.getAttribute("id") || "";
        const bandwidth = parseInt(rep.getAttribute("bandwidth")) || 0;
        const width = parseInt(rep.getAttribute("width")) || 0;
        const height = parseInt(rep.getAttribute("height")) || 0;
        const codecs =
          rep.getAttribute("codecs") || as.getAttribute("codecs") || "";

        const repBaseEl = rep.querySelector("BaseURL");
        const repBase = repBaseEl
          ? resolveUrl(repBaseEl.textContent.trim(), asBase)
          : asBase;

        // Get segments
        const segments = getSegments(
          rep,
          segTemplate,
          repBase,
          id,
          bandwidth
        );

        representations.push({
          id,
          bandwidth,
          width,
          height,
          codecs,
          mimeType: rep.getAttribute("mimeType") || mimeType,
          baseUrl: repBase,
          segments,
          resolution: width && height ? `${width}x${height}` : "",
        });
      });

      // Sort representations by bandwidth descending
      representations.sort((a, b) => b.bandwidth - a.bandwidth);

      adaptationSets.push({
        type: isVideo ? "video" : isAudio ? "audio" : "other",
        mimeType,
        lang,
        representations,
      });
    });
  });

  return { duration, adaptationSets };
}

function getSegments(rep, parentTemplate, baseUrl, repId, bandwidth) {
  const template = rep.querySelector("SegmentTemplate") || parentTemplate;
  if (!template) {
    // Check for SegmentList
    const segList = rep.querySelector("SegmentList");
    if (segList) {
      return getSegmentsFromList(segList, baseUrl);
    }
    // Single segment (BaseURL is the segment)
    return { type: "single", url: baseUrl };
  }

  const initTemplate = template.getAttribute("initialization") || "";
  const mediaTemplate = template.getAttribute("media") || "";
  const startNumber = parseInt(template.getAttribute("startNumber")) || 1;
  const timescale = parseInt(template.getAttribute("timescale")) || 1;

  const initUrl = initTemplate
    ? resolveUrl(
        fillTemplate(initTemplate, repId, bandwidth, 0, 0),
        baseUrl
      )
    : null;

  // SegmentTimeline
  const timeline = template.querySelector("SegmentTimeline");
  const segments = [];

  if (timeline) {
    let time = 0;
    let number = startNumber;
    timeline.querySelectorAll("S").forEach((s) => {
      const t = parseInt(s.getAttribute("t"));
      const d = parseInt(s.getAttribute("d"));
      const r = parseInt(s.getAttribute("r")) || 0;

      if (!isNaN(t)) time = t;

      for (let i = 0; i <= r; i++) {
        const url = resolveUrl(
          fillTemplate(mediaTemplate, repId, bandwidth, number, time),
          baseUrl
        );
        segments.push({ url, duration: d / timescale });
        time += d;
        number++;
      }
    });
  }

  return { type: "template", initUrl, segments };
}

function getSegmentsFromList(segList, baseUrl) {
  const initEl = segList.querySelector("Initialization");
  const initUrl = initEl
    ? resolveUrl(initEl.getAttribute("sourceURL"), baseUrl)
    : null;

  const segments = [];
  segList.querySelectorAll("SegmentURL").forEach((seg) => {
    const media = seg.getAttribute("media");
    if (media) {
      segments.push({ url: resolveUrl(media, baseUrl) });
    }
  });

  return { type: "list", initUrl, segments };
}

function fillTemplate(template, id, bandwidth, number, time) {
  return template
    .replace(/\$RepresentationID\$/g, id)
    .replace(/\$Bandwidth\$/g, bandwidth)
    .replace(/\$Number(\%\d+d)?\$/g, (match, format) => {
      if (format) {
        const width = parseInt(format.replace("%", "").replace("d", ""));
        return String(number).padStart(width, "0");
      }
      return number;
    })
    .replace(/\$Time\$/g, time);
}

function resolveUrl(relative, base) {
  try {
    return new URL(relative, base).href;
  } catch {
    return relative;
  }
}

// Parse ISO 8601 duration (PT1H2M3.4S)
function parseDuration(str) {
  const match = str.match(
    /PT(?:(\d+)H)?(?:(\d+)M)?(?:([0-9.]+)S)?/
  );
  if (!match) return 0;
  const h = parseInt(match[1]) || 0;
  const m = parseInt(match[2]) || 0;
  const s = parseFloat(match[3]) || 0;
  return h * 3600 + m * 60 + s;
}
