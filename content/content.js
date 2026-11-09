// Content script - runs in isolated world
// Injects page-inject.js into MAIN world and relays detected videos to background

(function () {
  // Inject the page-level interceptor
  const script = document.createElement("script");
  script.src = chrome.runtime.getURL("content/page-inject.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);

  // Listen for messages from the page-inject script
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || !event.data.__videoDownloadHelper) return;

    const { type, url, playerResponse } = event.data;

    // YouTube player response - send to background for parsing
    if (type === "youtube-player" && playerResponse) {
      chrome.runtime.sendMessage({
        action: "youtubePlayerResponse",
        playerResponse,
        pageTitle: document.title,
        pageUrl: location.href,
      });
      return;
    }

    if (!url) return;

    chrome.runtime.sendMessage({
      action: "streamDetected",
      type,
      url,
      pageTitle: document.title,
      pageUrl: location.href,
      frameUrl: location.href,
    });
  });

  // DOM-based video detection
  const VIDEO_EXTENSIONS = /\.(mp4|webm|ogg|mov|avi|mkv|flv|wmv|m4v|m3u8|mpd)(\?|#|$)/i;
  const detected = new Set();

  function reportVideo(url, type) {
    if (!url || detected.has(url) || url.startsWith("blob:")) return;
    detected.add(url);

    // Classify type from URL
    if (!type) {
      if (/\.m3u8(\?|#|$)/i.test(url)) type = "hls";
      else if (/\.mpd(\?|#|$)/i.test(url)) type = "dash";
      else type = "direct";
    }

    chrome.runtime.sendMessage({
      action: "streamDetected",
      type,
      url,
      pageTitle: document.title,
      pageUrl: location.href,
      frameUrl: location.href,
    });
  }

  function scanDOM() {
    // Video elements
    document.querySelectorAll("video").forEach((video) => {
      if (video.src && !video.src.startsWith("blob:")) reportVideo(video.src);
      if (video.currentSrc && !video.currentSrc.startsWith("blob:"))
        reportVideo(video.currentSrc);
      video.querySelectorAll("source").forEach((source) => {
        if (source.src) reportVideo(source.src);
      });
    });

    // Links to video files
    document.querySelectorAll("a[href]").forEach((a) => {
      if (VIDEO_EXTENSIONS.test(a.href)) reportVideo(a.href);
    });

    // Embedded objects
    document.querySelectorAll("embed[src], object[data]").forEach((el) => {
      const src = el.src || el.getAttribute("data");
      if (src && VIDEO_EXTENSIONS.test(src)) reportVideo(src);
    });

    // iframe srcs that might be video embeds
    document.querySelectorAll("iframe[src]").forEach((iframe) => {
      if (VIDEO_EXTENSIONS.test(iframe.src)) reportVideo(iframe.src);
    });
  }

  // Initial scan when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scanDOM);
  } else {
    scanDOM();
  }

  // Watch for dynamic changes
  const observer = new MutationObserver(() => scanDOM());
  const startObserver = () => {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        observer.observe(document.body, { childList: true, subtree: true });
      });
    }
  };
  startObserver();

  // Respond to popup requests
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "rescanPage") {
      scanDOM();
      sendResponse({ ok: true });
    }
    return true;
  });
})();
