// Copyright (c) 2026 dta0one

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPassphrase, open, seal } from '../src/lib/vault.js';

const SECRET = 'rpc-secret-for-tests';
const PASSPHRASE = 'amber river stone';

test('seal / open round trip', async () => {
  const record = await seal(SECRET, PASSPHRASE);
  assert.equal(await open(record, PASSPHRASE), SECRET);
});

test('a wrong passphrase rejects', async () => {
  const record = await seal(SECRET, PASSPHRASE);
  await assert.rejects(open(record, 'amber river slate'));
});

test('two seals of the same secret differ in salt, iv and ct', async () => {
  const [a, b] = await Promise.all([seal(SECRET, PASSPHRASE), seal(SECRET, PASSPHRASE)]);
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test('the record carries iterations: 600000', async () => {
  const record = await seal(SECRET, PASSPHRASE);
  assert.equal(record.v, 1);
  assert.equal(record.iterations, 600000);
  assert.equal(Buffer.from(record.salt, 'base64').length, 16);
  assert.equal(Buffer.from(record.iv, 'base64').length, 12);
});

test('isPassphrase accepts one, two or three words and rejects zero or four', () => {
  for (const text of ['amber', 'amber river', 'amber river stone', '  amber river  ']) {
    assert.equal(isPassphrase(text), true, text);
  }
  for (const text of ['', '   ', 'amber river stone moss', 'amber  river']) {
    assert.equal(isPassphrase(text), false, text);
  }
});
