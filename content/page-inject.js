// Runs in the MAIN page world to intercept fetch/XHR and detect video streams
(function () {
  if (window.__videoDownloadHelperInjected) return;
  window.__videoDownloadHelperInjected = true;

  const detected = new Set();
  const isYouTube = location.hostname.includes("youtube.com");

  function report(data) {
    window.postMessage({ __videoDownloadHelper: true, ...data }, "*");
  }

  function classifyUrl(url) {
    if (!url || typeof url !== "string") return null;
    try {
      const fullUrl = new URL(url, location.href).href;
      if (detected.has(fullUrl)) return null;

      if (/\.m3u8(\?|#|$)/i.test(fullUrl)) {
        detected.add(fullUrl);
        return { type: "hls", url: fullUrl };
      }
      if (/\.mpd(\?|#|$)/i.test(fullUrl)) {
        detected.add(fullUrl);
        return { type: "dash", url: fullUrl };
      }
      if (/\.(mp4|webm|ogg|mov|avi|mkv|flv|m4v)(\?|#|$)/i.test(fullUrl)) {
        detected.add(fullUrl);
        return { type: "direct", url: fullUrl };
      }
      if (/\/manifest\(/i.test(fullUrl) || /format=mpd/i.test(fullUrl)) {
        detected.add(fullUrl);
        return { type: "dash", url: fullUrl };
      }
      // YouTube videoplayback URLs
      if (/googlevideo\.com\/videoplayback/i.test(fullUrl)) {
        detected.add(fullUrl);
        return { type: "youtube-stream", url: fullUrl };
      }
    } catch {}
    return null;
  }

  function checkAndReport(url) {
    const result = classifyUrl(url);
    if (result) report(result);
  }

  function checkContentType(ct, url) {
    if (!ct || !url || detected.has(url)) return;
    if (ct.includes("mpegurl") || ct.includes("vnd.apple") || ct.includes("x-mpegurl")) {
      detected.add(url);
      report({ type: "hls", url });
    } else if (ct.includes("dash+xml")) {
      detected.add(url);
      report({ type: "dash", url });
    }
  }

  // --- YouTube-specific: Extract player response ---
  function extractYouTubePlayerResponse(data) {
    try {
      let parsed = typeof data === "string" ? JSON.parse(data) : data;

      // The /youtubei/v1/player response has streamingData at top level
      // The page-embedded ytInitialPlayerResponse also has it at top level
      if (parsed && parsed.streamingData) {
        report({
          type: "youtube-player",
          playerResponse: JSON.stringify(parsed),
        });
        return;
      }

      // Sometimes nested inside other response structures
      if (parsed?.playerResponse) {
        const inner = typeof parsed.playerResponse === "string"
          ? JSON.parse(parsed.playerResponse)
          : parsed.playerResponse;
        if (inner?.streamingData) {
          report({
            type: "youtube-player",
            playerResponse: JSON.stringify(inner),
          });
        }
      }
    } catch {}
  }

  // Intercept fetch
  const origFetch = window.fetch;
  window.fetch = function (...args) {
    try {
      const input = args[0];
      const url = typeof input === "string" ? input : input?.url;
      checkAndReport(url);
    } catch {}

    const result = origFetch.apply(this, args);
    result
      .then((response) => {
        try {
          const ct = response.headers.get("content-type") || "";
          const respUrl =
            response.url ||
            (typeof args[0] === "string" ? args[0] : args[0]?.url);
          checkContentType(ct, respUrl);

          // YouTube: intercept player API response
          if (
            isYouTube &&
            respUrl &&
            (respUrl.includes("/youtubei/v1/player") ||
              respUrl.includes("/youtubei/v1/next"))
          ) {
            // Clone response so original consumer still works
            response
              .clone()
              .json()
              .then((data) => extractYouTubePlayerResponse(data))
              .catch(() => {});
          }
        } catch {}
        return response;
      })
      .catch(() => {});
    return result;
  };

  // Intercept XHR
  const origOpen = XMLHttpRequest.prototype.open;
  const xhrUrls = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const urlStr = typeof url === "string" ? url : url?.toString();
    checkAndReport(urlStr);
    xhrUrls.set(this, urlStr);
    return origOpen.call(this, method, url, ...rest);
  };

  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", function () {
      try {
        const ct = this.getResponseHeader("content-type") || "";
        checkContentType(ct, this.responseURL);

        // YouTube: intercept player API XHR response
        const reqUrl = xhrUrls.get(this) || this.responseURL || "";
        if (
          isYouTube &&
          (reqUrl.includes("/youtubei/v1/player") ||
            reqUrl.includes("/get_video_info") ||
            reqUrl.includes("player_ias"))
        ) {
          extractYouTubePlayerResponse(this.responseText);
        }
      } catch {}
    });
    return origSend.apply(this, args);
  };

  // Intercept video source assignment
  const videoSrcDesc = Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "src"
  );
  if (videoSrcDesc && videoSrcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, "src", {
      set(value) {
        checkAndReport(value);
        return videoSrcDesc.set.call(this, value);
      },
      get() {
        return videoSrcDesc.get.call(this);
      },
    });
  }

  const sourceSrcDesc = Object.getOwnPropertyDescriptor(
    HTMLSourceElement.prototype,
    "src"
  );
  if (sourceSrcDesc && sourceSrcDesc.set) {
    Object.defineProperty(HTMLSourceElement.prototype, "src", {
      set(value) {
        checkAndReport(value);
        return sourceSrcDesc.set.call(this, value);
      },
      get() {
        return sourceSrcDesc.get.call(this);
      },
    });
  }

  // Intercept URL.createObjectURL to track MediaSource blob URLs
  const origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const blobUrl = origCreateObjectURL.call(this, obj);
    if (obj instanceof MediaSource) {
      report({ type: "blob-mediasource", url: blobUrl });
    }
    return blobUrl;
  };

  // --- YouTube: Extract ytInitialPlayerResponse from page source ---
  if (isYouTube) {
    // Try to grab the player response that's already embedded in the page
    const extractFromPage = () => {
      try {
        if (window.ytInitialPlayerResponse) {
          extractYouTubePlayerResponse(window.ytInitialPlayerResponse);
        }
      } catch {}

      // Also try parsing from script tags
      try {
        const scripts = document.querySelectorAll("script");
        for (const script of scripts) {
          const text = script.textContent;
          if (!text) continue;

          // ytInitialPlayerResponse = {...}
          const match = text.match(
            /ytInitialPlayerResponse\s*=\s*(\{.+?\});/s
          );
          if (match) {
            extractYouTubePlayerResponse(match[1]);
            break;
          }

          // var ytInitialPlayerResponse = {...}
          const match2 = text.match(
            /var\s+ytInitialPlayerResponse\s*=\s*(\{.+?\});/s
          );
          if (match2) {
            extractYouTubePlayerResponse(match2[1]);
            break;
          }
        }
      } catch {}
    };

    // Run when DOM is ready
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", extractFromPage);
    } else {
      // Small delay to let YouTube's scripts set the variable
      setTimeout(extractFromPage, 1000);
    }

    // YouTube is an SPA — watch for navigation via yt-navigate-finish
    document.addEventListener("yt-navigate-finish", () => {
      // Reset detection for new video
      detected.clear();
      setTimeout(extractFromPage, 1500);
    });
  }
})();
