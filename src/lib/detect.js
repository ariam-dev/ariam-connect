// Copyright (c) 2026 dta0one
//
// Pure: no `browser` access, so `node --test` loads it directly.

// Application types Firefox displays instead of downloading. Any type with a
// `+json` or `+xml` suffix is displayable too (Firefox's JSON viewer matches
// application/*+json).
export const DISPLAYABLE_TYPES = Object.freeze([
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
  'application/ogg',
]);

export function headerValue(headers, name) {
  if (!Array.isArray(headers)) return undefined;
  const wanted = name.toLowerCase();
  const found = headers.find((h) => typeof h?.name === 'string' && h.name.toLowerCase() === wanted);
  if (found === undefined) return undefined;
  return typeof found.value === 'string' ? found.value : '';
}

export function sendableUrl(text, instanceOrigin) {
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin === instanceOrigin) return null;
  return url;
}

function mediaType(contentType) {
  return contentType.split(';')[0].trim().toLowerCase();
}

function isDisplayable(type) {
  return type.endsWith('+json') || type.endsWith('+xml') || DISPLAYABLE_TYPES.includes(type);
}

export function isDownload(details, instanceOrigin) {
  if (details.method !== 'GET' || details.statusCode !== 200) return false;
  if (details.type !== 'main_frame' && details.type !== 'sub_frame') return false;
  if (sendableUrl(details.url, instanceOrigin) === null) return false;
  const disposition = headerValue(details.responseHeaders, 'Content-Disposition');
  if (disposition !== undefined && disposition.trim().toLowerCase().startsWith('attachment')) return true;
  const contentType = headerValue(details.responseHeaders, 'Content-Type');
  if (contentType === undefined) return false;
  const type = mediaType(contentType);
  if (type === 'binary/octet-stream') return true;
  return type.startsWith('application/') && !isDisplayable(type);
}
