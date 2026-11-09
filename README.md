# Video DownloadHelper

A Chrome extension that detects and downloads videos from virtually any website, including HLS and DASH streams.

![Chrome Extension](https://img.shields.io/badge/Platform-Chrome-4285F4?logo=googlechrome&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-green)
![License](https://img.shields.io/badge/License-MIT-blue)

## Features

- **Auto-detection** -- Automatically detects videos playing on any webpage
- **HLS streaming support** -- Downloads `.m3u8` streams by fetching and merging all segments
- **DASH streaming support** -- Parses `.mpd` manifests and downloads segmented streams
- **YouTube detection** -- Extracts available qualities from YouTube's player API
- **Quality selection** -- Shows all available qualities as individual download buttons
- **Download progress** -- Real-time progress bar with segment count and bytes downloaded
- **AES-128 decryption** -- Handles encrypted HLS streams (non-DRM)
- **Referer injection** -- Automatically sets correct headers for protected CDNs
- **Network interception** -- Catches video URLs from both DOM and network requests
- **Page-level hooks** -- Intercepts `fetch`, `XMLHttpRequest`, and `MediaSource` to detect streams invisible to the DOM

## Installation

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (toggle in top-right corner)
4. Click **Load unpacked**
5. Select the `ext_vid_download` folder

The extension icon will appear in your toolbar.

## Usage

1. Navigate to any page with a video
2. Play the video (this triggers stream detection on most sites)
3. Click the extension icon -- detected videos appear with quality options
4. Click a quality button to download
5. Switch to the **Downloads** tab to track progress

## How It Works

```
Page loads
  │
  ├── content.js injects page-inject.js into the page's JS context
  │     └── Hooks fetch(), XHR, video.src, MediaSource.createObjectURL
  │
  ├── network-interceptor.js monitors webRequest events
  │     └── Catches .m3u8, .mpd, .mp4, .webm by URL pattern and content-type
  │
  └── Detected URLs sent to background.js
        │
        ├── metadata-resolver.js fetches manifests and parses quality variants
        ├── Tab badge updates with detected video count
        │
        └── On download click:
              ├── Direct files → chrome.downloads API
              └── HLS/DASH → offscreen.js fetches all segments,
                              merges into single file, saves to Downloads
```

## Project Structure

```
ext_vid_download/
├── manifest.json              # Extension config (Manifest V3)
├── background/
│   ├── background.js          # Service worker entry point
│   ├── network-interceptor.js # webRequest listener for video URLs
│   ├── tab-state.js           # Per-tab detected video storage
│   ├── metadata-resolver.js   # Fetches and parses stream manifests
│   ├── download-manager.js    # Manages downloads and progress tracking
│   ├── referer-injector.js    # declarativeNetRequest header rules
│   └── icon-animator.js       # Badge count management
├── content/
│   ├── content.js             # DOM scanner and message relay
│   └── page-inject.js         # MAIN world hooks (fetch/XHR/MediaSource)
├── lib/
│   ├── m3u8-parser.js         # HLS manifest parser
│   ├── mpd-parser.js          # DASH MPD XML parser
│   ├── youtube-parser.js      # YouTube player response parser
│   └── utils.js               # Formatting and filename utilities
├── offscreen/
│   ├── offscreen.html         # Offscreen document (survives SW kills)
│   └── offscreen.js           # Segment downloader and merger
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.js               # Popup logic and rendering
│   └── popup.css              # Dark theme styles
└── icons/                     # Extension icons (16/48/128px)
```

## Supported Sites

| Site | Detection | Download |
|------|-----------|----------|
| HLS streams (Twitter, Reddit, Vimeo, news sites) | Yes | Yes |
| DASH streams (Facebook, Instagram) | Yes | Yes |
| Direct video files (.mp4, .webm) | Yes | Yes |
| YouTube | Yes (qualities detected) | Partial (non-signature URLs only) |
| DRM-protected content (Netflix, Disney+) | Detected | No (blocked by DRM) |

## Limitations

- **DRM content** -- Widevine/PlayReady protected streams cannot be downloaded
- **YouTube signatures** -- Many YouTube streams require signature decryption which is not implemented; only progressive formats (360p/720p) with direct URLs are downloadable
- **Audio/video muxing** -- DASH streams with separate audio and video are downloaded as video-only; audio muxing requires ffmpeg post-processing
- **Large files** -- Very long streams (2+ hours) may consume significant memory during segment merging

## Technical Details

- **Manifest V3** -- Uses the latest Chrome extension architecture
- **ES Modules** -- Background service worker uses native ES module imports
- **Offscreen API** -- Long-running downloads happen in an offscreen document to avoid service worker timeout (30s limit)
- **declarativeNetRequest** -- Dynamically injects Referer/Origin headers for CDNs that require them
- **Zero dependencies** -- No external libraries; HLS/DASH parsers are built from scratch

## License

MIT
