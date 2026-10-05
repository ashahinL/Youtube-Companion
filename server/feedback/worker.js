/**
 * Accepts a short note from the public uninstall and feedback pages and
 * opens an issue in a private repository. The issue is the only record.
 * The caller's address is a rate-limit key and is not stored or forwarded.
 */

const PAGE_ORIGIN = 'https://ashahinl.github.io';

const BASE_HEADERS = {
  'Access-Control-Allow-Origin': PAGE_ORIGIN,
  'Vary': 'Origin',
  'Content-Type': 'application/json',
};

function reply(status, payload, extra) {
  return new Response(payload == null ? null : JSON.stringify(payload), {
    status,
    headers: extra ? { ...BASE_HEADERS, ...extra } : BASE_HEADERS,
  });
}

function invalid() {
  return reply(400, { ok: false, error: 'invalid' });
}

export default {
  fetch(request, env) {
    return handle(request, env);
  },
};

export async function handle(request, env, fetchImpl = fetch) {
  if (request.method === 'OPTIONS') {
    return reply(204, null, {
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
  }

  if (request.method !== 'POST') {
    return reply(405, { ok: false, error: 'invalid' });
  }

  // A browser sends Origin on this POST. A foreign page is rejected.
  // No Origin is not a page, and Turnstile still has to pass.
  const origin = request.headers.get('Origin');
  if (origin && origin !== PAGE_ORIGIN) {
    return reply(403, { ok: false, error: 'invalid' });
  }

  const raw = await request.text();
  if (raw.length > 8000) return invalid();

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!data || typeof data !== 'object') return invalid();

  const kind = data.kind;
  if (kind !== 'uninstall' && kind !== 'feedback') return invalid();

  const message = typeof data.text === 'string' ? data.text.trim() : '';
  if (message.length < 1 || message.length > 2000) return invalid();

  const lang = data.lang === 'ar' ? 'ar' : 'en';
  const version = typeof data.v === 'string' && /^\d+(\.\d+){0,3}$/.test(data.v) ? data.v : '';
  const token = data.token;
  if (typeof token !== 'string' || token.length === 0 || token.length >= 4096) return invalid();

  if (env.LIMITER) {
    const { success } = await env.LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'none' });
    if (!success) return reply(429, { ok: false, error: 'limited' });
  }

  const form = new URLSearchParams();
  form.set('secret', env.TURNSTILE_SECRET);
  form.set('response', token);

  let verify;
  try {
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    verify = await res.json();
  } catch {
    return reply(502, { ok: false, error: 'failed' });
  }
  if (!verify || verify.success !== true) {
    return reply(403, { ok: false, error: 'challenge' });
  }

  const line = message.split('\n')[0];
  const clipped = line.length > 60 ? `${line.slice(0, 60)}…` : line;
  const title = `${kind === 'uninstall' ? 'Uninstall: ' : 'Feedback: '}${clipped}`;
  const body = `${message}\n\nVersion: ${version || 'unknown'} · Language: ${lang}`;

  try {
    const res = await fetchImpl(`https://api.github.com/repos/${env.FEEDBACK_REPO}/issues`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'companion-feedback',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title, body }),
    });
    // Drain it so the worker can finish. The issue text is not kept here.
    await res.text();
    if (res.status !== 201) return reply(502, { ok: false, error: 'failed' });
  } catch {
    return reply(502, { ok: false, error: 'failed' });
  }

  return reply(200, { ok: true });
}
