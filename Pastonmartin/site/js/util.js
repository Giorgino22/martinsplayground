// Kleine Helfer, die alle Teile der Seite brauchen.

// Zahlen schön formatieren (Schweizer Schreibweise)
export const pct = (x, digits = 1) => x == null ? '–' : `${(x * 100).toFixed(digits)} %`;
export const signedPct = (x, digits = 1) => x == null ? '–' : `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)} %`;
export const num = (x, digits = 2) => x == null ? '–' : x.toFixed(digits);
export const chf = (x) => `CHF ${Math.round(x).toLocaleString('de-CH')}`;

// "2,15" oder "2.15" -> 2.15
export function parseOdds(text) {
  const value = parseFloat(String(text).replace(',', '.'));
  return value > 1 ? value : null;
}

// Gegen HTML-Einschleusung: Text aus Daten nie roh in innerHTML stecken.
export function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const ZURICH = 'Europe/Zurich';
export function formatDay(isoDate) {
  return new Date(isoDate + 'T12:00:00Z').toLocaleDateString('de-CH', { weekday: 'long', day: 'numeric', month: 'long', timeZone: ZURICH });
}
export function formatTime(iso) {
  return iso ? new Date(iso).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit', timeZone: ZURICH }) : '';
}
export function formatStamp(iso) {
  return new Date(iso).toLocaleString('de-CH', { dateStyle: 'short', timeStyle: 'short', timeZone: ZURICH });
}

// Lädt eine JSON-Datei. Gibt null zurück, wenn es sie (noch) nicht gibt.
export async function loadJson(path) {
  try {
    const response = await fetch(path, { cache: 'no-cache' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

// localStorage kann im privaten Modus fehlen oder Fehler werfen, darum immer mit try/catch.
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem('pm.' + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem('pm.' + key, JSON.stringify(value)); } catch { /* egal */ }
  },
};

// Einsatz nach Bruchteil-Kelly: Anteil vom Budget, mit Obergrenze.
export function kellyStake(prob, odds, fraction, cap) {
  const full = (prob * odds - 1) / (odds - 1);
  return Math.min(Math.max(full * fraction, 0), cap);
}
