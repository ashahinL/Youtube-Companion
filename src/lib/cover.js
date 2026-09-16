/**
 * Audio-mode overlay cover: a local JPEG data URL on its own storage key,
 * not inside settings, so settings writes stay small and backups never
 * carry the picture. Pure helpers for size, JPEG quality, and the one-time
 * move off the old settings.audio.imageUrl field.
 */

export const AUDIO_COVER_KEY = 'audioCover';
export const COVER_MAX_INPUT_BYTES = 10 * 1024 * 1024;
export const COVER_MAX_STORED_BYTES = 600 * 1024;
export const COVER_MAX_SIDE = 1280;
export const COVER_JPEG_QUALITY = 0.82;
export const COVER_JPEG_QUALITY_STEP = 0.08;
export const COVER_JPEG_QUALITY_MIN = 0.5;

export function isCoverDataUrl(value) {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (!v) return false;
  if (/["\\\r\n]/.test(v)) return false;
  return /^data:image\//i.test(v);
}

/**
 * Scale so the longer side is at most COVER_MAX_SIDE. Tiny or missing
 * dimensions become 1×1 so a canvas still has a drawable box.
 */
export function coverOutputSize(width, height) {
  const w = Math.max(0, Number(width) || 0);
  const h = Math.max(0, Number(height) || 0);
  const long = Math.max(w, h);
  if (!(long > COVER_MAX_SIDE)) {
    return { width: Math.max(1, Math.round(w) || 1), height: Math.max(1, Math.round(h) || 1) };
  }
  const scale = COVER_MAX_SIDE / long;
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

/**
 * Next JPEG quality after encoding at `quality` produced `bytes`.
 * `null` means this blob is small enough to keep; `false` means stop.
 */
export function nextCoverJpegQuality(quality, bytes) {
  if (!(Number(bytes) > COVER_MAX_STORED_BYTES)) return null;
  const q = Number(quality);
  if (!Number.isFinite(q)) return false;
  const next = Math.round((q - COVER_JPEG_QUALITY_STEP) * 100) / 100;
  if (next < COVER_JPEG_QUALITY_MIN) return false;
  if (!(next < q)) return false;
  return next;
}

/**
 * 1.x stored a pasted URL on settings.audio.imageUrl. An https one made
 * the YouTube page fetch a third-party host; those are dropped. A data
 * URL moves once onto audioCover and is then stripped from settings.
 */
export function planAudioCoverMigration(rawSettings, existingCover) {
  const audio = rawSettings && typeof rawSettings === 'object' ? rawSettings.audio : null;
  const hasImageUrl = !!(audio && typeof audio === 'object' && Object.prototype.hasOwnProperty.call(audio, 'imageUrl'));
  const imageUrl = hasImageUrl && typeof audio.imageUrl === 'string' ? audio.imageUrl.trim() : '';
  const haveCover = isCoverDataUrl(existingCover);
  const fromSettings = isCoverDataUrl(imageUrl) ? imageUrl : '';
  return {
    cover: haveCover ? existingCover.trim() : fromSettings,
    writeCover: !haveCover && !!fromSettings,
    stripImageUrl: hasImageUrl,
  };
}
