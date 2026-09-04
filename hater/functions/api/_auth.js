/**
 * Zugangsschutz für den Familienkalender.
 *
 * Wichtig: geprüft wird serverseitig. Die Seite selbst enthält keine Termine —
 * die kommen alle von /api/feed, und dieser Endpunkt verlangt das Merkmal.
 * Eine reine Prüfung im Browser wäre wirkungslos, weil man /api/feed einfach
 * direkt aufrufen könnte.
 *
 * Dateien mit _ am Anfang werden von Cloudflare Pages nicht als Route bedient.
 */

const COOKIE = 'fk_auth';
const MAX_AGE = 180 * 24 * 3600;          // ein halbes Jahr, damit niemand ständig tippen muss

/**
 * Zahlencode wie auf dem iPhone. Diese Voreinstellung steht in einem
 * öffentlichen Repository und ist damit kein Geheimnis — SITE_CODE in
 * Cloudflare setzen. Beliebig viele Ziffern, üblich sind vier oder sechs.
 */
const DEFAULT_CODE = '112358';

export function siteCode(env) {
  const c = env && env.SITE_CODE;
  return (c && String(c).trim()) || DEFAULT_CODE;
}

function secretOf(env) {
  const s = env && env.SESSION_SECRET;
  return (s && String(s).trim()) || ('familienkalender:' + siteCode(env));
}

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hmac(message, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** Vergleich ohne Zeitunterschied, damit man sich nicht Zeichen für Zeichen herantasten kann. */
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function codeMatches(input, env) {
  return safeEqual(String(input || '').trim().toLowerCase(), siteCode(env).trim().toLowerCase());
}

/** Anzahl Ziffern — die Seite weiss dadurch, wann sie absenden soll. */
export function codeLength(env) {
  return siteCode(env).trim().length;
}

export async function makeToken(env) {
  const exp = String(Date.now() + MAX_AGE * 1000);
  return exp + '.' + await hmac(exp, secretOf(env));
}

export async function tokenValid(token, env) {
  if (!token) return false;
  const i = String(token).lastIndexOf('.');
  if (i < 1) return false;
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now()) return false;
  return safeEqual(sig, await hmac(exp, secretOf(env)));
}

export function readCookie(request) {
  const m = (request.headers.get('cookie') || '').match(/(?:^|;\s*)fk_auth=([^;]+)/);
  return m ? m[1] : null;
}

export async function isAuthed(request, env) {
  return tokenValid(readCookie(request), env);
}

export function setCookie(token) {
  return COOKIE + '=' + token + '; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=' + MAX_AGE;
}

export function clearCookie() {
  return COOKIE + '=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
}
