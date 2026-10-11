// Copyright (c) 2026 dta0one
//
// WebCrypto only, so the extension and `node --test` load the same module.

const VERSION = 1;
const ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// The passphrase is trimmed (as isPassphrase reads it) and NFC-normalized, so
// the same words typed on another keyboard derive the same key.
export async function deriveKey(passphrase, salt, iterations) {
  const { subtle } = globalThis.crypto;
  const material = await subtle.importKey(
    'raw',
    encoder.encode(passphrase.trim().normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function seal(secret, passphrase) {
  const { subtle } = globalThis.crypto;
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(secret));
  return {
    v: VERSION,
    iterations: ITERATIONS,
    salt: toBase64(salt),
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ct)),
  };
}

// A wrong passphrase rejects: the AES-GCM tag check fails.
export async function open(record, passphrase) {
  if (!record || record.v !== VERSION || !Number.isInteger(record.iterations) || record.iterations < 1) {
    throw new Error('not a vault record');
  }
  const key = await deriveKey(passphrase, fromBase64(record.salt), record.iterations);
  const plain = await globalThis.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(record.iv) },
    key,
    fromBase64(record.ct),
  );
  return decoder.decode(plain);
}

// One to three words separated by single spaces, after trimming.
export function isPassphrase(text) {
  return typeof text === 'string' && /^\S+(?: \S+){0,2}$/u.test(text.trim());
}
