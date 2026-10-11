// Copyright (c) 2026 dta0one
//
// Hands one URL to the instance with aria2.addUri and decides whether the
// browser's cookies go with it. Stock aria2 sends the `header` option on every
// redirect hop; ariam sends its cookies only to the origin the download was
// given (https://github.com/ariam-dev/ariam#changes-from-aria2). The
// `site-hint` option (the origin of the page the download came from) goes to
// any instance: ariam reads the download's site from it and never sends it to
// a server; stock aria2 ignores it.
//
// A hand-off is decided by its session's ariam check (a session is one
// turn-on, up to the next off):
//
// - ariam (ariam.getSiteSummary answered with a result): sent with `Cookie:`.
//   Final for the session.
// - not ariam (method-not-found): sent without cookies. Final for the session.
// - unknown (any other failure): not sent; the hand-off rejects with the
//   check's error, so the download stays with the browser. The next hand-off
//   checks again.
//
// Each session is its own object and holds its own answer, so an answer never
// applies to another session or instance. A hand-off keeps the session it
// started with, also past off: its origin, key and cookies all belong to that
// session's instance.
//
// A hand-off settles within TIMEOUT_MS of its start, check included. No addUri
// starts after that; one already sent may still be in flight.

import { RpcError, TIMEOUT_MS } from './rpc.js';

const CHECK_METHOD = 'ariam.getSiteSummary';

// aria2 answers an unknown method with code 1 and `No such method: <name>`;
// -32601 is JSON-RPC's method-not-found code.
function noSuchMethod(err) {
  return err instanceof RpcError
    && err.kind === 'rpc'
    && (err.code === -32601 || err.message.startsWith('No such method'));
}

function headerOption(cookie, referer) {
  const header = [];
  if (cookie) header.push(`Cookie: ${cookie}`);
  if (referer) header.push(`Referer: ${referer}`);
  return header;
}

function protocol(text) {
  try {
    return new URL(text).protocol;
  } catch {
    return '';
  }
}

export function pageOrigin(text) {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}/` : '';
  } catch {
    return '';
  }
}

// pageUrl is the page's or frame's URL. No referer from an https: page to an
// http: link: Firefox's default referrer policy.
export function linkFields(pageUrl, linkUrl) {
  const siteHint = pageOrigin(pageUrl);
  const referer = protocol(pageUrl) === 'https:' && protocol(linkUrl) === 'http:' ? '' : siteHint;
  return { referer, siteHint };
}

// call: rpc.js's call(instanceUrl, secret, method, params).
export function createHandOff(call, timeoutMs = TIMEOUT_MS) {
  let current = null;

  // Never rejects; a failed check's error is in the answer.
  function check(session) {
    if (session.checking === null) {
      session.checking = call(session.origin, session.key, CHECK_METHOD)
        .then(
          () => ({ state: 'ariam' }),
          (error) => ({ state: noSuchMethod(error) ? 'not-ariam' : 'unknown', error }),
        )
        .then((answer) => {
          session.state = answer.state;
          session.checking = null;
          return answer;
        });
    }
    return session.checking;
  }

  async function outcome(session) {
    return session.state === 'unknown' ? check(session) : { state: session.state };
  }

  async function deliver(session, attempt, url, cookie, referer, siteHint) {
    const { state, error } = await outcome(session);
    if (attempt.expired) return;
    if (state === 'unknown') throw error;
    const value = state === 'ariam' ? await cookie() : '';
    if (attempt.expired) return;
    const options = { header: headerOption(value, referer) };
    if (siteHint) options['site-hint'] = siteHint;
    await call(session.origin, session.key, 'aria2.addUri', [[url], options]);
  }

  return {
    start(origin, key) {
      current = { origin, key, state: 'unknown', checking: null };
      check(current);
    },
    stop() {
      current = null;
    },
    session() {
      return current;
    },
    // cookie() returns a Cookie header value or a Promise of one; it is called
    // only when the session's check answered ariam.
    send(session, url, cookie, referer, siteHint) {
      const attempt = { expired: false };
      let timer;
      const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          attempt.expired = true;
          reject(new RpcError('timeout', `no answer within ${timeoutMs / 1000} s`));
        }, timeoutMs);
      });
      return Promise.race([deliver(session, attempt, url, cookie, referer, siteHint), deadline])
        .finally(() => clearTimeout(timer));
    },
  };
}
