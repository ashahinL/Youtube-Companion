/**
 * UI theme for the extension pages. settings.ui.theme is the source of
 * truth; a localStorage mirror only lets the classic boot script paint
 * before the settings load, so the page never flashes the wrong theme.
 */

export const THEME_STORAGE_KEY = 'companion.theme';

const THEMES = new Set(['system', 'light', 'dark']);

export function normalizeTheme(value) {
  return THEMES.has(value) ? value : 'system';
}

/**
 * Pin `light` | `dark` onto documentElement, or clear the attribute so the
 * OS decides under 'system'. Refreshes the boot script's mirror on the way.
 */
export function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  const forced = normalized === 'system' ? '' : normalized;
  if (typeof document !== 'undefined' && document.documentElement) {
    if (forced) document.documentElement.dataset.theme = forced;
    else delete document.documentElement.dataset.theme;
  }
  try {
    if (forced) localStorage.setItem(THEME_STORAGE_KEY, forced);
    else localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage may be unavailable; settings carry the choice regardless.
  }
  return normalized;
}
