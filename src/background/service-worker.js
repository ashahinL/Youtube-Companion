/**
 * Background service worker.
 *
 * Owns all network, alarms, notifications and the badge. The popup never
 * fetches — it asks this file and renders what comes back.
 */

chrome.runtime.onInstalled.addListener(() => {});
