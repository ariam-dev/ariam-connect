// Copyright (c) 2026 dta0one
//
// Redirects are refused so the token never follows one.

export const TIMEOUT_MS = 10000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1']);

let nextId = 0;

// kind: 'network' (no response), 'timeout' (no answer within TIMEOUT_MS),
// 'rpc' (JSON-RPC error object; message and code from the server),
// 'http' (any other bad response).
export class RpcError extends Error {
  constructor(kind, message, { code, status } = {}) {
    super(message);
    this.name = 'RpcError';
    this.kind = kind;
    this.code = code;
    this.status = status;
  }
}

// A plain object, since it crosses runtime messaging.
export function errorShape(err) {
  if (!(err instanceof RpcError)) return { kind: 'network', message: 'network error' };
  const shape = { kind: err.kind, message: err.message };
  if (err.code !== undefined) shape.code = err.code;
  if (err.status !== undefined) shape.status = err.status;
  return shape;
}

// http: only on localhost / 127.0.0.1, which are secure contexts.
export function parseInstanceUrl(text) {
  if (typeof text !== 'string') return null;
  let url;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
  if (/[?#]/.test(text)) return null;
  return url.origin;
}

function withToken(token, params) {
  return [token, ...(Array.isArray(params) ? params : [])];
}

// system.multicall carries no token itself; each sub-call's params get it.
function placeToken(secret, method, params) {
  const token = `token:${secret}`;
  if (method !== 'system.multicall') return withToken(token, params);
  const calls = Array.isArray(params) && Array.isArray(params[0]) ? params[0] : [];
  return [calls.map((c) => ({ methodName: c.methodName, params: withToken(token, c.params) }))];
}

export async function call(instanceUrl, secret, method, params = []) {
  nextId += 1;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);
  let response;
  let text;
  try {
    response = await globalThis.fetch(`${instanceUrl}/jsonrpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params: placeToken(secret, method, params) }),
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    text = await response.text();
  } catch {
    if (timedOut) throw new RpcError('timeout', `no answer within ${TIMEOUT_MS / 1000} s`);
    throw new RpcError('network', 'network error');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = text === '' ? null : JSON.parse(text);
  } catch {
    data = null;
  }
  if (data && typeof data === 'object' && data.error && typeof data.error === 'object') {
    const message = typeof data.error.message === 'string' ? data.error.message : 'error';
    throw new RpcError('rpc', message, { status: response.status, code: Number(data.error.code) });
  }
  if (!response.ok || !data || typeof data !== 'object' || !('result' in data)) {
    throw new RpcError('http', `HTTP ${response.status}`, { status: response.status });
  }
  return data.result;
}

// calls = [{methodName, params}], params without the token.
export function multicall(instanceUrl, secret, calls) {
  return call(instanceUrl, secret, 'system.multicall', [calls]);
}
