// Copyright (c) 2026 dta0one
// SPDX-License-Identifier: MIT
//
// Shared by the status page and ariam connect.
//
// options.confirm(message) -> boolean | Promise<boolean> replaces
// window.confirm, which extension popups do not have.
// options.unauthorizedMessage replaces the advice shown when the server
// rejects the credentials (default: reload the page to sign in again).
//
// transport (supplies any credentials; this module never adds them):
//   call(method, params)  -> Promise<result>
//   multicall(calls)      -> Promise<Array>; calls = [{methodName, params}],
//                            one entry per call: [value] on success,
//                            {code, message} on failure (aria2's shape)
//   Both reject with a TransportError.
//
// Server strings (name, site, status, error text) reach the DOM only through
// textContent or attribute setters.

export class TransportError extends Error {
  // kind: 'network' (no response), 'locked' (HTTP 429), 'rpc' (JSON-RPC error
  // object; code and message from the server), 'http' (any other bad response).
  constructor(kind, message, { status, code } = {}) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

const POLL_MS = 2000;
// getGlobalStat totals show when a list is cut at this cap.
const LIST_LIMIT = 200;
const KEYS = ['gid', 'status', 'totalLength', 'completedLength', 'downloadSpeed', 'name', 'site', 'errorCode'];
const NOTICE_MS = 8000;
const MAX_LIMIT = 2147483647;
const NO_SITE = '(none)';

const STATUS_TEXT = {
  active: 'Downloading',
  waiting: 'Queued',
  paused: 'Paused',
  complete: 'Complete',
  error: 'Error',
  removed: 'Cancelled',
};

// aria2 exit-status codes (src/error_code.h); errorMessage is withheld from
// the page, so the code is the only failure detail.
const ERROR_TEXT = {
  1: 'unknown error',
  2: 'timed out',
  3: 'not found',
  4: 'not found (too many attempts)',
  5: 'too slow',
  6: 'network problem',
  7: 'unfinished at shutdown',
  8: 'server cannot resume',
  9: 'not enough disk space',
  10: 'piece length changed',
  11: 'duplicate download',
  13: 'file already exists',
  14: 'rename failed',
  15: 'cannot open file',
  16: 'cannot create file',
  17: 'file I/O error',
  18: 'cannot create directory',
  19: 'name resolution failed',
  21: 'FTP error',
  22: 'bad HTTP response',
  23: 'too many redirects',
  24: 'HTTP authorization failed',
  28: 'bad option',
  29: 'server unavailable',
  32: 'checksum mismatch',
};

// aria2 sends numbers as decimal strings.

function int(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

function parseDownload(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  return {
    gid: str(d.gid),
    status: str(d.status),
    total: int(d.totalLength),
    done: int(d.completedLength),
    speed: int(d.downloadSpeed),
    name: str(d.name),
    site: str(d.site),
    errorCode: int(d.errorCode),
  };
}

function parseDownloads(raw) {
  return Array.isArray(raw) ? raw.map(parseDownload).filter((d) => d.gid !== '') : null;
}

function parseSummary(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const sites = Array.isArray(s.sites) ? s.sites : [];
  return {
    defaultLimit: int(s.default),
    ceiling: int(s.ceiling),
    sites: sites
      .filter((x) => x && typeof x === 'object')
      .map((x) => ({
        site: str(x.site),
        listed: x.listed === 'true',
        limit: int(x.limit),
        active: int(x.active),
        waiting: int(x.waiting),
        paused: int(x.paused),
      })),
  };
}

function parseStat(raw) {
  const g = raw && typeof raw === 'object' ? raw : {};
  return {
    speed: int(g.downloadSpeed),
    numActive: int(g.numActive),
    numWaiting: int(g.numWaiting),
    numStopped: int(g.numStopped),
  };
}

function parseLimit(text, min) {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= MAX_LIMIT ? n : null;
}

function formatSiteList(list) {
  return list.map(([host, n]) => `${host}:${n}`).join(',');
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

function bytes(n) {
  let v = n;
  let i = 0;
  while (v >= 1024 && i < UNITS.length - 1) {
    v /= 1024;
    i += 1;
  }
  if (i === 0) return `${v} B`;
  const digits = v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(digits)} ${UNITS[i]}`;
}

function duration(seconds) {
  const s = Math.ceil(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h`;
  if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m ${String(s % 60).padStart(2, '0')}s`;
}

function limitText(n) {
  return n === 0 ? 'unlimited' : String(n);
}

function displayName(d) {
  return d.name !== '' ? d.name : `(unnamed ${d.gid})`;
}

function clock(date) {
  return date.toLocaleTimeString();
}

function isUnauthorizedFault(fault) {
  return Boolean(fault) && Number(fault.code) === 1 && fault.message === 'Unauthorized';
}

function isUnauthorized(err) {
  return err instanceof TransportError && err.kind === 'rpc' && isUnauthorizedFault(err);
}

function describe(err) {
  if (err instanceof TransportError) {
    if (err.kind === 'locked') return 'too many attempts — try again later';
    if (err.kind === 'network') return 'can’t reach ariam';
    if (err.kind === 'http') return `ariam answered HTTP ${err.status}`;
    if (isUnauthorized(err)) return 'not authorized';
    return err.message;
  }
  return err && err.message ? err.message : String(err);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function makeButton(label, className) {
  const b = el('button', className, label);
  b.type = 'button';
  return b;
}

function makeStat(label) {
  const wrap = el('div', 'stat');
  const value = el('div', 'stat-value');
  wrap.append(el('div', 'stat-label', label), value);
  return { wrap, value };
}

function reconcile(listEl, rows, items, keyOf, create, update, keep) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push([key, item]);
  }
  // Drop stale rows first so surviving rows are not moved (and defocused) by
  // the ordering pass unless their order changed.
  for (const [key, row] of rows) {
    if (seen.has(key) || (keep && keep(row))) continue;
    row.el.remove();
    rows.delete(key);
  }
  let prev = null;
  for (const [key, item] of unique) {
    let row = rows.get(key);
    if (!row) {
      row = create();
      rows.set(key, row);
    }
    update(row, item);
    const expected = prev ? prev.el.nextSibling : listEl.firstChild;
    if (row.el !== expected) listEl.insertBefore(row.el, expected);
    prev = row;
  }
}

// Polls never touch an open editor's input.
function makeEditor({ label, min, hint, removeLabel }) {
  const form = el('form', 'editor');
  form.noValidate = true;
  form.hidden = true;
  const field = el('label', 'editor-field');
  const input = el('input', 'editor-input');
  input.type = 'number';
  input.inputMode = 'numeric';
  input.min = String(min);
  input.step = '1';
  input.setAttribute('enterkeyhint', 'done');
  field.append(el('span', 'editor-label', label), input);
  const save = el('button', 'btn btn-primary', 'Save');
  save.type = 'submit';
  const remove = removeLabel ? makeButton(removeLabel, 'btn') : null;
  const cancel = makeButton('Cancel', 'btn');
  const actions = el('div', 'editor-actions');
  actions.append(save);
  if (remove) actions.append(remove);
  actions.append(cancel);
  form.append(field, actions, el('p', 'editor-hint', hint));
  return { form, input, save, remove, cancel };
}

export function mount(root, transport, options = {}) {
  const confirmFn = typeof options.confirm === 'function' ? options.confirm : (m) => window.confirm(m);
  const unauthorizedMessage = typeof options.unauthorizedMessage === 'string'
    ? options.unauthorizedMessage
    : 'Not authorized — reload the page to sign in again.';
  const state = {
    active: [],
    waiting: [],
    stopped: [],
    stat: null,
    summary: null,
    updated: null,
    loaded: false,
  };
  const siteRows = new Map();
  const downloadRows = { active: new Map(), waiting: new Map(), stopped: new Map() };
  let timer = null;
  let inFlight = false;
  let again = false;
  let halted = false;
  let destroyed = false;
  let noticeTimer = null;
  let clearing = false;

  root.replaceChildren();
  root.classList.add('qv');

  const header = el('header', 'qv-header');
  const totals = el('p', 'qv-totals');
  header.append(el('h1', 'qv-title', 'ariam'), totals);

  const status = el('div', 'qv-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const pollMsg = el('p', 'msg');
  const actionMsg = el('p', 'msg');
  pollMsg.hidden = true;
  actionMsg.hidden = true;
  status.append(pollMsg, actionMsg);

  function makeSection(title, extra) {
    const section = el('section', 'panel');
    const head = el('div', 'panel-head');
    const h2 = el('h2', 'panel-title');
    const count = el('span', 'count');
    h2.append(el('span', null, title), count);
    head.append(h2);
    if (extra) head.append(extra);
    const list = el('ul', 'list');
    const empty = el('p', 'empty');
    const note = el('p', 'note');
    note.hidden = true;
    section.append(head);
    return { section, count, list, empty, note };
  }

  const sites = makeSection('Sites');
  const defaults = el('div', 'site site-default');
  const defaultsHead = el('div', 'row-head');
  const defaultsEdit = makeButton('Edit', 'btn btn-small');
  defaultsEdit.setAttribute('aria-expanded', 'false');
  defaultsEdit.setAttribute('aria-label', 'Edit the default limit');
  defaultsHead.append(el('span', 'row-title', 'Each unlisted site'), defaultsEdit);
  const defaultStats = el('div', 'stats');
  const defaultLimitStat = makeStat('Default limit');
  const ceilingStat = makeStat('Overall ceiling');
  defaultStats.append(defaultLimitStat.wrap, ceilingStat.wrap);
  const defaultEditor = makeEditor({
    label: 'Default limit',
    min: 0,
    hint: 'Whole number; 0 = unlimited.',
  });
  defaults.append(defaultsHead, defaultStats, defaultEditor.form);
  sites.section.append(defaults, sites.list, sites.empty);
  setText(sites.empty, 'No sites yet.');

  const clearButton = makeButton('Clear list', 'btn btn-small');
  const active = makeSection('Active');
  const waiting = makeSection('Queued');
  const stopped = makeSection('Finished', clearButton);
  for (const s of [active, waiting, stopped]) s.section.append(s.list, s.empty, s.note);
  setText(active.empty, 'Nothing downloading.');
  setText(waiting.empty, 'Queue is empty.');
  setText(stopped.empty, 'No finished downloads.');

  root.append(header, status, sites.section, active.section, waiting.section, stopped.section);

  function setPollMessage(text) {
    setText(pollMsg, text);
    pollMsg.hidden = text === '';
    root.classList.toggle('is-stale', text !== '');
  }

  function setActionMessage(text) {
    if (noticeTimer !== null) {
      clearTimeout(noticeTimer);
      noticeTimer = null;
    }
    setText(actionMsg, text);
    actionMsg.hidden = text === '';
    if (text !== '') {
      noticeTimer = setTimeout(() => {
        noticeTimer = null;
        setText(actionMsg, '');
        actionMsg.hidden = true;
      }, NOTICE_MS);
    }
  }

  function staleSuffix() {
    return state.updated ? ` Showing data from ${clock(state.updated)}.` : '';
  }

  function pollFailure(err) {
    if (isUnauthorized(err)) {
      halted = true;
      return unauthorizedMessage;
    }
    if (err instanceof TransportError && err.kind === 'locked') return 'Too many attempts — try again later.';
    if (err instanceof TransportError && err.kind === 'network') return 'Can’t reach ariam — retrying.';
    return `Couldn’t refresh: ${describe(err)}.`;
  }

  async function act(label, fn, row) {
    if (row) {
      row.pending = true;
      row.toggle.disabled = true;
      row.cancel.disabled = true;
    }
    let ok = false;
    try {
      await fn();
      ok = true;
      setActionMessage('');
    } catch (err) {
      setActionMessage(`${label} failed: ${describe(err)}.`);
    } finally {
      if (row) row.pending = false;
      pollNow();
    }
    return ok;
  }

  // A site write reads the summary and writes back the whole list, so writes
  // run one at a time.
  let siteWrites = Promise.resolve();
  function writeSite(site, limit) {
    const run = siteWrites.then(() => writeSiteNow(site, limit));
    siteWrites = run.catch(() => {});
    return run;
  }

  async function writeSiteNow(site, limit) {
    const fresh = parseSummary(await transport.call('ariam.getSiteSummary', []));
    const list = fresh.sites.filter((s) => s.listed).map((s) => [s.site, s.limit]);
    const i = list.findIndex(([host]) => host === site);
    if (limit === null) {
      if (i < 0) return;
      list.splice(i, 1);
    } else if (i >= 0) {
      list[i][1] = limit;
    } else {
      list.push([site, limit]);
    }
    await transport.call('aria2.changeGlobalOption', [{ 'site-concurrent': formatSiteList(list) }]);
  }

  function writeDefault(limit) {
    return transport.call('aria2.changeGlobalOption', [{ 'site-concurrent-default': String(limit) }]);
  }

  function openEditor(editor, editButton, value, placeholder) {
    editor.input.value = value;
    editor.input.placeholder = placeholder;
    editor.form.hidden = false;
    editButton.setAttribute('aria-expanded', 'true');
    editor.input.focus();
  }

  function closeEditor(editor, editButton) {
    editor.form.hidden = true;
    editButton.setAttribute('aria-expanded', 'false');
  }

  function editorBusy(editor, busy) {
    editor.save.disabled = busy;
    if (editor.remove) editor.remove.disabled = busy;
  }

  defaultsEdit.addEventListener('click', () => {
    if (!defaultEditor.form.hidden) {
      closeEditor(defaultEditor, defaultsEdit);
      return;
    }
    const current = state.summary ? String(state.summary.defaultLimit) : '';
    openEditor(defaultEditor, defaultsEdit, current, '0');
  });
  defaultEditor.cancel.addEventListener('click', () => closeEditor(defaultEditor, defaultsEdit));
  defaultEditor.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const n = parseLimit(defaultEditor.input.value, 0);
    if (n === null) {
      setActionMessage('Default limit: enter a whole number, 0 or more.');
      return;
    }
    editorBusy(defaultEditor, true);
    const ok = await act('Saving the default limit', () => writeDefault(n));
    editorBusy(defaultEditor, false);
    if (ok) closeEditor(defaultEditor, defaultsEdit);
  });

  clearButton.addEventListener('click', async () => {
    clearing = true;
    clearButton.disabled = true;
    await act('Clear list', () => transport.call('aria2.purgeDownloadResult', []));
    clearing = false;
    renderDownloads();
  });

  function createSiteRow() {
    const li = el('li', 'site');
    const head = el('div', 'row-head');
    const name = el('span', 'row-title');
    const edit = makeButton('Edit', 'btn btn-small');
    edit.setAttribute('aria-expanded', 'false');
    head.append(name, edit);
    const stats = el('div', 'stats');
    const limit = makeStat('Limit');
    const activeStat = makeStat('Active');
    const queued = makeStat('Queued');
    stats.append(limit.wrap, activeStat.wrap, queued.wrap);
    const editor = makeEditor({
      label: 'Limit for this site',
      min: 1,
      hint: 'Whole number, 1 or more. “Remove rule” puts the site under the next broader rule, or the default limit.',
      removeLabel: 'Remove rule',
    });
    li.append(head, stats, editor.form);
    const row = { el: li, name, edit, limit, active: activeStat, queued, editor, item: null };

    edit.addEventListener('click', () => {
      if (!editor.form.hidden) {
        closeEditor(editor, edit);
        return;
      }
      const s = row.item;
      openEditor(editor, edit, s.listed ? String(s.limit) : '', '1');
    });
    editor.cancel.addEventListener('click', () => closeEditor(editor, edit));
    editor.form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const n = parseLimit(editor.input.value, 1);
      if (n === null) {
        setActionMessage('Site limit: enter a whole number, 1 or more.');
        return;
      }
      editorBusy(editor, true);
      const ok = await act('Saving the site limit', () => writeSite(row.item.site, n));
      editorBusy(editor, false);
      if (ok) closeEditor(editor, edit);
    });
    editor.remove.addEventListener('click', async () => {
      editorBusy(editor, true);
      const ok = await act('Remove rule', () => writeSite(row.item.site, null));
      editorBusy(editor, false);
      if (ok) closeEditor(editor, edit);
    });
    return row;
  }

  function updateSiteRow(row, s) {
    row.item = s;
    setText(row.name, s.site);
    setText(row.limit.value, s.listed ? limitText(s.limit) : `${limitText(s.limit)} (default)`);
    setText(row.active.value, String(s.active));
    setText(row.queued.value, s.paused > 0 ? `${s.waiting} +${s.paused} paused` : String(s.waiting));
    row.edit.hidden = s.site === NO_SITE;
    row.edit.setAttribute('aria-label', `Edit limit for ${s.site}`);
    row.editor.input.setAttribute('aria-label', `Limit for ${s.site}`);
    row.editor.remove.hidden = !s.listed;
    if (s.site === NO_SITE && !row.editor.form.hidden) closeEditor(row.editor, row.edit);
  }

  function createDownloadRow() {
    const li = el('li', 'dl');
    const head = el('div', 'dl-head');
    const name = el('span', 'dl-name');
    const badge = el('span', 'badge');
    head.append(name, badge);
    const bar = el('progress', 'dl-bar');
    bar.max = 1;
    bar.value = 0;
    const size = el('p', 'dl-meta');
    const rate = el('p', 'dl-meta');
    const controls = el('div', 'controls');
    const toggle = makeButton('Pause', 'btn');
    const cancel = makeButton('Cancel', 'btn btn-danger');
    controls.append(toggle, cancel);
    li.append(head, bar, size, rate, controls);
    const row = { el: li, name, badge, bar, size, rate, controls, toggle, cancel, item: null, pending: false };

    toggle.addEventListener('click', () => {
      const d = row.item;
      if (d.status === 'paused') {
        act('Resume', () => transport.call('aria2.unpause', [d.gid]), row);
      } else {
        act('Pause', () => transport.call('aria2.pause', [d.gid]), row);
      }
    });
    cancel.addEventListener('click', async () => {
      const d = row.item;
      let confirmed = false;
      try {
        confirmed = Boolean(await confirmFn(`Cancel “${displayName(d)}”?`));
      } catch {
        confirmed = false;
      }
      if (!confirmed || destroyed || row.pending) return;
      act('Cancel', () => transport.call('aria2.remove', [d.gid]), row);
    });
    return row;
  }

  function updateDownloadRow(row, d) {
    row.item = d;
    const label = displayName(d);
    setText(row.name, label);
    row.bar.setAttribute('aria-label', `${label} progress`);
    setText(row.badge, STATUS_TEXT[d.status] || d.status);
    row.badge.dataset.status = d.status;

    if (d.total > 0) {
      row.bar.max = d.total;
      row.bar.value = Math.min(d.done, d.total);
      const pct = Math.floor((Math.min(d.done, d.total) / d.total) * 100);
      setText(row.size, `${bytes(d.done)} / ${bytes(d.total)} · ${pct}%`);
    } else {
      row.bar.max = 1;
      row.bar.value = d.status === 'complete' ? 1 : 0;
      setText(row.size, d.done > 0 ? `${bytes(d.done)} / size unknown` : 'Size unknown');
    }

    const parts = [];
    if (d.status === 'active') {
      parts.push(`${bytes(d.speed)}/s`);
      if (d.speed > 0 && d.total > 0 && d.done < d.total) {
        parts.push(`ETA ${duration((d.total - d.done) / d.speed)}`);
      }
    }
    if (d.status === 'error') {
      const why = ERROR_TEXT[d.errorCode];
      parts.push(why ? `Error ${d.errorCode}: ${why}` : `Error ${d.errorCode}`);
    }
    if (d.site !== '') parts.push(d.site);
    setText(row.rate, parts.join(' · '));

    const live = d.status === 'active' || d.status === 'waiting' || d.status === 'paused';
    row.controls.hidden = !live;
    setText(row.toggle, d.status === 'paused' ? 'Resume' : 'Pause');
    row.toggle.setAttribute('aria-label', `${d.status === 'paused' ? 'Resume' : 'Pause'} ${label}`);
    row.cancel.setAttribute('aria-label', `Cancel ${label}`);
    row.toggle.disabled = row.pending;
    row.cancel.disabled = row.pending;
  }

  function renderTotals() {
    const g = state.stat;
    if (!g) {
      setText(totals, state.loaded ? '' : 'Loading…');
      return;
    }
    const grp = groups();
    const paused = grp.paused.length > 0 ? ` (${grp.paused.length} paused)` : '';
    setText(
      totals,
      `↓ ${bytes(g.speed)}/s · ${g.numActive + grp.paused.length} active${paused} · ${grp.queuedTotal(g)} queued · ${g.numStopped} finished`,
    );
  }

  // aria2's pause returns a download to the waiting list as 'paused'.
  // state.waiting is one tellWaiting page, so paused entries beyond it are
  // unknown.
  function groups() {
    const paused = state.waiting.filter((d) => d.status === 'paused');
    const queued = state.waiting.filter((d) => d.status !== 'paused');
    return {
      paused,
      queued,
      active: state.active.concat(paused),
      // numWaiting counts waiting and paused downloads together. Past the page
      // the split of the unlisted ones is unknown; they count as queued.
      queuedTotal: (g) => (g ? Math.max(g.numWaiting - paused.length, queued.length) : queued.length),
    };
  }

  function renderSites() {
    const s = state.summary;
    if (!s) {
      sites.empty.hidden = true;
      return;
    }
    setText(defaultLimitStat.value, limitText(s.defaultLimit));
    setText(ceilingStat.value, String(s.ceiling));
    reconcile(
      sites.list,
      siteRows,
      s.sites.filter((x) => x.site !== ''),
      (x) => x.site,
      createSiteRow,
      updateSiteRow,
      (row) => !row.editor.form.hidden,
    );
    setText(sites.count, ` ${s.sites.length}`);
    sites.empty.hidden = siteRows.size > 0;
  }

  function renderList(section, rows, items, count, note) {
    reconcile(section.list, rows, items, (d) => d.gid, createDownloadRow, updateDownloadRow);
    setText(section.count, ` ${count}`);
    section.empty.hidden = !state.loaded || items.length > 0;
    section.note.hidden = note === '';
    if (note !== '') setText(section.note, note);
  }

  function cutNote(prefix, shown, total) {
    return total !== null && total > shown ? `${prefix} ${shown} of ${total}.` : '';
  }

  function renderDownloads() {
    const g = state.stat;
    const grp = groups();
    renderList(active, downloadRows.active, grp.active, grp.active.length, '');
    // The waiting page holds waiting and paused entries, so the cut is judged
    // against numWaiting over the whole page, not the queued entries alone.
    const waitingCut = g && g.numWaiting > state.waiting.length;
    renderList(
      waiting,
      downloadRows.waiting,
      grp.queued,
      grp.queuedTotal(g),
      waitingCut ? `Showing the first ${state.waiting.length} of ${g.numWaiting} queued and paused downloads.` : '',
    );
    // tellStopped with offset -1 already returns the most recent first.
    const stoppedTotal = g ? Math.max(g.numStopped, state.stopped.length) : state.stopped.length;
    renderList(
      stopped,
      downloadRows.stopped,
      state.stopped,
      stoppedTotal,
      g ? cutNote('Showing the most recent', state.stopped.length, g.numStopped) : '',
    );
    clearButton.disabled = clearing || state.stopped.length === 0;
  }

  function render() {
    renderTotals();
    renderSites();
    renderDownloads();
  }

  function pollCalls() {
    return [
      { methodName: 'aria2.tellActive', params: [KEYS] },
      { methodName: 'aria2.tellWaiting', params: [0, LIST_LIMIT, KEYS] },
      { methodName: 'aria2.tellStopped', params: [-1, LIST_LIMIT, KEYS] },
      { methodName: 'aria2.getGlobalStat', params: [] },
      { methodName: 'ariam.getSiteSummary', params: [] },
    ];
  }

  async function poll() {
    let results;
    try {
      results = await transport.multicall(pollCalls());
    } catch (err) {
      setPollMessage(pollFailure(err) + staleSuffix());
      return;
    }
    if (destroyed) return;
    if (!Array.isArray(results) || results.length !== 5) {
      setPollMessage(`Couldn’t refresh: unexpected response.${staleSuffix()}`);
      return;
    }
    const faults = results.filter((r) => !Array.isArray(r));
    if (faults.length === results.length && faults.every(isUnauthorizedFault)) {
      halted = true;
      setPollMessage(unauthorizedMessage + staleSuffix());
      return;
    }
    const [a, w, s, g, summary] = results.map((r) => (Array.isArray(r) ? r[0] : undefined));
    const activeList = parseDownloads(a);
    const waitingList = parseDownloads(w);
    const stoppedList = parseDownloads(s);
    if (activeList) state.active = activeList;
    if (waitingList) state.waiting = waitingList;
    if (stoppedList) state.stopped = stoppedList;
    if (g && typeof g === 'object') state.stat = parseStat(g);
    if (summary && typeof summary === 'object') state.summary = parseSummary(summary);
    state.loaded = state.loaded || faults.length < results.length;
    if (faults.length === 0) {
      state.updated = new Date();
      setPollMessage('');
    } else {
      const first = faults[0] && typeof faults[0].message === 'string' ? faults[0].message : 'error';
      setPollMessage(`Part of the data couldn’t be loaded: ${first}.`);
    }
    render();
  }

  function schedule() {
    if (destroyed || halted || document.hidden || inFlight || timer !== null) return;
    timer = setTimeout(run, POLL_MS);
  }

  async function run() {
    timer = null;
    if (destroyed || halted || document.hidden) return;
    inFlight = true;
    try {
      await poll();
    } catch (err) {
      setPollMessage(`Display error: ${describe(err)}.`);
    } finally {
      inFlight = false;
    }
    if (again) {
      again = false;
      run();
      return;
    }
    schedule();
  }

  function pollNow() {
    if (inFlight) {
      again = true;
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    run();
  }

  function visibilityChanged() {
    if (document.hidden) {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    } else {
      pollNow();
    }
  }

  document.addEventListener('visibilitychange', visibilityChanged);
  render();
  pollNow();

  return function unmount() {
    destroyed = true;
    document.removeEventListener('visibilitychange', visibilityChanged);
    if (timer !== null) clearTimeout(timer);
    if (noticeTimer !== null) clearTimeout(noticeTimer);
    root.replaceChildren();
    root.classList.remove('qv', 'is-stale');
  };
}
