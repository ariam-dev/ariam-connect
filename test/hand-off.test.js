// Copyright (c) 2026 dta0one

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcError } from '../src/lib/rpc.js';
import { createHandOff, linkFields, pageOrigin } from '../src/lib/hand-off.js';

const INSTANCE = 'https://ariam.example:6800';
const OTHER = 'https://aria2.example:6800';
const SECRET = 's3cret';
const URL_A = 'https://files.example/a.bin';
const COOKIE = '__Host-session=abc';
const REFERER = 'https://www.example/';
const SITE_HINT = 'https://www.example/';
const SUMMARY = { default: '0', ceiling: '5', sites: [] };

const NO_SUCH_METHOD = new RpcError('rpc', 'No such method: ariam.getSiteSummary', { code: 1, status: 400 });
const METHOD_NOT_FOUND = new RpcError('rpc', 'Method not found', { code: -32601, status: 404 });
const UNAUTHORIZED = new RpcError('rpc', 'Unauthorized', { code: 1, status: 400 });
const NETWORK = new RpcError('network', 'network error');
const TIMEOUT = new RpcError('timeout', 'no answer within 10 s');
const BAD_GATEWAY = new RpcError('http', 'HTTP 502', { status: 502 });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Runs pending Promise callbacks (setImmediate is never mocked here).
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// A stand-in for rpc.js's call. Each ariam check takes the next of `checks`;
// the last one repeats.
function fakeInstance(checks = [async () => SUMMARY], addUri = async () => '2089b05ecca3d829') {
  const calls = [];
  let checked = 0;
  function call(origin, key, method, params) {
    calls.push({ origin, key, method, params });
    if (method === 'aria2.addUri') return addUri();
    const answer = checks[Math.min(checked, checks.length - 1)];
    checked += 1;
    return answer();
  }
  return {
    call,
    checkCount: () => calls.filter((c) => c.method === 'ariam.getSiteSummary').length,
    addUris: () => calls.filter((c) => c.method === 'aria2.addUri'),
    headers: () => calls.filter((c) => c.method === 'aria2.addUri').map((c) => c.params[1].header),
  };
}

function fail(error) {
  return async () => {
    throw error;
  };
}

function same(error) {
  return (err) => err === error;
}

function cookieSource(value = COOKIE) {
  const source = () => {
    source.reads += 1;
    return value;
  };
  source.reads = 0;
  return source;
}

test('an instance confirmed as ariam gets the cookies', async () => {
  const instance = fakeInstance();
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await handOffs.send(handOffs.session(), URL_A, () => COOKIE, REFERER);
  const [addUri] = instance.addUris();
  assert.equal(addUri.origin, INSTANCE);
  assert.equal(addUri.key, SECRET);
  assert.deepEqual(addUri.params, [[URL_A], { header: [`Cookie: ${COOKIE}`, `Referer: ${REFERER}`] }]);
  assert.equal(instance.checkCount(), 1);
});

test('the check runs on turning on, before any hand-off', () => {
  const instance = fakeInstance();
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  assert.equal(instance.checkCount(), 1);
});

test('a cookie value from a Promise is sent', async () => {
  const instance = fakeInstance();
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await handOffs.send(handOffs.session(), URL_A, async () => COOKIE, '');
  assert.deepEqual(instance.headers(), [[`Cookie: ${COOKIE}`]]);
});

test('a hand-off during the turn-on check waits for it', async () => {
  const answer = deferred();
  const instance = fakeInstance([() => answer.promise]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  const sending = handOffs.send(handOffs.session(), URL_A, () => COOKIE, REFERER);
  await flush();
  assert.equal(instance.addUris().length, 0);
  answer.resolve(SUMMARY);
  await sending;
  assert.deepEqual(instance.headers(), [[`Cookie: ${COOKIE}`, `Referer: ${REFERER}`]]);
  assert.equal(instance.checkCount(), 1);
});

test('a method-not-found answer means not ariam: no cookies, and no further checks', async () => {
  for (const error of [NO_SUCH_METHOD, METHOD_NOT_FOUND]) {
    const instance = fakeInstance([async () => {
      throw error;
    }]);
    const handOffs = createHandOff(instance.call);
    handOffs.start(INSTANCE, SECRET);
    const cookie = cookieSource();
    await handOffs.send(handOffs.session(), URL_A, cookie, REFERER);
    await handOffs.send(handOffs.session(), URL_A, cookie, REFERER);
    assert.deepEqual(instance.headers(), [[`Referer: ${REFERER}`], [`Referer: ${REFERER}`]], error.message);
    assert.equal(cookie.reads, 0, error.message);
    assert.equal(instance.checkCount(), 1, error.message);
  }
});

test('an unknown answer rejects with the check\'s error and sends nothing; the next hand-off checks again', async () => {
  const instance = fakeInstance([
    fail(NETWORK), fail(TIMEOUT), fail(UNAUTHORIZED), fail(BAD_GATEWAY), async () => SUMMARY,
  ]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await flush();
  const cookie = cookieSource();
  for (const error of [TIMEOUT, UNAUTHORIZED, BAD_GATEWAY]) {
    await assert.rejects(handOffs.send(handOffs.session(), URL_A, cookie, REFERER), same(error), error.message);
  }
  assert.equal(cookie.reads, 0);
  assert.equal(instance.addUris().length, 0);
  await handOffs.send(handOffs.session(), URL_A, cookie, REFERER);
  assert.equal(cookie.reads, 1);
  assert.equal(instance.checkCount(), 5);
  assert.deepEqual(instance.headers(), [[`Cookie: ${COOKIE}`, `Referer: ${REFERER}`]]);
});

test('hand-offs waiting on a check that ends unknown reject with its error', async () => {
  const answer = deferred();
  const instance = fakeInstance([() => answer.promise]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  const cookie = cookieSource();
  const sending = [
    handOffs.send(handOffs.session(), URL_A, cookie, REFERER),
    handOffs.send(handOffs.session(), URL_A, cookie, REFERER),
  ];
  answer.reject(UNAUTHORIZED);
  for (const pending of sending) await assert.rejects(pending, same(UNAUTHORIZED));
  assert.equal(cookie.reads, 0);
  assert.equal(instance.addUris().length, 0);
  assert.equal(instance.checkCount(), 1);
});

test('without cookies or Referer the header option is empty', async () => {
  const instance = fakeInstance([async () => {
    throw NO_SUCH_METHOD;
  }]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await handOffs.send(handOffs.session(), URL_A, () => COOKIE, '');
  assert.deepEqual(instance.headers(), [[]]);
});

test('an instance confirmed as ariam gets the site hint', async () => {
  const instance = fakeInstance();
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await handOffs.send(handOffs.session(), URL_A, () => COOKIE, REFERER, SITE_HINT);
  const [addUri] = instance.addUris();
  assert.deepEqual(addUri.params, [
    [URL_A],
    { header: [`Cookie: ${COOKIE}`, `Referer: ${REFERER}`], 'site-hint': SITE_HINT },
  ]);
});

test('an instance that is not ariam gets the site hint and no cookies', async () => {
  const instance = fakeInstance([fail(NO_SUCH_METHOD)]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  const cookie = cookieSource();
  await handOffs.send(handOffs.session(), URL_A, cookie, REFERER, SITE_HINT);
  const [addUri] = instance.addUris();
  assert.deepEqual(addUri.params, [[URL_A], { header: [`Referer: ${REFERER}`], 'site-hint': SITE_HINT }]);
  assert.equal(cookie.reads, 0);
});

test('an empty site hint leaves no site-hint option', async () => {
  const instance = fakeInstance();
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await handOffs.send(handOffs.session(), URL_A, () => COOKIE, REFERER, '');
  const [addUri] = instance.addUris();
  assert.deepEqual(addUri.params, [[URL_A], { header: [`Cookie: ${COOKIE}`, `Referer: ${REFERER}`] }]);
});

test('a late answer from an earlier session does not authorize the current one', async () => {
  const earlier = deferred();
  const instance = fakeInstance([() => earlier.promise, fail(NETWORK)]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  handOffs.stop();
  handOffs.start(INSTANCE, SECRET);
  earlier.resolve(SUMMARY);
  await flush();
  const cookie = cookieSource();
  await assert.rejects(handOffs.send(handOffs.session(), URL_A, cookie, REFERER), same(NETWORK));
  assert.equal(cookie.reads, 0);
  assert.equal(instance.addUris().length, 0);
});

test('a late answer from an earlier instance does not authorize the current one', async () => {
  const earlier = deferred();
  const instance = fakeInstance([() => earlier.promise, async () => {
    throw NO_SUCH_METHOD;
  }]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  handOffs.stop();
  handOffs.start(OTHER, SECRET);
  await flush();
  earlier.resolve(SUMMARY);
  await flush();
  const cookie = cookieSource();
  await handOffs.send(handOffs.session(), URL_A, cookie, REFERER);
  assert.equal(cookie.reads, 0);
  assert.equal(instance.addUris()[0].origin, OTHER);
  assert.deepEqual(instance.headers(), [[`Referer: ${REFERER}`]]);
});

test('a confirmation does not carry over to the next session', async () => {
  const instance = fakeInstance([async () => SUMMARY, fail(NO_SUCH_METHOD)]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await flush();
  handOffs.stop();
  handOffs.start(INSTANCE, SECRET);
  const cookie = cookieSource();
  await handOffs.send(handOffs.session(), URL_A, cookie, REFERER);
  assert.equal(cookie.reads, 0);
  assert.deepEqual(instance.headers(), [[`Referer: ${REFERER}`]]);
});

test('a hand-off waiting on the check when turned off uses its own session\'s answer and instance', async () => {
  const answer = deferred();
  const instance = fakeInstance([() => answer.promise, fail(NO_SUCH_METHOD)]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  const cookie = cookieSource();
  const sending = handOffs.send(handOffs.session(), URL_A, cookie, REFERER);
  handOffs.stop();
  handOffs.start(OTHER, 'other');
  answer.resolve(SUMMARY);
  await sending;
  await handOffs.send(handOffs.session(), URL_A, cookie, REFERER);
  assert.equal(cookie.reads, 1);
  const [waited, next] = instance.addUris();
  assert.equal(waited.origin, INSTANCE);
  assert.equal(waited.key, SECRET);
  assert.deepEqual(waited.params[1].header, [`Cookie: ${COOKIE}`, `Referer: ${REFERER}`]);
  assert.equal(next.origin, OTHER);
  assert.deepEqual(next.params[1].header, [`Referer: ${REFERER}`]);
});

test('a hand-off waiting on the check when turned off rejects if that check ends unknown', async () => {
  const answer = deferred();
  const instance = fakeInstance([() => answer.promise]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  const cookie = cookieSource();
  const sending = handOffs.send(handOffs.session(), URL_A, cookie, REFERER);
  handOffs.stop();
  answer.reject(NETWORK);
  await assert.rejects(sending, same(NETWORK));
  assert.equal(cookie.reads, 0);
  assert.equal(instance.addUris().length, 0);
});

test('turning on needs no reachable instance', async () => {
  const instance = fakeInstance([async () => {
    throw NETWORK;
  }]);
  const handOffs = createHandOff(instance.call);
  assert.equal(handOffs.start(INSTANCE, SECRET), undefined);
  assert.notEqual(handOffs.session(), null);
  await flush();
});

test('turning on does not wait for the check', () => {
  const instance = fakeInstance([() => new Promise(() => {})]);
  const handOffs = createHandOff(instance.call);
  assert.equal(handOffs.start(INSTANCE, SECRET), undefined);
  assert.notEqual(handOffs.session(), null);
});

test('addUri errors reject the hand-off', async () => {
  const instance = fakeInstance(undefined, async () => {
    throw new RpcError('rpc', 'No URI to download.', { code: 1, status: 400 });
  });
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await assert.rejects(handOffs.send(handOffs.session(), URL_A, () => COOKIE, REFERER), { kind: 'rpc' });
});

test('a hand-off falls back at 10 s while the check hangs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const instance = fakeInstance([() => new Promise(() => {})]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  let settled = false;
  const sending = handOffs.send(handOffs.session(), URL_A, () => COOKIE, REFERER);
  sending.then(() => {}, () => {}).finally(() => {
    settled = true;
  });
  t.mock.timers.tick(9999);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(sending, { name: 'RpcError', kind: 'timeout' });
  assert.equal(instance.addUris().length, 0);
});

test('the check and addUri share the 10 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const answer = deferred();
  const instance = fakeInstance([() => answer.promise], () => new Promise(() => {}));
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  let settled = false;
  const sending = handOffs.send(handOffs.session(), URL_A, () => COOKIE, REFERER);
  sending.then(() => {}, () => {}).finally(() => {
    settled = true;
  });
  t.mock.timers.tick(9000);
  answer.resolve(SUMMARY);
  await flush();
  assert.deepEqual(instance.headers(), [[`Cookie: ${COOKIE}`, `Referer: ${REFERER}`]]);
  t.mock.timers.tick(999);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await assert.rejects(sending, { name: 'RpcError', kind: 'timeout' });
});

test('no addUri starts after the deadline, whatever the check answers then', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const late = [
    (answer) => answer.resolve(SUMMARY),
    (answer) => answer.reject(NO_SUCH_METHOD),
    (answer) => answer.reject(TIMEOUT),
  ];
  for (const settle of late) {
    const answer = deferred();
    const instance = fakeInstance([() => answer.promise]);
    const handOffs = createHandOff(instance.call);
    handOffs.start(INSTANCE, SECRET);
    const cookie = cookieSource();
    const sending = handOffs.send(handOffs.session(), URL_A, cookie, REFERER);
    t.mock.timers.tick(10000);
    settle(answer);
    await assert.rejects(sending, { name: 'RpcError', kind: 'timeout' });
    await flush();
    assert.equal(instance.addUris().length, 0);
    assert.equal(cookie.reads, 0);
  }
});

test('a re-check that times out with the deadline sends nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const instance = fakeInstance([
    fail(NETWORK),
    () => new Promise((resolve, reject) => {
      setTimeout(() => reject(TIMEOUT), 10000);
    }),
  ]);
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await flush();
  const sending = handOffs.send(handOffs.session(), URL_A, () => COOKIE, REFERER);
  t.mock.timers.tick(10000);
  await assert.rejects(sending, { name: 'RpcError', kind: 'timeout', message: 'no answer within 10 s' });
  await flush();
  assert.equal(instance.checkCount(), 2);
  assert.equal(instance.addUris().length, 0);
});

test('no addUri starts after the deadline while the cookies are read', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const instance = fakeInstance();
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await flush();
  const cookies = deferred();
  const sending = handOffs.send(handOffs.session(), URL_A, () => cookies.promise, REFERER);
  await flush();
  t.mock.timers.tick(10000);
  cookies.resolve(COOKIE);
  await assert.rejects(sending, { name: 'RpcError', kind: 'timeout' });
  await flush();
  assert.equal(instance.addUris().length, 0);
});

test('a confirmed instance that does not answer addUri falls back at 10 s', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const instance = fakeInstance(undefined, () => new Promise(() => {}));
  const handOffs = createHandOff(instance.call);
  handOffs.start(INSTANCE, SECRET);
  await flush();
  const sending = handOffs.send(handOffs.session(), URL_A, () => COOKIE, REFERER);
  t.mock.timers.tick(10000);
  await assert.rejects(sending, { name: 'RpcError', kind: 'timeout', message: 'no answer within 10 s' });
});

test('pageOrigin is the origin of an http: or https: URL', () => {
  assert.equal(pageOrigin('https://www.example/a/b?q=1#f'), 'https://www.example/');
  assert.equal(pageOrigin('http://h.example:8080/x'), 'http://h.example:8080/');
  assert.equal(pageOrigin('https://h.example:443/'), 'https://h.example/');
});

test('pageOrigin is empty for any other URL or text', () => {
  for (const text of ['file:///x', 'about:blank', 'moz-extension://abc/p.html', 'not a url', undefined]) {
    assert.equal(pageOrigin(text), '', String(text));
  }
});

test('linkFields sends the page origin as referer and site hint', () => {
  const cases = [
    ['https://www.example/page', 'https://files.example/a.bin', 'https://www.example/'],
    ['http://www.example/page', 'https://files.example/a.bin', 'http://www.example/'],
    ['http://www.example/page', 'http://files.example/a.bin', 'http://www.example/'],
  ];
  for (const [pageUrl, linkUrl, origin] of cases) {
    assert.deepEqual(linkFields(pageUrl, linkUrl), { referer: origin, siteHint: origin }, `${pageUrl} → ${linkUrl}`);
  }
});

test('linkFields sends no referer from an https: page to an http: link', () => {
  assert.deepEqual(
    linkFields('https://www.example/page', 'http://files.example/a.bin'),
    { referer: '', siteHint: 'https://www.example/' },
  );
});

test('linkFields sends neither from a page without an http: or https: origin', () => {
  assert.deepEqual(linkFields('about:blank', 'https://files.example/a.bin'), { referer: '', siteHint: '' });
});
