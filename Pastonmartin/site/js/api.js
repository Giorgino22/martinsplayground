// Abfragen an The Odds API, über unsere Cloudflare-Function (functions/api/odds.js).
import { store } from './util.js';

// Holt Quoten oder Spiellisten, z.B. fetchOdds('sport=soccer_epl') oder fetchOdds('events=soccer_epl')
export async function fetchOdds(query) {
  let response;
  try {
    response = await fetch(`/api/odds?${query}`, { headers: { 'x-journal-key': store.get('journalKey', '') } });
  } catch {
    throw new Error('Keine Verbindung.');
  }
  if (!(response.headers.get('content-type') || '').includes('json')) {
    throw new Error('Live-Quoten gibt es nur auf der echten Website (Cloudflare).');
  }
  const body = await response.json();
  if (response.status === 401) throw new Error('Schlüssel nötig: im Tagebuch eingeben.');
  if (!response.ok) throw new Error(body.error || `Fehler ${response.status}`);
  return body;
}
