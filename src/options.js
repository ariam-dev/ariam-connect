// Copyright (c) 2026 dta0one
//
// The background seals, opens and stores the vault; this page only checks input
// and shows the background's answer.

import { isPassphrase } from './lib/vault.js';
import { parseInstanceUrl } from './lib/rpc.js';

const MESSAGES = {
  'invalid-url': 'Enter an https:// origin, or http://localhost or http://127.0.0.1, with no path.',
  'invalid-secret': 'Enter the RPC secret.',
  'invalid-passphrase': 'The passphrase is one to three words separated by single spaces.',
  mismatch: 'The passphrases don’t match.',
  'wrong-passphrase': 'Wrong passphrase.',
  'not-configured': 'Set up first.',
};

function describe(code) {
  return MESSAGES[code] ?? 'Something went wrong.';
}

function field(id) {
  return document.getElementById(id);
}

async function send(message) {
  try {
    const reply = await browser.runtime.sendMessage(message);
    return reply && typeof reply === 'object' ? reply : { error: 'failed' };
  } catch {
    return { error: 'failed' };
  }
}

async function showState() {
  const reply = await send({ type: 'status' });
  let text = '';
  if (!reply.error) {
    if (!reply.configured) text = 'Not set up.';
    else text = reply.on ? 'Set up. ariam connect is on.' : 'Set up. ariam connect is off.';
  }
  field('state').textContent = text;
}

// The fill at load leaves alone a URL the user typed before storage answered.
let urlTouched = false;
field('setup-url').addEventListener('input', () => {
  urlTouched = true;
});

async function fillUrl(force = true) {
  try {
    const { instanceUrl } = await browser.storage.local.get('instanceUrl');
    if (!force && urlTouched) return;
    field('setup-url').value = typeof instanceUrl === 'string' ? instanceUrl : '';
    urlTouched = false;
  } catch {
    // Leave the field as it is.
  }
}

function bind(form, submit) {
  const result = form.querySelector('.result');
  const button = form.querySelector('button');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    button.disabled = true;
    result.textContent = '';
    try {
      result.textContent = await submit();
    } finally {
      button.disabled = false;
      showState();
    }
  });
}

function checkText(check) {
  if (check?.error) return `The instance check failed: ${check.error.message}`;
  const version = check?.result?.version;
  return typeof version === 'string' ? `aria2 ${version} answered.` : 'The instance answered.';
}

bind(field('setup'), async () => {
  const urlField = field('setup-url');
  const secretField = field('setup-secret');
  const passphraseFields = [field('setup-passphrase'), field('setup-passphrase-again')];
  const origin = parseInstanceUrl(urlField.value);
  if (origin === null) return describe('invalid-url');
  if (secretField.value === '') return describe('invalid-secret');
  if (!isPassphrase(passphraseFields[0].value)) return describe('invalid-passphrase');
  if (passphraseFields[0].value.trim() !== passphraseFields[1].value.trim()) return describe('mismatch');
  const message = {
    type: 'configure',
    url: urlField.value,
    secret: secretField.value,
    passphrase: passphraseFields[0].value,
  };
  const reply = await send(message);
  if (reply.error) return describe(reply.error);
  await fillUrl();
  if (reply.check?.result) {
    secretField.value = '';
    for (const input of passphraseFields) input.value = '';
  }
  return `Saved. ariam connect is off. ${checkText(reply.check)}`;
});

bind(field('change'), async () => {
  const inputs = ['change-current', 'change-next', 'change-next-again'].map(field);
  const [current, next, again] = inputs.map((input) => input.value);
  if (!isPassphrase(next)) return describe('invalid-passphrase');
  if (next.trim() !== again.trim()) return describe('mismatch');
  const reply = await send({ type: 'changePassphrase', current, next });
  if (reply.error === 'wrong-passphrase') return 'Wrong current passphrase. The passphrase is unchanged.';
  if (reply.error) return describe(reply.error);
  for (const input of inputs) input.value = '';
  return 'Passphrase changed.';
});

bind(field('reset'), async () => {
  const reply = await send({ type: 'reset' });
  if (reply.error) return describe(reply.error);
  await fillUrl();
  return 'Reset. ariam connect is off; set it up again to use it.';
});

showState();
fillUrl(false);
