// Copyright (c) 2026 dta0one

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { call, multicall } from '../src/lib/rpc.js';

const INSTANCE = 'https://ariam.example:6800';
const SECRET = 's3cret';
const TOKEN = `token:${SECRET}`;

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function stubFetch(t, respond = () => jsonResponse({ jsonrpc: '2.0', id: 1, result: 'OK' })) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return respond(url, init);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

test('an ordinary call carries the token first', async (t) => {
  const requests = stubFetch(t);
  assert.equal(await call(INSTANCE, SECRET, 'aria2.tellStatus', ['2089b05ecca3d829']), 'OK');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `${INSTANCE}/jsonrpc`);
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].body.method, 'aria2.tellStatus');
  assert.deepEqual(requests[0].body.params, [TOKEN, '2089b05ecca3d829']);
});

test('system.multicall carries no outer token, and every sub-call does', async (t) => {
  const requests = stubFetch(t);
  await multicall(INSTANCE, SECRET, [
    { methodName: 'aria2.getGlobalStat', params: [] },
    { methodName: 'aria2.tellActive', params: [['gid', 'status']] },
    { methodName: 'ariam.getSiteSummary' },
  ]);
  const { body } = requests[0];
  assert.equal(body.method, 'system.multicall');
  assert.equal(body.params.length, 1);
  assert.deepEqual(body.params[0], [
    { methodName: 'aria2.getGlobalStat', params: [TOKEN] },
    { methodName: 'aria2.tellActive', params: [TOKEN, ['gid', 'status']] },
    { methodName: 'ariam.getSiteSummary', params: [TOKEN] },
  ]);
});

test("requests are made with redirect: 'error'", async (t) => {
  const requests = stubFetch(t);
  await call(INSTANCE, SECRET, 'aria2.getVersion');
  await multicall(INSTANCE, SECRET, [{ methodName: 'aria2.getVersion', params: [] }]);
  assert.equal(requests.length, 2);
  for (const request of requests) assert.equal(request.init.redirect, 'error');
});

test('an abort after 10 s gives kind timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  stubFetch(t, (url, init) => new Promise((resolve, reject) => {
    signal = init.signal;
    signal.addEventListener('abort', () => reject(signal.reason));
  }));
  const pending = call(INSTANCE, SECRET, 'aria2.getVersion');
  t.mock.timers.tick(9999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(signal.aborted, true);
  await assert.rejects(pending, { name: 'RpcError', kind: 'timeout' });
});

test('errors carry kind, message, code and status', async (t) => {
  let respond;
  stubFetch(t, () => respond());
  respond = () => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: 1, message: 'Unauthorized' } }, 400);
  await assert.rejects(call(INSTANCE, SECRET, 'aria2.getVersion'), {
    kind: 'rpc', message: 'Unauthorized', code: 1, status: 400,
  });
  respond = () => new Response('', { status: 502 });
  await assert.rejects(call(INSTANCE, SECRET, 'aria2.getVersion'), { kind: 'http', message: 'HTTP 502', status: 502 });
  respond = () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(call(INSTANCE, SECRET, 'aria2.getVersion'), { kind: 'network' });
});
