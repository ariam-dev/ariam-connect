// Copyright (c) 2026 dta0one
//
// Holds an AMO update back while ariam connect is on. With a
// runtime.onUpdateAvailable listener registered, Firefox applies an update
// only when the add-on reloads or Firefox restarts, and a reload drops the
// in-memory secret (turns ariam connect off). A pending update is applied when
// all hold: off, no tracked work in flight (a hand-off, or a message up to its
// reply), and no state-changing message queued (setup turns off before it
// seals and saves).

export function createUpdateGate({ isOn, reload }) {
  let pending = false;
  let busy = 0;
  let scheduled = false;
  let queue = Promise.resolve();

  function ready() {
    return pending && busy === 0 && !isOn();
  }

  // Reloads in a later task, so what settled tracked work resolves to (a
  // hand-off's {cancel: true}, a message's reply) goes out first. A reply is
  // covered only if its message is tracked until the reply: serialize tracks a
  // message that is all serialized; one with work after its serialized part is
  // tracked whole.
  function check() {
    if (scheduled || !ready()) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (!ready()) return;
      pending = false;
      reload();
    }, 0);
  }

  async function track(task) {
    busy += 1;
    try {
      return await task();
    } finally {
      busy -= 1;
      check();
    }
  }

  return {
    available() {
      pending = true;
      check();
    },
    track,
    // State-changing messages run one at a time in arrival order, so a later
    // reset can't be undone by an earlier operation that finishes after it.
    serialize(task) {
      const run = track(() => queue.then(task));
      queue = run.catch(() => {});
      return run;
    },
  };
}
