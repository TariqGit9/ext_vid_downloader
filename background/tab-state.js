// Per-tab state management for detected videos
// Persists to chrome.storage.session so it survives service worker restarts

const tabVideos = new Map(); // tabId -> Map<url, videoInfo>
let loaded = false;
let loadPromise = null;

const STORAGE_KEY = "tabVideos";

async function ensureLoaded() {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const data = await chrome.storage.session.get(STORAGE_KEY);
      const stored = data[STORAGE_KEY];
      if (stored) {
        for (const [tabId, videos] of Object.entries(stored)) {
          const map = new Map();
          for (const v of videos) map.set(v.url, v);
          tabVideos.set(parseInt(tabId), map);
        }
      }
    } catch {}
    loaded = true;
  })();
  return loadPromise;
}

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(persist, 200);
}

async function persist() {
  saveTimer = null;
  try {
    const obj = {};
    for (const [tabId, map] of tabVideos.entries()) {
      obj[tabId] = [...map.values()];
    }
    await chrome.storage.session.set({ [STORAGE_KEY]: obj });
  } catch {}
}

// Synchronous accessors that auto-load on first miss
ensureLoaded();

export function addVideo(tabId, videoInfo) {
  if (!tabVideos.has(tabId)) {
    tabVideos.set(tabId, new Map());
  }
  const tab = tabVideos.get(tabId);

  if (tab.has(videoInfo.url)) {
    const existing = tab.get(videoInfo.url);
    tab.set(videoInfo.url, { ...existing, ...videoInfo, id: existing.id });
    scheduleSave();
    return existing.id;
  }

  const id = crypto.randomUUID();
  videoInfo.id = id;
  videoInfo.detectedAt = Date.now();
  tab.set(videoInfo.url, videoInfo);
  scheduleSave();
  return id;
}

export function getVideos(tabId) {
  if (!tabVideos.has(tabId)) return [];
  return [...tabVideos.get(tabId).values()];
}

export function getVideoByUrl(tabId, url) {
  if (!tabVideos.has(tabId)) return null;
  return tabVideos.get(tabId).get(url) || null;
}

export function getVideoCount(tabId) {
  if (!tabVideos.has(tabId)) return 0;
  return tabVideos.get(tabId).size;
}

export function clearTab(tabId) {
  tabVideos.delete(tabId);
  scheduleSave();
}

export function updateVideo(tabId, url, updates) {
  if (!tabVideos.has(tabId)) return;
  const tab = tabVideos.get(tabId);
  if (tab.has(url)) {
    const existing = tab.get(url);
    tab.set(url, { ...existing, ...updates });
    scheduleSave();
  }
}

export async function waitLoaded() {
  await ensureLoaded();
}
