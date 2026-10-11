// Copyright (c) 2026 dta0one

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedCall } from '../src/lib/relay.js';

const GID = '2089b05ecca3d829';
const KEYS = ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'name', 'site', 'errorCode'];

// The queue view's poll, as transport.multicall sends it.
const POLL = [
  { methodName: 'aria2.tellActive', params: [KEYS] },
  { methodName: 'aria2.tellWaiting', params: [0, 200, KEYS] },
  { methodName: 'aria2.tellStopped', params: [-1, 200, KEYS] },
  { methodName: 'aria2.getGlobalStat', params: [] },
  { methodName: 'ariam.getSiteSummary', params: [] },
];

test('each allowlisted method is accepted', () => {
  const calls = [
    ['aria2.tellActive', [KEYS]],
    ['aria2.tellWaiting', [0, 200, KEYS]],
    ['aria2.tellStopped', [-1, 200, KEYS]],
    ['aria2.tellStatus', [GID]],
    ['aria2.getGlobalStat', []],
    ['ariam.getSiteSummary', []],
    ['aria2.pause', [GID]],
    ['aria2.unpause', [GID]],
    ['aria2.remove', [GID]],
    ['aria2.purgeDownloadResult', []],
    ['aria2.changeGlobalOption', [{ 'site-concurrent': 'a.example:2,b.example:1' }]],
    ['aria2.changeGlobalOption', [{ 'site-concurrent-default': '3' }]],
    ['aria2.changeGlobalOption', [{ 'site-concurrent': 'a.example:2', 'site-concurrent-default': '0' }]],
    ['aria2.changeGlobalOption', [{}]],
    ['system.multicall', [POLL]],
    ['system.multicall', [[{ methodName: 'aria2.getGlobalStat' }]]],
  ];
  for (const [method, params] of calls) {
    assert.equal(allowedCall(method, params), true, `${method} ${JSON.stringify(params)}`);
  }
});

test('calls outside the allowlist are rejected', () => {
  const calls = [
    ['aria2.addUri', [['https://files.example/a.bin'], {}]],
    ['aria2.getOption', [GID]],
    ['system.listMethods', []],
    ['aria2.getVersion', []],
    ['aria2.forceRemove', [GID]],
    ['aria2.changeOption', [GID, { 'site-concurrent': 'a.example:1' }]],
    ['aria2.changeGlobalOption', [{ 'max-concurrent-downloads': '9' }]],
    ['aria2.changeGlobalOption', [{ 'site-concurrent': 'a.example:1', dir: '/tmp' }]],
    ['aria2.changeGlobalOption', [{ 'site-concurrent-default': '2', 'rpc-secret': 'x' }]],
    ['aria2.changeGlobalOption', []],
    ['aria2.changeGlobalOption', ['site-concurrent=a.example:1']],
    ['aria2.changeGlobalOption', [[{ 'site-concurrent': 'a.example:1' }]]],
    ['aria2.tellActive', 'not a list'],
    ['aria2.tellActive', undefined],
    [undefined, []],
  ];
  for (const [method, params] of calls) {
    assert.equal(allowedCall(method, params), false, `${method} ${JSON.stringify(params)}`);
  }
});

test('a multicall containing one rejected sub-call is rejected', () => {
  const rejected = [
    { methodName: 'aria2.addUri', params: [['https://files.example/a.bin']] },
    { methodName: 'aria2.getOption', params: [GID] },
    { methodName: 'system.listMethods', params: [] },
    { methodName: 'aria2.changeGlobalOption', params: [{ 'max-concurrent-downloads': '9' }] },
    { methodName: 'system.multicall', params: [POLL] },
  ];
  for (const sub of rejected) {
    assert.equal(allowedCall('system.multicall', [[...POLL, sub]]), false, sub.methodName);
  }
});

test('a multicall without one list of sub-calls is rejected', () => {
  assert.equal(allowedCall('system.multicall', []), false);
  assert.equal(allowedCall('system.multicall', [POLL, POLL]), false);
  assert.equal(allowedCall('system.multicall', [{ methodName: 'aria2.getGlobalStat' }]), false);
  assert.equal(allowedCall('system.multicall', [['aria2.getGlobalStat']]), false);
  assert.equal(allowedCall('system.multicall', [[{ methodName: 'aria2.getGlobalStat', params: 'x' }]]), false);
});
