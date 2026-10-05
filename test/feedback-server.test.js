/**
 * The feedback worker: CORS, the note checks, Turnstile, and the private issue.
 * fetch is faked per test. Nothing here talks to the network.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker, { handle } from '../server/feedback/worker.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = 'https://ashahinl.github.io';
const ENDPOINT = 'https://feedback.ammarshahin.dev/';
const IP = '198.51.100.23';

const ENV = {
  TURNSTILE_SECRET: 'turnstile-secret',
  GITHUB_TOKEN: 'github-token',
  FEEDBACK_REPO: 'ashahinL/companion-feedback',
};

function mockFetch(reply) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: init.body == null ? '' : String(init.body),
    };
    calls.push(call);
    return reply(call);
  };
  return { impl, calls };
}

function routed({ verify = { success: true }, githubStatus = 201, throwOn = '' } = {}) {
  return mockFetch(async (call) => {
    if (throwOn && call.url.includes(throwOn)) throw new Error('network');
    if (call.url.includes('siteverify')) {
      return new Response(JSON.stringify(verify), { status: 200 });
    }
    if (call.url.startsWith('https://api.github.com/')) {
      return new Response('{}', { status: githubStatus });
    }
    throw new Error(`unexpected ${call.url}`);
  });
}

function post(body, headers = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { Origin: PAGE, 'Content-Type': 'application/json', 'CF-Connecting-IP': IP, ...headers },
    body: raw,
  });
}

const note = (extra = {}) => ({ kind: 'uninstall', text: 'The feed was late', lang: 'en', v: '2.1.0', token: 'turnstile-token', ...extra });

export default async function run(t) {
  t.section('the worker');

  const source = fs.readFileSync(path.join(ROOT, 'server/feedback/worker.js'), 'utf8');
  t.check('it does not log the request', !/\bconsole\./.test(source));

  const opt = await handle(new Request(ENDPOINT, { method: 'OPTIONS' }), {});
  t.check('OPTIONS is 204', opt.status === 204);
  t.check('OPTIONS allows this page', opt.headers.get('Access-Control-Allow-Origin') === PAGE);
  t.check('OPTIONS varies on Origin', opt.headers.get('Vary') === 'Origin');
  t.check('OPTIONS is JSON', opt.headers.get('Content-Type') === 'application/json');
  t.check('OPTIONS allows POST', opt.headers.get('Access-Control-Allow-Methods') === 'POST');
  t.check('OPTIONS allows Content-Type', opt.headers.get('Access-Control-Allow-Headers') === 'Content-Type');
  t.check('OPTIONS caches the preflight for a day', opt.headers.get('Access-Control-Max-Age') === '86400');
  t.check('OPTIONS has no body', (await opt.text()) === '');

  const get = await worker.fetch(new Request(ENDPOINT, { method: 'GET' }), {});
  const getBody = await get.json();
  t.check('GET is 405', get.status === 405 && getBody.ok === false && getBody.error === 'invalid');

  const foreign = await handle(new Request(ENDPOINT, { method: 'POST', headers: { Origin: 'https://example.com' }, body: '{}' }), ENV);
  const foreignBody = await foreign.json();
  t.check('a foreign Origin is 403', foreign.status === 403 && foreignBody.error === 'invalid');

  const bad = [
    ['bad JSON', '{'],
    ['bad kind', note({ kind: 'nope' })],
    ['empty text', note({ text: '   ' })],
    ['text over 2000', note({ text: 'a'.repeat(2001) })],
    ['missing token', note({ token: '' })],
  ];
  for (const [label, body] of bad) {
    const fake = routed();
    const res = await handle(post(body), ENV, fake.impl);
    const data = await res.json();
    t.check(`${label} is 400 and does not fetch`, res.status === 400 && data.error === 'invalid' && fake.calls.length === 0, JSON.stringify({ status: res.status, data, calls: fake.calls.length }));
  }

  const huge = routed();
  const hugeRes = await handle(post('x'.repeat(9000)), ENV, huge.impl);
  const hugeBody = await hugeRes.json();
  t.check('a 9000-character body is 400', hugeRes.status === 400 && hugeBody.error === 'invalid' && huge.calls.length === 0);

  let limitedKey = '';
  const limited = routed();
  const limitedEnv = {
    ...ENV,
    LIMITER: { async limit({ key }) { limitedKey = key; return { success: false }; } },
  };
  const limitedRes = await handle(post(note()), limitedEnv, limited.impl);
  const limitedBody = await limitedRes.json();
  t.check('a refused limiter is 429 and does not fetch', limitedRes.status === 429 && limitedBody.error === 'limited' && limited.calls.length === 0, String(limitedRes.status));
  t.check('the limiter key is the address', limitedKey === IP, limitedKey);

  const denied = routed({ verify: { success: false } });
  const deniedRes = await handle(post(note()), ENV, denied.impl);
  const deniedBody = await deniedRes.json();
  t.check(
    'a failed challenge is 403 and does not call GitHub',
    deniedRes.status === 403 && deniedBody.error === 'challenge' && denied.calls.length === 1 && denied.calls[0].url.includes('siteverify'),
    JSON.stringify(denied.calls.map((c) => c.url)),
  );

  const line = 'a'.repeat(80);
  const message = `${line}\nand a second line`;
  let seenKey = '';
  const happy = routed();
  const happyEnv = {
    ...ENV,
    LIMITER: { async limit({ key }) { seenKey = key; return { success: true }; } },
  };
  const happyRes = await handle(post(note({ text: message })), happyEnv, happy.impl);
  const happyBody = await happyRes.json();
  t.check('a good note is 200', happyRes.status === 200 && happyBody.ok === true, JSON.stringify(happyBody));
  t.check('the page may read the answer', happyRes.headers.get('Access-Control-Allow-Origin') === PAGE);

  const verifyCall = happy.calls[0];
  const issueCall = happy.calls[1];
  t.check('one siteverify call', happy.calls.length === 2 && verifyCall.url === 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  t.check(
    'siteverify sends the secret and the token and no address',
    verifyCall.body.includes('secret=turnstile-secret')
      && verifyCall.body.includes('response=turnstile-token')
      && !verifyCall.body.includes('remoteip'),
    verifyCall.body,
  );
  t.check(
    'GitHub is the private feedback repo',
    issueCall.url === 'https://api.github.com/repos/ashahinL/companion-feedback/issues'
      && issueCall.headers.Authorization === 'Bearer github-token'
      && issueCall.headers.Accept === 'application/vnd.github+json'
      && issueCall.headers['User-Agent'] === 'companion-feedback'
      && issueCall.headers['X-GitHub-Api-Version'] === '2022-11-28',
    issueCall.url,
  );
  const issue = JSON.parse(issueCall.body);
  t.check('the title starts with Uninstall and clips the first line', issue.title === `Uninstall: ${'a'.repeat(60)}…`, issue.title);
  t.check('the issue has no labels', issue.labels === undefined);
  t.check(
    'the body keeps the note and the version line',
    issue.body === `${message}\n\nVersion: 2.1.0 · Language: en`,
    issue.body,
  );
  t.check('the limiter saw the address', seenKey === IP);
  t.check('the address is not on any outgoing fetch', !JSON.stringify(happy.calls).includes(IP));

  const down = routed({ githubStatus: 500 });
  const downRes = await handle(post(note()), ENV, down.impl);
  const downBody = await downRes.json();
  t.check('GitHub 500 is 502', downRes.status === 502 && downBody.error === 'failed');

  const dropped = routed();
  const droppedRes = await handle(post(note({ kind: 'feedback', text: 'Hello there', lang: 'fr', v: 'beta' })), ENV, dropped.impl);
  t.check('a bad language and version still send', droppedRes.status === 200);
  const droppedIssue = JSON.parse(dropped.calls[1].body);
  t.check('a feedback title is marked Feedback', droppedIssue.title === 'Feedback: Hello there', droppedIssue.title);
  t.check(
    'a bad language and version become en and unknown',
    droppedIssue.body.endsWith('Version: unknown · Language: en'),
    droppedIssue.body,
  );

  const thrown = routed({ throwOn: 'siteverify' });
  const thrownRes = await handle(post(note()), ENV, thrown.impl);
  const thrownBody = await thrownRes.json();
  t.check('a thrown check is 502', thrownRes.status === 502 && thrownBody.error === 'failed' && thrown.calls.length === 1);
}
