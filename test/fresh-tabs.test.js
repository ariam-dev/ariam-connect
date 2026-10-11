// Copyright (c) 2026 dta0one

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFreshTabs } from '../src/lib/fresh-tabs.js';

test('every created tab is fresh once', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7 });
  assert.equal(tabs.take(7), true);
  assert.equal(tabs.take(7), false);
});

test('a tab with an opener is fresh', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7, openerTabId: 3 });
  assert.equal(tabs.take(7), true);
});

test('a finished document load unmarks the tab', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7 });
  tabs.loaded(7);
  assert.equal(tabs.take(7), false);
});

test('a shown document response unmarks the tab before it completes', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7 });
  tabs.responded({ type: 'main_frame', statusCode: 200, tabId: 7 }, false);
  assert.equal(tabs.take(7), false);
});

test('a redirect hop keeps the tab fresh', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7 });
  tabs.responded({ type: 'main_frame', statusCode: 302, tabId: 7 }, false);
  assert.equal(tabs.take(7), true);
});

test('a sub_frame response keeps the tab fresh', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7 });
  tabs.responded({ type: 'sub_frame', statusCode: 200, tabId: 7 }, false);
  assert.equal(tabs.take(7), true);
});

test('a captured download keeps the tab fresh', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7 });
  tabs.responded({ type: 'main_frame', statusCode: 200, tabId: 7 }, true);
  assert.equal(tabs.take(7), true);
});

test('a removed tab is unmarked', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7 });
  tabs.removed(7);
  assert.equal(tabs.take(7), false);
});

test('clear unmarks every tab', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7 });
  tabs.created({ id: 8 });
  tabs.clear();
  assert.equal(tabs.take(7), false);
  assert.equal(tabs.take(8), false);
});

test('marks are per tab', () => {
  const tabs = createFreshTabs();
  tabs.created({ id: 7 });
  tabs.created({ id: 8 });
  tabs.loaded(7);
  assert.equal(tabs.take(7), false);
  assert.equal(tabs.take(8), true);
});
