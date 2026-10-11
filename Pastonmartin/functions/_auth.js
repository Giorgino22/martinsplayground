// Anmeldung für die ganze App (gleiche Idee wie beim Familienkalender, hater/functions/api/_auth.js).
//
// Wer das richtige Passwort eingibt, bekommt ein signiertes Cookie (HMAC), das 180 Tage gilt.
// Geprüft wird auf dem Server (in _middleware.js): Ohne gültiges Cookie liefert Cloudflare
// weder die Seite noch die Daten noch die Schnittstellen aus.
//
// In Cloudflare setzen: SITE_PASSWORD (dein Passwort) und SESSION_SECRET (lange Zufallsfolge).
// Neues SESSION_SECRET = alle Geräte sind abgemeldet.

const COOKIE = 'pm_auth';
const MAX_AGE = 180 * 24 * 3600;

const secretOf = env => String(env.SESSION_SECRET || `pastonmartin:${env.SITE_PASSWORD}`);

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

// Vergleich ohne Zeitunterschied, damit man sich nicht Zeichen für Zeichen herantasten kann
function safeEqual(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const passwordMatches = (input, env) => safeEqual(String(input || ''), String(env.SITE_PASSWORD));

export async function makeToken(env) {
  const expires = String(Date.now() + MAX_AGE * 1000);
  return `${expires}.${await hmac(expires, secretOf(env))}`;
}

export async function isAuthed(request, env) {
  const match = (request.headers.get('cookie') || '').match(/(?:^|;\s*)pm_auth=([^;]+)/);
  if (!match) return false;
  const [expires, signature] = match[1].split('.');
  if (!/^\d+$/.test(expires || '') || Number(expires) < Date.now()) return false;
  return safeEqual(signature || '', await hmac(expires, secretOf(env)));
}

export const setCookie = token => `${COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
export const clearCookie = () => `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
