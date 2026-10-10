/**
 * The product tour page in site/tour/. `node scripts/tour.js` serves site/
 * on http://127.0.0.1:8790/ and the stubbed popup under /tour/app/, read
 * straight from the repo. `node scripts/tour.js --build` writes that same
 * popup into site/tour/app/ for the Pages deploy.
 *
 * Runs on Node 20, the Pages runner, so it shares no code with
 * scripts/shots.js (which needs Node 22.2 for zlib.crc32).
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const PORT = 8790;

// Everything the popup and its two stubs load, relative to the repo root.
export const APP_FILES = [
  'src',
  '_locales',
  'icons',
  'manifest.json',
  'scripts/shots/stub.js',
  'scripts/shots/demo.js',
  'scripts/tour/stub-tour.js',
];

const STUBS = ['scripts/shots/stub.js', 'scripts/tour/stub-tour.js'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/**
 * popup.html with a relative <base>, so the same file works at
 * /tour/app/ locally and under /Youtube-Companion/tour/app/ on Pages, and
 * with the stubs ahead of the popup's first script.
 */
export function tourPopupHtml(html) {
  const head = html.indexOf('<head>');
  if (head < 0) throw new Error('popup.html has no <head>');
  html = `${html.slice(0, head + 6)}\n    <base href="src/popup/">${html.slice(head + 6)}`;
  const script = html.indexOf('<script');
  if (script < 0) throw new Error('popup.html has no <script');
  const tags = STUBS.map((rel) => `<script src="../../${rel}"></script>\n    `).join('');
  return `${html.slice(0, script)}${tags}${html.slice(script)}`;
}

function popupHtml() {
  return tourPopupHtml(fs.readFileSync(path.join(ROOT, 'src/popup/popup.html'), 'utf8'));
}

export function buildApp(dest = path.join(SITE, 'tour/app')) {
  fs.rmSync(dest, { recursive: true, force: true });
  for (const rel of APP_FILES) {
    fs.cpSync(path.join(ROOT, rel), path.join(dest, rel), { recursive: true });
  }
  fs.writeFileSync(path.join(dest, 'popup.html'), popupHtml());
  return dest;
}

// A path inside `base`, or null for anything that climbs out of it.
function inside(base, rel) {
  const abs = path.resolve(base, rel);
  const back = path.relative(base, abs);
  if (back.startsWith('..') || path.isAbsolute(back)) return null;
  return abs;
}

function resolveRequest(pathname) {
  if (pathname === '/tour/app/popup.html') return { body: Buffer.from(popupHtml()), type: TYPES['.html'] };
  if (pathname.startsWith('/tour/app/')) {
    const rel = pathname.slice('/tour/app/'.length);
    const listed = APP_FILES.some((entry) => rel === entry || rel.startsWith(`${entry}/`));
    return listed ? { file: inside(ROOT, rel) } : null;
  }
  let file = inside(SITE, `.${pathname}`);
  if (file && fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  return { file };
}

function serve() {
  const server = http.createServer((req, res) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://127.0.0.1').pathname);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    if (pathname === '/tour') {
      res.writeHead(301, { Location: '/tour/' });
      res.end();
      return;
    }
    const hit = resolveRequest(pathname);
    let body = hit?.body;
    if (!body && hit?.file && fs.existsSync(hit.file) && fs.statSync(hit.file).isFile()) {
      body = fs.readFileSync(hit.file);
    }
    if (!body) {
      res.writeHead(404);
      res.end();
      return;
    }
    const type = hit.type || TYPES[path.extname(hit.file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`tour: http://127.0.0.1:${PORT}/tour/`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--build')) console.log(`tour: wrote ${path.relative(ROOT, buildApp())}`);
  else serve();
}
