// Intercept network requests to detect video streams

const STREAM_URL_PATTERNS = /\.(m3u8|mpd)(\?|#|$)/i;
const DIRECT_VIDEO_PATTERNS = /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v)(\?|#|$)/i;
const YOUTUBE_VIDEOPLAYBACK = /googlevideo\.com\/videoplayback/i;

const STREAM_CONTENT_TYPES = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "application/dash+xml",
];

const VIDEO_CONTENT_TYPES = [
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/x-flv",
  "video/quicktime",
  "video/x-msvideo",
  "video/x-matroska",
];

export function setupNetworkInterceptor(onVideoDetected) {
  // Intercept by URL pattern (catches streams even when content-type is wrong)
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const url = details.url;

      if (STREAM_URL_PATTERNS.test(url)) {
        const type = /\.m3u8/i.test(url) ? "hls" : "dash";
        onVideoDetected(details.tabId, {
          url,
          type,
          source: "network-url",
        });
      } else if (YOUTUBE_VIDEOPLAYBACK.test(url)) {
        onVideoDetected(details.tabId, {
          url,
          type: "youtube-stream",
          source: "network-url",
        });
      } else if (DIRECT_VIDEO_PATTERNS.test(url)) {
        onVideoDetected(details.tabId, {
          url,
          type: "direct",
          source: "network-url",
        });
      }
    },
    { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] }
  );

  // Intercept by content type (catches streams served with proper headers)
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (details.tabId < 0) return;

      const contentTypeHeader = details.responseHeaders?.find(
        (h) => h.name.toLowerCase() === "content-type"
      );
      if (!contentTypeHeader) return;

      const ct = contentTypeHeader.value.toLowerCase();

      // Check for stream content types
      if (STREAM_CONTENT_TYPES.some((t) => ct.includes(t))) {
        const type = ct.includes("dash") ? "dash" : "hls";
        onVideoDetected(details.tabId, {
          url: details.url,
          type,
          source: "network-header",
        });
        return;
      }

      // Check for direct video content types
      if (VIDEO_CONTENT_TYPES.some((t) => ct.includes(t))) {
        // Get content length for size estimation
        const clHeader = details.responseHeaders?.find(
          (h) => h.name.toLowerCase() === "content-length"
        );
        const size = clHeader ? parseInt(clHeader.value) : null;

        onVideoDetected(details.tabId, {
          url: details.url,
          type: "direct",
          size,
          source: "network-header",
        });
      }
    },
    { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other"] },
    ["responseHeaders"]
  );
}
