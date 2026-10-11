// Copyright (c) 2026 dta0one
//
// Tabs created that haven't been let through a document response yet. When
// such a tab's page load is a download ariam accepts, the tab is left empty
// (a tab opened only for the download), so the background closes it.

export function createFreshTabs() {
  const fresh = new Set();
  return {
    created(tab) {
      fresh.add(tab.id);
    },
    // A main_frame response the tab will show: not a redirect hop and not a
    // download being handed to ariam.
    responded(details, captured) {
      const redirect = details.statusCode >= 300 && details.statusCode <= 399;
      if (details.type === 'main_frame' && !redirect && !captured) fresh.delete(details.tabId);
    },
    loaded(tabId) {
      fresh.delete(tabId);
    },
    removed(tabId) {
      fresh.delete(tabId);
    },
    take(tabId) {
      return fresh.delete(tabId);
    },
    clear() {
      fresh.clear();
    },
  };
}
