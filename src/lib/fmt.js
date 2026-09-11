/**
 * Locale-aware display helpers: relative time, duration, compact counts,
 * and short timestamps. Pure — no chrome, no DOM, no network.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function asLocale(locale) {
  return locale || 'en';
}

function isAr(locale) {
  return String(locale || '').toLowerCase().startsWith('ar');
}

/**
 * Largest unit that fits. Minutes and hours use the narrow form ("2h ago")
 * so a row stays short; days and up stay long ("3 days ago").
 */
function unitFor(absSec) {
  if (absSec < HOUR) return ['minute', MINUTE];
  if (absSec < DAY) return ['hour', HOUR];
  if (absSec < WEEK) return ['day', DAY];
  if (absSec < MONTH) return ['week', WEEK];
  if (absSec < YEAR) return ['month', MONTH];
  return ['year', YEAR];
}

export function relativeTime(then, now = Date.now(), locale = 'en') {
  const t = Number(then);
  const n = Number(now);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return '';

  const diffMs = t - n;
  const absMs = Math.abs(diffMs);
  if (absMs < 60_000) return isAr(locale) ? 'الآن' : 'just now';

  const diffSec = diffMs / 1000;
  const absSec = Math.abs(diffSec);
  const [unit, unitSec] = unitFor(absSec);
  const sign = diffSec < 0 ? -1 : 1;
  const value = sign * Math.round(absSec / unitSec);
  const style = unit === 'minute' || unit === 'hour' ? 'narrow' : 'long';

  try {
    return new Intl.RelativeTimeFormat(asLocale(locale), {
      numeric: 'always',
      style,
    }).format(value, unit);
  } catch {
    return '';
  }
}

export function duration(seconds) {
  const s = Math.floor(Number(seconds));
  if (!Number.isFinite(s) || s <= 0) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const ss = String(sec).padStart(2, '0');
  if (h) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}

export function compactCount(n, locale = 'en') {
  const x = Number(n);
  if (!Number.isFinite(x)) return '';
  try {
    return new Intl.NumberFormat(asLocale(locale), {
      notation: 'compact',
      compactDisplay: 'short',
      maximumFractionDigits: 1,
    }).format(x);
  } catch {
    return '';
  }
}

export function absoluteTime(ms, locale = 'en') {
  const x = Number(ms);
  if (!Number.isFinite(x)) return '';
  const d = new Date(x);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return new Intl.DateTimeFormat(asLocale(locale), {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(d);
  } catch {
    return '';
  }
}
