// Dynamically inject Referer headers for streaming CDN requests
// using declarativeNetRequest (since MV3 webRequest can't modify headers)

let ruleIdCounter = 1;
const activeRules = new Map(); // domain -> ruleId

/**
 * Add a Referer header rule for a streaming domain.
 * This ensures requests from the offscreen document to the CDN include the proper Referer.
 * @param {string} targetUrl - The URL being fetched (e.g., m3u8 or segment URL)
 * @param {string} referer - The Referer to set
 */
export async function addRefererRule(targetUrl, referer) {
  if (!targetUrl || !referer) return;

  try {
    const targetOrigin = new URL(targetUrl).origin;
    const key = targetOrigin;

    // Don't duplicate rules for the same domain
    if (activeRules.has(key)) return;

    const ruleId = ruleIdCounter++;

    const rule = {
      id: ruleId,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          {
            header: "Referer",
            operation: "set",
            value: referer,
          },
          {
            header: "Origin",
            operation: "set",
            value: new URL(referer).origin,
          },
        ],
      },
      condition: {
        urlFilter: targetOrigin + "/*",
        resourceTypes: [
          "xmlhttprequest",
          "media",
          "other",
        ],
      },
    };

    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: [rule],
      removeRuleIds: [],
    });

    activeRules.set(key, ruleId);
  } catch (err) {
    console.error("Failed to add referer rule:", err);
  }
}

/**
 * Remove a Referer rule for a domain.
 */
export async function removeRefererRule(targetUrl) {
  try {
    const targetOrigin = new URL(targetUrl).origin;
    const ruleId = activeRules.get(targetOrigin);
    if (ruleId) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [],
        removeRuleIds: [ruleId],
      });
      activeRules.delete(targetOrigin);
    }
  } catch {}
}

/**
 * Remove all dynamic rules.
 */
export async function clearAllRules() {
  try {
    const ruleIds = [...activeRules.values()];
    if (ruleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [],
        removeRuleIds: ruleIds,
      });
    }
    activeRules.clear();
  } catch {}
}
