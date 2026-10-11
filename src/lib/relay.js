// Copyright (c) 2026 dta0one
//
// The calls the popup's queue view may make through the background: ariam's
// status page allowlist. params exclude the token.

const METHODS = new Set([
  'aria2.tellActive',
  'aria2.tellWaiting',
  'aria2.tellStopped',
  'aria2.tellStatus',
  'aria2.getGlobalStat',
  'ariam.getSiteSummary',
  'aria2.pause',
  'aria2.unpause',
  'aria2.remove',
  'aria2.purgeDownloadResult',
]);

const SITE_OPTIONS = new Set(['site-concurrent', 'site-concurrent-default']);

function isStruct(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function siteOptionsOnly(params) {
  return params.length > 0 && isStruct(params[0]) && Object.keys(params[0]).every((key) => SITE_OPTIONS.has(key));
}

function allowedSingle(method, params) {
  if (typeof method !== 'string' || !Array.isArray(params)) return false;
  if (method === 'aria2.changeGlobalOption') return siteOptionsOnly(params);
  return METHODS.has(method);
}

// system.multicall takes one list of {methodName, params?}; every sub-call
// must pass on its own, and a nested system.multicall never does.
export function allowedCall(method, params) {
  if (method !== 'system.multicall') return allowedSingle(method, params);
  if (!Array.isArray(params) || params.length !== 1 || !Array.isArray(params[0])) return false;
  return params[0].every((sub) => isStruct(sub) && allowedSingle(sub.methodName, sub.params ?? []));
}
