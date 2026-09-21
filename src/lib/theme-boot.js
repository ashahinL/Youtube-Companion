/**
 * Theme boot. A classic script that runs before the stylesheet, so the page
 * paints with the stored theme instead of flashing the OS one. Module
 * scripts are deferred, so this cannot be a module and cannot import: the
 * storage key mirrors THEME_STORAGE_KEY in ../lib/theme.js, and the
 * settings in chrome.storage stay the source of truth once the page loads.
 */
(function () {
  try {
    var theme = localStorage.getItem('companion.theme');
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.dataset.theme = theme;
    } else {
      delete document.documentElement.dataset.theme;
    }
  } catch (err) {
    // Storage may be unavailable; the page then follows the OS until settings load.
  }
})();
