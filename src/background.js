// Copyright (c) 2026 dta0one
//
// The extension starts off on every launch. While on, the decrypted RPC secret
// lives only in this page's memory (`secret` and the hand-off session); it is
// never written anywhere and never leaves this page.
//
// storage.local holds exactly two keys: `instanceUrl` (an origin) and `vault`
// (a seal record from lib/vault.js).

import { isPassphrase, open, seal } from './lib/vault.js';
import { call, errorShape, parseInstanceUrl } from './lib/rpc.js';
import { headerValue, isDownload, sendableUrl } from './lib/detect.js';
import { allowedCall } from './lib/relay.js';
import { createFreshTabs } from './lib/fresh-tabs.js';
import { createHandOff, linkFields, pageOrigin } from './lib/hand-off.js';
import { createUpdateGate } from './lib/update-gate.js';

let secret = null;
let instanceUrl = null;

function isOn() {
  return secret !== null;
}

const update = createUpdateGate({ isOn, reload: () => browser.runtime.reload() });

browser.runtime.onUpdateAvailable.addListener(() => update.available());

const handOffs = createHandOff(call);

function notifyFailure(err) {
  const shape = errorShape(err);
  const message = shape.kind === 'timeout'
    ? `ariam connect: ${shape.message}; ariam may have queued it too`
    : `ariam connect: ${shape.message}`;
  Promise.resolve()
    .then(() => browser.notifications.create({ type: 'basic', title: 'ariam connect', message }))
    .catch(() => {});
}

// Call only while on: the session is null while off.
async function handOff(url, cookie, referer, siteHint) {
  const session = handOffs.session();
  try {
    await update.track(() => handOffs.send(session, url, cookie, referer, siteHint));
    return true;
  } catch (err) {
    notifyFailure(err);
    return false;
  }
}

const FILTER = { urls: ['http://*/*', 'https://*/*'], types: ['main_frame', 'sub_frame'] };

const sent = new Map();
let capturing = false;

function recordRequest(details) {
  const headers = details.requestHeaders;
  sent.set(details.requestId, {
    cookie: headerValue(headers, 'Cookie') ?? '',
    referer: headerValue(headers, 'Referer') ?? '',
    authorization: headerValue(headers, 'Authorization') !== undefined,
  });
}

function dropRequest(details) {
  sent.delete(details.requestId);
}

const freshTabs = createFreshTabs();

function tabCreated(tab) {
  freshTabs.created(tab);
}

function tabRemoved(tabId) {
  freshTabs.removed(tabId);
}

function requestCompleted(details) {
  dropRequest(details);
  if (details.type === 'main_frame') freshTabs.loaded(details.tabId);
}

// A later task, so the {cancel: true} that resolves the blocking listener
// reaches Firefox first. The last tab stays open: closing it would quit
// Firefox.
function closeTab(tabId) {
  setTimeout(() => {
    Promise.resolve()
      .then(() => browser.tabs.query({}))
      .then((tabs) => (tabs.length > 1 ? browser.tabs.remove(tabId) : undefined))
      .catch(() => {});
  }, 0);
}

// A returned Promise blocks the response until it settles; undefined lets it
// through untouched.
function captureResponse(details) {
  const record = isOn() ? sent.get(details.requestId) : undefined;
  const captured = record !== undefined && !record.authorization && isDownload(details, instanceUrl);
  freshTabs.responded(details, captured);
  if (!captured) return undefined;
  return handOff(details.url, () => record.cookie, record.referer, pageOrigin(details.originUrl)).then((accepted) => {
    if (!accepted) return {};
    if (details.type === 'main_frame' && freshTabs.take(details.tabId)) closeTab(details.tabId);
    return { cancel: true };
  });
}

function startCapture() {
  if (capturing) return;
  capturing = true;
  const events = browser.webRequest;
  events.onSendHeaders.addListener(recordRequest, FILTER, ['requestHeaders']);
  events.onHeadersReceived.addListener(captureResponse, FILTER, ['blocking', 'responseHeaders']);
  events.onCompleted.addListener(requestCompleted, FILTER);
  events.onErrorOccurred.addListener(dropRequest, FILTER);
  browser.tabs.onCreated.addListener(tabCreated);
  browser.tabs.onRemoved.addListener(tabRemoved);
}

function stopCapture() {
  if (capturing) {
    capturing = false;
    const events = browser.webRequest;
    events.onSendHeaders.removeListener(recordRequest);
    events.onHeadersReceived.removeListener(captureResponse);
    events.onCompleted.removeListener(requestCompleted);
    events.onErrorOccurred.removeListener(dropRequest);
    browser.tabs.onCreated.removeListener(tabCreated);
    browser.tabs.onRemoved.removeListener(tabRemoved);
  }
  sent.clear();
  freshTabs.clear();
}

// Right-click is desktop only: Firefox for Android has no menus API.

const MENU_ID = 'download-with-ariam';

// Any cookies API error (first-party isolation requires firstPartyDomain) or a
// missing store means no cookies.
async function linkCookies(url, tab) {
  const storeId = tab?.cookieStoreId;
  if (typeof storeId !== 'string') return '';
  try {
    const cookies = await browser.cookies.getAll({ url, storeId });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch {
    return '';
  }
}

// The cookies are read only if they will be sent.
async function menuClicked(info, tab) {
  if (info.menuItemId !== MENU_ID || !isOn()) return;
  const link = sendableUrl(info.linkUrl, instanceUrl);
  if (link === null) return;
  const { referer, siteHint } = linkFields(info.frameUrl ?? info.pageUrl, link.href);
  await handOff(link.href, () => linkCookies(link.href, tab), referer, siteHint);
}

if (browser.menus) {
  browser.menus.create({
    id: MENU_ID,
    contexts: ['link'],
    targetUrlPatterns: ['http://*/*', 'https://*/*'],
    title: 'Download with ariam',
    visible: false,
  });
  browser.menus.onClicked.addListener(menuClicked);
}

function updateMenu(visible) {
  if (!browser.menus) return;
  browser.menus.update(MENU_ID, { visible }).catch(() => {});
}

// Not serialized with the on/off messages: it changes no extension state.
async function relay(method, params) {
  if (!isOn()) return { error: { kind: 'rpc', message: 'off' } };
  if (!allowedCall(method, params)) return { error: { kind: 'rpc', message: 'not allowed' } };
  try {
    return { result: await call(instanceUrl, secret, method, params) };
  } catch (err) {
    return { error: errorShape(err) };
  }
}

function applyState() {
  const on = isOn();
  const action = browser.browserAction;
  Promise.all([
    action.setIcon?.({ path: on ? 'icons/on.svg' : 'icons/off.svg' }),
    action.setTitle?.({ title: on ? 'ariam connect — on' : 'ariam connect — off' }),
  ]).catch(() => {});
  updateMenu(on);
}

function turnOn(plain, url) {
  secret = plain;
  instanceUrl = url;
  handOffs.start(url, plain);
  startCapture();
  applyState();
}

// A hand-off in flight keeps the session it started with, so its Promise still
// resolves.
function turnOff() {
  stopCapture();
  handOffs.stop();
  secret = null;
  instanceUrl = null;
  applyState();
}

async function readConfig() {
  const stored = await browser.storage.local.get(['instanceUrl', 'vault']);
  if (typeof stored.instanceUrl !== 'string' || !stored.vault) return null;
  return { instanceUrl: stored.instanceUrl, vault: stored.vault };
}

// State-changing messages run one at a time in arrival order (see
// lib/update-gate.js).
const { serialize } = update;

async function saveConfig(url, typedSecret, passphrase) {
  turnOff();
  const vault = await seal(typedSecret, passphrase);
  await browser.storage.local.set({ instanceUrl: url, vault });
  return { ok: true };
}

async function checkInstance(url, typedSecret) {
  try {
    return { result: await call(url, typedSecret, 'aria2.getVersion') };
  } catch (err) {
    return { error: errorShape(err) };
  }
}

async function configure(message) {
  const url = parseInstanceUrl(message.url);
  if (url === null) return { error: 'invalid-url' };
  if (typeof message.secret !== 'string' || message.secret === '') return { error: 'invalid-secret' };
  if (!isPassphrase(message.passphrase)) return { error: 'invalid-passphrase' };
  const saved = await serialize(() => saveConfig(url, message.secret, message.passphrase));
  // Outside the queue: the check changes no state, and a later message
  // shouldn't wait up to the RPC timeout behind it. handle() tracks the whole
  // message, so a pending update waits for this reply.
  return { ...saved, check: await checkInstance(url, message.secret) };
}

async function changePassphrase(current, next) {
  if (!isPassphrase(next)) return { error: 'invalid-passphrase' };
  const config = await readConfig();
  if (config === null) return { error: 'not-configured' };
  let plain;
  try {
    plain = await open(config.vault, typeof current === 'string' ? current : '');
  } catch {
    return { error: 'wrong-passphrase' };
  }
  await browser.storage.local.set({ vault: await seal(plain, next) });
  return { ok: true };
}

async function reset() {
  turnOff();
  await browser.storage.local.clear();
  return { ok: true };
}

async function unlock(passphrase) {
  const config = await readConfig();
  if (config === null) return { error: 'not-configured' };
  if (!isPassphrase(passphrase)) return { error: 'wrong-passphrase' };
  let plain;
  try {
    plain = await open(config.vault, passphrase);
  } catch {
    return { error: 'wrong-passphrase' };
  }
  turnOn(plain, config.instanceUrl);
  return { ok: true };
}

async function lock() {
  turnOff();
  return { ok: true };
}

async function status() {
  return { on: isOn(), configured: (await readConfig()) !== null };
}

function handle(message) {
  switch (message.type) {
    case 'configure':
      return update.track(() => configure(message));
    case 'changePassphrase':
      return serialize(() => changePassphrase(message.current, message.next));
    case 'reset':
      return serialize(reset);
    case 'unlock':
      return serialize(() => unlock(message.passphrase));
    case 'lock':
      return serialize(lock);
    case 'status':
      return status();
    case 'rpc':
      return relay(message.method, message.params);
    case 'multicall':
      return relay('system.multicall', [message.calls]);
    default:
      return Promise.resolve({ error: 'unknown-message' });
  }
}

// Only the extension's own pages (popup, options); never a content script or
// web page.
function fromOwnPage(sender) {
  return (
    sender.id === browser.runtime.id
    && typeof sender.url === 'string'
    && sender.url.startsWith(browser.runtime.getURL(''))
  );
}

browser.runtime.onMessage.addListener((message, sender) => {
  if (!fromOwnPage(sender) || !message || typeof message !== 'object') return undefined;
  return handle(message).catch(() => ({ error: 'failed' }));
});

applyState();
