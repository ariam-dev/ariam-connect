// Copyright (c) 2026 dta0one

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DISPLAYABLE_TYPES, isDownload } from '../src/lib/detect.js';

const INSTANCE = 'https://ariam.example:6800';

// A webRequest onHeadersReceived details object.
function response({
  method = 'GET', statusCode = 200, type = 'main_frame', url = 'https://files.example/a.bin', headers = {},
} = {}) {
  return {
    method,
    statusCode,
    type,
    url,
    responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
  };
}

const ATTACHMENT = 'attachment; filename="a.bin"';

test('DISPLAYABLE_TYPES is the documented list', () => {
  assert.deepEqual([...DISPLAYABLE_TYPES], [
    'application/pdf',
    'application/json',
    'application/ld+json',
    'application/xml',
    'application/xhtml+xml',
    'application/atom+xml',
    'application/rss+xml',
    'application/javascript',
    'application/ecmascript',
    'application/x-javascript',
    'application/x-xpinstall',
  ]);
});

test('attachment with each media type, including application/pdf, is a download', () => {
  const types = [...DISPLAYABLE_TYPES, 'application/zip', 'application/hal+json', 'text/html', 'image/png'];
  assert.ok(types.includes('application/pdf'));
  for (const contentType of types) {
    const details = response({ headers: { 'Content-Disposition': ATTACHMENT, 'Content-Type': contentType } });
    assert.equal(isDownload(details, INSTANCE), true, contentType);
  }
});

test('application/zip, application/octet-stream and binary/octet-stream are downloads', () => {
  for (const contentType of ['application/zip', 'application/octet-stream', 'binary/octet-stream']) {
    assert.equal(isDownload(response({ headers: { 'Content-Type': contentType } }), INSTANCE), true, contentType);
  }
});

test('displayable types without attachment are not downloads', () => {
  for (const contentType of [...DISPLAYABLE_TYPES, 'application/hal+json', 'application/vnd.example+xml']) {
    assert.equal(isDownload(response({ headers: { 'Content-Type': contentType } }), INSTANCE), false, contentType);
  }
});

test('text/html is not a download', () => {
  assert.equal(isDownload(response({ headers: { 'Content-Type': 'text/html' } }), INSTANCE), false);
});

test('POST, status 206 or 304, xmlhttprequest and the instance origin are not downloads', () => {
  const headers = { 'Content-Disposition': ATTACHMENT, 'Content-Type': 'application/zip' };
  assert.equal(isDownload(response({ headers }), INSTANCE), true);
  assert.equal(isDownload(response({ headers, method: 'POST' }), INSTANCE), false);
  assert.equal(isDownload(response({ headers, statusCode: 206 }), INSTANCE), false);
  assert.equal(isDownload(response({ headers, statusCode: 304 }), INSTANCE), false);
  assert.equal(isDownload(response({ headers, type: 'xmlhttprequest' }), INSTANCE), false);
  assert.equal(isDownload(response({ headers, url: `${INSTANCE}/files/a.bin` }), INSTANCE), false);
});

test('media-type parameters and case are handled', () => {
  const cases = [
    [{ 'Content-Type': 'Application/ZIP; name="a.zip"' }, true],
    [{ 'Content-Type': 'BINARY/Octet-Stream' }, true],
    [{ 'content-type': 'application/octet-stream;charset=binary' }, true],
    [{ 'CONTENT-TYPE': 'Application/PDF; qs=0.9' }, false],
    [{ 'Content-Type': 'application/json; charset=utf-8' }, false],
    [{ 'Content-Type': 'Application/Problem+JSON' }, false],
    [{ 'content-disposition': 'ATTACHMENT; filename=a.html', 'Content-Type': 'text/html; charset=utf-8' }, true],
    [{ 'Content-Disposition': 'inline', 'Content-Type': 'text/html' }, false],
  ];
  for (const [headers, expected] of cases) {
    assert.equal(isDownload(response({ headers }), INSTANCE), expected, JSON.stringify(headers));
  }
});
