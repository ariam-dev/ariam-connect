// Copyright (c) 2026 dta0one

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUpdateGate } from '../src/lib/update-gate.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Past the gate's later task.
function later() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

function createGate(on = false) {
  const state = { on, reloads: 0 };
  state.gate = createUpdateGate({
    isOn: () => state.on,
    reload: () => {
      state.reloads += 1;
    },
  });
  return state;
}

test('an update while off and idle reloads, in a later task', async () => {
  const state = createGate();
  state.gate.available();
  assert.equal(state.reloads, 0);
  await later();
  assert.equal(state.reloads, 1);
});

test('with no update pending nothing reloads', async () => {
  const state = createGate();
  await state.gate.serialize(async () => {});
  await state.gate.track(async () => {});
  await later();
  assert.equal(state.reloads, 0);
});

test('while on, the update waits for off', async () => {
  const state = createGate(true);
  state.gate.available();
  await later();
  assert.equal(state.reloads, 0);
  await state.gate.serialize(async () => {
    state.on = false;
  });
  await later();
  assert.equal(state.reloads, 1);
});

test('the update waits for a hand-off in flight', async () => {
  const state = createGate();
  const handOff = deferred();
  const tracked = state.gate.track(() => handOff.promise);
  state.gate.available();
  await later();
  assert.equal(state.reloads, 0);
  handOff.resolve(true);
  assert.equal(await tracked, true);
  await later();
  assert.equal(state.reloads, 1);
});

test('a failed hand-off settles too', async () => {
  const state = createGate();
  const handOff = deferred();
  const tracked = state.gate.track(() => handOff.promise);
  state.gate.available();
  handOff.reject(new Error('timeout'));
  await assert.rejects(tracked);
  await later();
  assert.equal(state.reloads, 1);
});

test('a hand-off still in flight after off holds the update', async () => {
  const state = createGate(true);
  const handOff = deferred();
  state.gate.track(() => handOff.promise);
  state.gate.available();
  await state.gate.serialize(async () => {
    state.on = false;
  });
  await later();
  assert.equal(state.reloads, 0);
  handOff.resolve(true);
  await later();
  assert.equal(state.reloads, 1);
});

test('the update waits for every queued message', async () => {
  const state = createGate();
  const first = deferred();
  const second = deferred();
  const runs = [state.gate.serialize(() => first.promise), state.gate.serialize(() => second.promise)];
  state.gate.available();
  first.resolve();
  await runs[0];
  await later();
  assert.equal(state.reloads, 0);
  second.resolve();
  await runs[1];
  await later();
  assert.equal(state.reloads, 1);
});

test('setup turning off does not reload before it saves', async () => {
  const state = createGate(true);
  const saved = deferred();
  state.gate.available();
  const setup = state.gate.serialize(async () => {
    state.on = false;
    await saved.promise;
  });
  await later();
  assert.equal(state.reloads, 0);
  saved.resolve();
  await setup;
  await later();
  assert.equal(state.reloads, 1);
});

test('tracked work started after a serialized turn-off holds the update until it settles', async () => {
  const state = createGate(true);
  const reply = deferred();
  state.gate.available();
  const setup = state.gate.track(async () => {
    await state.gate.serialize(async () => {
      state.on = false;
    });
    await reply.promise;
    return 'replied';
  });
  await later();
  assert.equal(state.on, false);
  assert.equal(state.reloads, 0);
  reply.resolve();
  assert.equal(await setup, 'replied');
  assert.equal(state.reloads, 0);
  await later();
  assert.equal(state.reloads, 1);
});

test('work arriving before the later task holds the update', async () => {
  const state = createGate();
  const unlock = deferred();
  state.gate.available();
  const queued = state.gate.serialize(async () => {
    await unlock.promise;
    state.on = true;
  });
  await later();
  assert.equal(state.reloads, 0);
  unlock.resolve();
  await queued;
  await later();
  assert.equal(state.reloads, 0);
  await state.gate.serialize(async () => {
    state.on = false;
  });
  await later();
  assert.equal(state.reloads, 1);
});

test('a pending update reloads once', async () => {
  const state = createGate();
  state.gate.available();
  await later();
  await state.gate.serialize(async () => {});
  await state.gate.track(async () => {});
  await later();
  assert.equal(state.reloads, 1);
});

test('queued messages run one at a time in arrival order, past a failure', async () => {
  const state = createGate();
  const order = [];
  const first = deferred();
  const runs = [
    state.gate.serialize(async () => {
      await first.promise;
      order.push(1);
    }),
    state.gate.serialize(async () => {
      order.push(2);
      throw new Error('failed');
    }),
    state.gate.serialize(async () => {
      order.push(3);
      return 'ok';
    }),
  ];
  await later();
  assert.deepEqual(order, []);
  first.resolve();
  await runs[0];
  await assert.rejects(runs[1]);
  assert.equal(await runs[2], 'ok');
  assert.deepEqual(order, [1, 2, 3]);
});
