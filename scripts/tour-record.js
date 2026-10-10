/**
 * Records the tour page to dist/tour.mp4 and dist/tour.srt.
 * Chrome draws /tour/?record=1. The page clock moves one frame at a
 * time, so the same tour becomes the same pictures.
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './tour.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist');
const MP4 = path.join(OUT_DIR, 'tour.mp4');
const SRT = path.join(OUT_DIR, 'tour.srt');

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const FRAME_MS = 1000 / FPS;
const HOLD_FRAMES = FPS;
const TOUR_LIMIT_FRAMES = 6 * 60 * FPS;
const ESTIMATE = 5600;

// The page starts playing as soon as it loads. Freeze its clock before
// thumbnail fetches eat the opening title card. drive() again later is a no-op.
const ARM_CLOCK = `(() => {
  if (location.pathname !== '/tour/' && location.pathname !== '/tour/index.html') return;
  const arm = () => {
    if (window.__tour?.clock?.drive) window.__tour.clock.drive();
    else requestAnimationFrame(arm);
  };
  arm();
})();`;

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

function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('screenshot is not a jpeg');
  let i = 2;
  while (i + 8 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc2) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  throw new Error('jpeg size not found');
}

function stamp(frame) {
  const ms = Math.round((frame * 1000) / FPS);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(milli, 3)}`;
}

function shortTime(frames) {
  const s = Math.floor(frames / FPS);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('DevTools socket failed')));
  });
}

function cdp(ws) {
  let next = 1;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result || {});
    } else {
      for (const fn of listeners) fn(msg);
    }
  });
  return {
    send(method, params = {}, sessionId) {
      const id = next++;
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify(payload));
      });
    },
    on(fn) {
      listeners.add(fn);
    },
  };
}

function waitForDevtools(child) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('Chrome did not open a DevTools port')), 20000);
    const onData = (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (!m) return;
      clearTimeout(timer);
      resolve(m[1]);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited before DevTools was ready (${code}): ${buf.trim()}`));
    });
  });
}

function killChild(child) {
  if (!child || child.exitCode != null || child.signalCode) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode == null && !child.signalCode) child.kill('SIGKILL');
    }, 2000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function evalIn(send, sessionId, expression, awaitPromise = false) {
  const result = await send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.text || result.exceptionDetails.exception?.description || 'page error';
    throw new Error(text);
  }
  return result.result?.value;
}

function cueText(now) {
  if (!now?.caption) return '';
  return now.title ? `${now.title}\n${now.caption}` : now.caption;
}

function writeSrt(cues, frames) {
  const lines = [];
  let n = 1;
  for (const cue of cues) {
    const end = cue.end ?? frames;
    if (end <= cue.start) continue;
    lines.push(String(n));
    lines.push(`${stamp(cue.start)} --> ${stamp(end)}`);
    lines.push(cue.text);
    lines.push('');
    n += 1;
  }
  fs.writeFileSync(SRT, lines.join('\n'), 'utf8');
  return n - 1;
}

async function main() {
  if (!which('ffmpeg')) {
    console.error('Install ffmpeg: brew install ffmpeg');
    process.exitCode = 1;
    return;
  }

  const browser = findBrowser();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-tour-'));
  const { server, port } = await startServer(0);

  let chrome = null;
  let ff = null;
  let ffErr = '';
  let stopped = false;

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (ff && ff.exitCode == null && !ff.stdin.destroyed) {
      try {
        ff.stdin.destroy();
      } catch {
        // already closed
      }
    }
    await killChild(chrome);
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(profile, { recursive: true, force: true });
  };

  process.once('SIGINT', () => {
    stop().finally(() => process.exit(130));
  });

  try {
    chrome = spawn(browser, [
      '--headless=new',
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--window-size=${WIDTH},${HEIGHT}`,
      '--hide-scrollbars',
      '--mute-audio',
      '--force-device-scale-factor=1',
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    const wsUrl = await waitForDevtools(chrome);
    const ws = await openSocket(wsUrl);
    const dev = cdp(ws);

    const { targetInfos } = await dev.send('Target.getTargets');
    let targetId = targetInfos.find((t) => t.type === 'page')?.targetId;
    if (!targetId) targetId = (await dev.send('Target.createTarget', { url: 'about:blank' })).targetId;
    const { sessionId } = await dev.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => dev.send(method, params, sessionId);

    const pending = new Set();
    let loaded = false;
    dev.on((msg) => {
      if (msg.sessionId && msg.sessionId !== sessionId) return;
      if (msg.method === 'Network.requestWillBeSent') pending.add(msg.params.requestId);
      else if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') pending.delete(msg.params.requestId);
      else if (msg.method === 'Page.loadEventFired') loaded = true;
    });

    await send('Page.enable');
    await send('Page.setLifecycleEventsEnabled', { enabled: true });
    await send('Network.enable');
    await send('Page.bringToFront');
    try {
      await send('Emulation.setFocusEmulationEnabled', { enabled: true });
    } catch {
      // older Chrome builds omit this; animation frames still run in headless
    }
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: ARM_CLOCK });
    await send('Page.navigate', { url: `http://127.0.0.1:${port}/tour/?record=1` });

    const deadline = Date.now() + 60000;
    let quietSince = 0;
    while (Date.now() < deadline) {
      const stage = await evalIn(send, sessionId, '!!document.querySelector(".stage")');
      const quiet = loaded && stage && pending.size === 0;
      if (quiet) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= 500) break;
      } else quietSince = 0;
      await sleep(50);
    }
    if (!loaded || pending.size > 0) throw new Error('the tour page did not finish loading');

    await evalIn(send, sessionId, 'window.__tour.clock.drive()');
    const ready = await evalIn(send, sessionId, 'typeof window.__tour.now === "function" && !!document.querySelector(".stage")');
    if (!ready) throw new Error('the tour page did not start');

    ff = spawn('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'image2pipe',
      '-framerate', String(FPS),
      '-i', '-',
      // JPEG frames are full-range BT.601; players expect limited-range BT.709.
      '-vf', 'scale=out_range=tv:out_color_matrix=bt709,format=yuv420p',
      '-color_range', 'tv',
      '-colorspace', 'bt709',
      '-color_primaries', 'bt709',
      '-color_trc', 'bt709',
      '-c:v', 'libx264',
      '-preset', 'slow',
      '-crf', '18',
      '-movflags', '+faststart',
      MP4,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    ff.stderr.on('data', (chunk) => {
      ffErr = `${ffErr}${chunk}`.slice(-4000);
    });
    const ffDone = new Promise((resolve, reject) => {
      ff.once('error', reject);
      ff.once('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${ffErr.trim()}`))));
    });

    const cues = [];
    let open = null;
    let frames = 0;
    let held = 0;
    const started = Date.now();

    const note = (now) => {
      const text = cueText(now);
      if (open && open.text === text) return;
      if (open?.text) cues.push({ ...open, end: frames });
      open = text ? { start: frames, text } : null;
    };

    while (held <= HOLD_FRAMES) {
      await evalIn(send, sessionId, `window.__tour.clock.advance(${FRAME_MS})`);
      // Two animation frames, then keep waiting while the popup iframe is
      // still loading on real time. Stepping the tour clock through that
      // wait would add frames and push the file past its length.
      const state = await evalIn(send, sessionId, `new Promise((resolve) => {
        let paints = 0;
        let stopped = false;
        const start = performance.now();
        const finish = () => {
          if (stopped) return;
          stopped = true;
          resolve({ done: window.__tourDone === true, now: window.__tour.now() });
        };
        const tick = () => {
          if (stopped) return;
          const tour = window.__tour;
          const waiting = tour.clock.timers.length + tour.clock.tweens.length > 0;
          const done = window.__tourDone === true || tour.player.phase === 'done';
          if ((paints >= 2 && (waiting || done)) || performance.now() - start > 12000) {
            finish();
            return;
          }
          requestAnimationFrame(() => { paints += 1; });
          setTimeout(tick, 16);
        };
        tick();
      })`, true);

      const shot = await send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 92,
        optimizeForSpeed: true,
      });
      const jpeg = Buffer.from(shot.data, 'base64');
      if (frames === 0) {
        const size = jpegSize(jpeg);
        if (size.width !== WIDTH || size.height !== HEIGHT) {
          throw new Error(`frame is ${size.width}×${size.height}, expected ${WIDTH}×${HEIGHT}`);
        }
      }
      if (!ff.stdin.write(jpeg)) {
        await Promise.race([new Promise((resolve) => ff.stdin.once('drain', resolve)), ffDone]);
      }
      note(state.now);
      frames += 1;
      if (frames % 300 === 0) console.log(`frame ${frames} / ~${ESTIMATE}, ${shortTime(frames)}`);

      if (state.done) held += 1;
      else if (frames >= TOUR_LIMIT_FRAMES) throw new Error('the tour did not finish within 6 minutes');
      if (state.done && held > HOLD_FRAMES) break;
    }

    if (open?.text) cues.push({ ...open, end: frames });
    const cueCount = writeSrt(cues, frames);
    ff.stdin.end();
    await ffDone;
    ff = null;

    const secs = Math.round((Date.now() - started) / 1000);
    console.log(`tour: ${shortTime(frames)}, ${frames} frames, ${cueCount} cues, took ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
    console.log(MP4);
    console.log(SRT);
  } catch (err) {
    if (ff && ff.exitCode == null) {
      try {
        ff.stdin.destroy();
      } catch {
        // already closed
      }
      await killChild(ff);
    }
    console.error(err.message || err);
    process.exitCode = 1;
  } finally {
    await stop();
  }
}

main();
