// Copyright (c) 2026 dta0one
//
// The passphrase goes to the background, which opens the vault; this page never
// holds the secret.

import { mount, TransportError } from './vendor/queue-view.js';

const views = {
  setup: document.getElementById('setup'),
  unlock: document.getElementById('unlock'),
  on: document.getElementById('on'),
};
const passphrase = document.getElementById('passphrase');
const result = document.getElementById('unlock-result');
const turnOnButton = views.unlock.querySelector('button');
const offButton = document.getElementById('off');
const confirmPanel = document.getElementById('confirm');
const confirmMessage = document.getElementById('confirm-message');
const failure = document.createElement('p');
failure.className = 'view';
failure.textContent = 'Something went wrong.';
failure.hidden = true;
views.setup.after(failure);

browser.runtime.getPlatformInfo().then((info) => {
  document.documentElement.classList.toggle('android', info.os === 'android');
}, () => {});

async function send(message) {
  try {
    const reply = await browser.runtime.sendMessage(message);
    return reply && typeof reply === 'object' ? reply : { error: 'failed' };
  } catch {
    return { error: 'failed' };
  }
}

const KINDS = new Set(['network', 'rpc', 'http']);

// A relay timeout is no answer, so the view shows it as network.
function transportError(shape) {
  const kind = shape.kind === 'timeout' || !KINDS.has(shape.kind) ? 'network' : shape.kind;
  const message = typeof shape.message === 'string' ? shape.message : 'network error';
  return new TransportError(kind, message, { status: shape.status, code: shape.code });
}

// The background answers 'off' when it was turned off while the queue showed.
function isOff(shape) {
  return shape.kind === 'rpc' && shape.message === 'off' && shape.code === undefined;
}

async function relay(message) {
  let reply;
  try {
    reply = await browser.runtime.sendMessage(message);
  } catch {
    throw new TransportError('network', 'network error');
  }
  if (!reply || typeof reply !== 'object') throw new TransportError('network', 'network error');
  if (reply.error !== undefined) {
    const shape = reply.error && typeof reply.error === 'object' ? reply.error : {};
    if (isOff(shape)) render();
    throw transportError(shape);
  }
  return reply.result;
}

const transport = {
  call(method, params) {
    return relay({ type: 'rpc', method, params: Array.isArray(params) ? params : [] });
  },
  multicall(calls) {
    return relay({ type: 'multicall', calls: calls.map((c) => ({ methodName: c.methodName, params: c.params })) });
  },
};

let pendingConfirm = null;

function settleConfirm(answer) {
  const resolve = pendingConfirm;
  pendingConfirm = null;
  if (confirmPanel.open) confirmPanel.close();
  if (resolve) resolve(answer);
}

function confirmCancel(message) {
  settleConfirm(false);
  confirmMessage.textContent = message;
  return new Promise((resolve) => {
    pendingConfirm = resolve;
    confirmPanel.showModal();
    document.getElementById('confirm-keep').focus();
  });
}

document.getElementById('confirm-cancel').addEventListener('click', () => settleConfirm(true));
document.getElementById('confirm-keep').addEventListener('click', () => settleConfirm(false));
// Escape closes the panel: keep the download.
confirmPanel.addEventListener('close', () => {
  if (!confirmPanel.open) settleConfirm(false);
});

let unmountQueue = null;

function showQueue() {
  if (unmountQueue === null) unmountQueue = mount(views.on, transport, {
    confirm: confirmCancel,
    unauthorizedMessage: 'Not authorized — open settings and run Setup with ariam’s RPC secret.',
  });
}

function hideQueue() {
  settleConfirm(false);
  if (unmountQueue === null) return;
  const unmount = unmountQueue;
  unmountQueue = null;
  unmount();
}

function show(name) {
  for (const [key, view] of Object.entries(views)) view.hidden = key !== name;
}

async function render() {
  const reply = await send({ type: 'status' });
  const on = !reply.error && reply.on === true;
  failure.hidden = !reply.error;
  offButton.hidden = !on;
  if (!on) hideQueue();
  if (reply.error) {
    show(null);
  } else if (on) {
    show('on');
    showQueue();
  } else if (reply.configured) {
    show('unlock');
    passphrase.focus();
  } else {
    show('setup');
  }
}

views.unlock.addEventListener('submit', async (event) => {
  event.preventDefault();
  const typed = passphrase.value;
  passphrase.value = '';
  turnOnButton.disabled = true;
  result.textContent = 'Turning on…';
  const reply = await send({ type: 'unlock', passphrase: typed });
  turnOnButton.disabled = false;
  if (reply.error === 'wrong-passphrase') {
    result.textContent = 'Wrong passphrase.';
    passphrase.focus();
    return;
  }
  result.textContent = reply.error && reply.error !== 'not-configured' ? 'Something went wrong.' : '';
  render();
});

offButton.addEventListener('click', async () => {
  offButton.disabled = true;
  await send({ type: 'lock' });
  offButton.disabled = false;
  render();
});

document.getElementById('settings').addEventListener('click', () => {
  browser.runtime.openOptionsPage().then(() => window.close(), () => {});
});

render();
