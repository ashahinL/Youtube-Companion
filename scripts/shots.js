#!/usr/bin/env node
/**
 * Headless screenshots of the real popup for docs/screenshots,
 * store/images, and site/images. Serves the repo read-only, drives a
 * system Chromium, no extra packages.
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { renderIcon } from './draw-icon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export const DOCS_SHOTS = [
  { name: 'audio', scene: 'player', locale: 'en' },
  { name: 'feeds', scene: 'feeds', locale: 'en' },
  { name: 'groups', scene: 'groups', locale: 'en' },
  { name: 'watchlist', scene: 'watchlist', locale: 'en' },
  { name: 'sheet', scene: 'sheet', locale: 'en' },
  { name: 'settings', scene: 'settings', locale: 'en' },
  { name: 'feeds-ar', scene: 'feeds', locale: 'ar' },
  { name: 'support', scene: 'support', locale: 'en' },
];

export const STORE_SHOTS = [
  {
    name: 'screenshot-1-feeds',
    img: 'feeds.png',
    title: 'Every channel, one feed',
    sub: 'No account. New uploads from the channels you follow, newest first.',
    dir: 'ltr',
  },
  {
    name: 'screenshot-2-player',
    img: 'audio.png',
    title: 'Listen with less data',
    sub: 'Audio mode drops the video to 144p and covers it. About 8× less data than 720p.',
    dir: 'ltr',
  },
  {
    name: 'screenshot-3-groups',
    img: 'groups.png',
    title: 'Group your channels',
    sub: 'Tech, music, news — show one group at a time, in the feed and on the badge.',
    dir: 'ltr',
  },
  {
    name: 'screenshot-4-watchlist',
    img: 'watchlist.png',
    title: 'Add by link or @handle',
    sub: 'Or bring your subscriptions over from a Google Takeout file.',
    dir: 'ltr',
  },
  {
    name: 'screenshot-5-sheet',
    img: 'sheet.png',
    title: 'A channel at a glance',
    sub: 'Open any channel to see its latest videos without leaving the popup.',
    dir: 'ltr',
  },
  {
    name: 'screenshot-6-arabic',
    img: 'feeds-ar.png',
    title: 'بالعربية أيضًا',
    sub: 'واجهة كاملة من اليمين إلى اليسار.',
    dir: 'rtl',
  },
];

export const SITE_SHOTS = [
  { name: 'home-feeds', scene: 'feeds', locale: 'en' },
  { name: 'home-watchlist', scene: 'watchlist', locale: 'en' },
  { name: 'home-player', scene: 'player', locale: 'en' },
  { name: 'home-feeds-ar', scene: 'feeds', locale: 'ar' },
  { name: 'home-watchlist-ar', scene: 'watchlist', locale: 'ar' },
  { name: 'home-player-ar', scene: 'player', locale: 'ar' },
];

// The pictures on the What's new page. These ship inside the extension, so
// they are scale 1 and there are only three of them per language — and both
// languages, because an Arabic reader should not get English screenshots.
export const PAGE_SHOTS = [
  { name: 'page-player', file: 'player', scene: 'player', locale: 'en' },
  { name: 'page-feeds', file: 'feeds', scene: 'feeds', locale: 'en' },
  { name: 'page-watchlist', file: 'watchlist', scene: 'watchlist', locale: 'en' },
  { name: 'page-player-ar', file: 'player-ar', scene: 'player', locale: 'ar' },
  { name: 'page-feeds-ar', file: 'feeds-ar', scene: 'feeds', locale: 'ar' },
  { name: 'page-watchlist-ar', file: 'watchlist-ar', scene: 'watchlist', locale: 'ar' },
];

// A blank 1280×800 store frame compresses to tens of KB; a real one is
// hundreds. Half the median of this run is the cut.
export const STORE_FRAME_MIN_RATIO = 0.5;

function virtualPopup() {
  let html = fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8');
  const head = html.indexOf('<head>');
  if (head < 0) throw new Error('popup.html has no <head>');
  html = `${html.slice(0, head + 6)}\n    <base href="/src/popup/">${html.slice(head + 6)}`;
  const script = html.indexOf('<script');
  if (script < 0) throw new Error('popup.html has no <script');
  return `${html.slice(0, script)}<script src="/scripts/shots/stub.js"></script>\n    ${html.slice(script)}`;
}

/* Headless Chromium keeps a minimum window width wider than the popup, so
 * a 400px --window-size still lays out on a wider viewport. The sheets are
 * position: fixed and would stretch past the popup's edge, which a real
 * popup never does — Chrome sizes that window to the body. An iframe gives
 * the popup a viewport of exactly its own size. */
function framePage(query) {
  const src = `/__shots/popup.html?${query}`;
  return '<!doctype html><html><head><meta charset="utf-8"></head>'
    + '<body style="margin:0;overflow:hidden;background:#0f0f14">'
    + `<iframe src="${src.replace(/"/g, '&quot;')}" style="position:fixed;left:0;top:0;width:400px;height:600px;border:0"></iframe>`
    + '</body></html>';
}

function safeFile(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const rel = decoded.replace(/^\/+/, '');
  if (!rel) return null;
  const abs = path.resolve(ROOT, rel);
  const relative = path.relative(ROOT, abs);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return abs;
}

function startServer() {
  const popup = virtualPopup();
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405, { Allow: 'GET' });
      res.end();
      return;
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/__shots/popup.html') {
      const body = Buffer.from(popup);
      res.writeHead(200, {
        'Content-Type': TYPES['.html'],
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (url.pathname === '/__shots/frame.html') {
      const body = Buffer.from(framePage(url.searchParams.toString()));
      res.writeHead(200, {
        'Content-Type': TYPES['.html'],
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    const abs = safeFile(url.pathname);
    if (!abs) {
      res.writeHead(403);
      res.end();
      return;
    }
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      res.writeHead(404);
      res.end();
      return;
    }
    if (!stat.isFile()) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = TYPES[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    const body = fs.readFileSync(abs);
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body.length,
    });
    res.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function which(cmd) {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first && fs.existsSync(first) ? first : '';
  } catch {
    return '';
  }
}

function findBrowser() {
  const envPath = process.env.CHROME_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return envPath;
    throw new Error(`CHROME_PATH not found: ${envPath}`);
  }

  const files = [];
  if (process.platform === 'win32') {
    for (const root of [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean)) {
      files.push(
        path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(root, 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
        path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(root, 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe'),
        path.join(root, 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe'),
      );
    }
  } else if (process.platform === 'darwin') {
    files.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  }

  for (const file of files) {
    if (fs.existsSync(file)) return file;
  }

  for (const cmd of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']) {
    const found = which(cmd);
    if (found) return found;
  }

  throw new Error(
    'No Chromium browser found. Set CHROME_PATH to chrome.exe / msedge.exe, or install Chrome or Edge.',
  );
}

function pngSize(file) {
  const buf = fs.readFileSync(file);
  if (buf.length < 24 || buf[0] !== 0x89 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`${file} is not a PNG`);
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function assertPngSize(file, width, height) {
  const size = pngSize(file);
  if (size.width !== width || size.height !== height) {
    throw new Error(
      `${file} is ${size.width}×${size.height}, expected ${width}×${height}`,
    );
  }
  return size;
}

export function assertStoreFrameBytes(files, minRatio = STORE_FRAME_MIN_RATIO) {
  if (!Array.isArray(files) || files.length < 2) return;
  const rows = files.map((file) => {
    if (!fs.existsSync(file)) {
      throw new Error(`screenshot was not written: ${file}`);
    }
    return { file, bytes: fs.statSync(file).size };
  });
  const sorted = rows.map((row) => row.bytes).slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
  const floor = median * minRatio;
  for (const row of rows) {
    if (row.bytes < floor) {
      throw new Error(
        `${row.file} is ${row.bytes} bytes, far smaller than the other store frames (median ${Math.round(median)} bytes)`,
      );
    }
  }
}

function runChrome(browser, args) {
  return new Promise((resolve, reject) => {
    execFile(browser, args, { timeout: 60_000 }, (err, _stdout, stderr) => {
      if (err) {
        const extra = String(stderr || err.message).trim();
        reject(new Error(extra || err.message));
        return;
      }
      resolve();
    });
  });
}

async function capture(browser, url, outAbs, width, height, scale) {
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-shots-'));
  // Write into this run's temp dir so a leftover PNG at outAbs cannot pass.
  const tmpOut = path.join(profile, 'shot.png');
  try {
    await runChrome(browser, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      '--virtual-time-budget=8000',
      // Virtual time lands the player-card title marquee at whatever point 8s
      // of its loop reaches, which cut a word in half in the store frame.
      // Reduced motion holds every animation still and clamps the title to
      // two readable lines instead.
      '--force-prefers-reduced-motion',
      `--screenshot=${tmpOut}`,
      url,
    ]);
    if (!fs.existsSync(tmpOut)) {
      throw new Error(`screenshot was not written: ${outAbs}`);
    }
    assertPngSize(tmpOut, width * scale, height * scale);
    fs.copyFileSync(tmpOut, outAbs);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
  console.log(outAbs);
}

function storeUrl(port, shot) {
  const q = new URLSearchParams({
    img: shot.img,
    title: shot.title,
    sub: shot.sub,
    dir: shot.dir,
  });
  return `http://127.0.0.1:${port}/scripts/shots/store.html?${q}`;
}

function wanted(names, name) {
  return names.size === 0 || names.has(name);
}

async function run() {
  const names = new Set(process.argv.slice(2));
  const known = [
    ...DOCS_SHOTS.map((s) => s.name),
    ...STORE_SHOTS.map((s) => s.name),
    ...SITE_SHOTS.map((s) => s.name),
    ...PAGE_SHOTS.map((s) => s.name),
    'promo-440x280',
    'logo-300',
    'icon-192',
  ];
  for (const name of names) {
    if (!known.includes(name)) {
      throw new Error(`unknown shot '${name}'. Known: ${known.join(', ')}`);
    }
  }

  const { server, port } = await startServer();
  try {
    const browser = findBrowser();
    const origin = `http://127.0.0.1:${port}`;

    for (const shot of DOCS_SHOTS) {
      if (!wanted(names, shot.name)) continue;
      const out = path.join(ROOT, 'docs/screenshots', `${shot.name}.png`);
      const url = `${origin}/__shots/frame.html?scene=${encodeURIComponent(shot.scene)}&locale=${shot.locale}`;
      await capture(browser, url, out, 400, 600, 2);
    }

    for (const shot of SITE_SHOTS) {
      if (!wanted(names, shot.name)) continue;
      const out = path.join(ROOT, 'site/images', `${shot.name}.png`);
      const url = `${origin}/__shots/frame.html?scene=${encodeURIComponent(shot.scene)}&locale=${shot.locale}`;
      await capture(browser, url, out, 400, 600, 1);
    }

    for (const shot of PAGE_SHOTS) {
      if (!wanted(names, shot.name)) continue;
      const out = path.join(ROOT, 'src/whatsnew/img', `${shot.file}.png`);
      const url = `${origin}/__shots/frame.html?scene=${encodeURIComponent(shot.scene)}&locale=${shot.locale}`;
      await capture(browser, url, out, 400, 600, 1);
    }

    const storeOuts = [];
    for (const shot of STORE_SHOTS) {
      if (!wanted(names, shot.name)) continue;
      const out = path.join(ROOT, 'store/images', `${shot.name}.png`);
      await capture(browser, storeUrl(port, shot), out, 1280, 800, 1);
      storeOuts.push(out);
    }
    assertStoreFrameBytes(storeOuts);

    if (wanted(names, 'promo-440x280')) {
      const out = path.join(ROOT, 'store/images/promo-440x280.png');
      await capture(browser, `${origin}/scripts/shots/store.html?promo=1`, out, 440, 280, 1);
    }

    if (wanted(names, 'logo-300')) {
      const out = path.join(ROOT, 'store/images/logo-300.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, renderIcon(300));
      assertPngSize(out, 300, 300);
      console.log(out);
    }

    if (wanted(names, 'icon-192')) {
      const out = path.join(ROOT, 'site/images/icon-192.png');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, renderIcon(192));
      assertPngSize(out, 192, 192);
      console.log(out);
    }
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
