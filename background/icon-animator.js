// Manage extension icon state (active/inactive per tab)

const ACTIVE_COLOR = "#e74c3c";
const INACTIVE_COLOR = "#888888";

export function setActiveIcon(tabId, videoCount) {
  chrome.action.setBadgeText({
    text: videoCount > 0 ? String(videoCount) : "",
    tabId,
  });
  chrome.action.setBadgeBackgroundColor({
    color: ACTIVE_COLOR,
    tabId,
  });
}

export function setInactiveIcon(tabId) {
  chrome.action.setBadgeText({ text: "", tabId });
}
