// Wett-Tagebuch in Cloudflare D1.
//
//   GET    /api/bets           alle Wetten
//   PUT    /api/bets           eine Wette speichern (neu oder ändern), JSON im Body
//   DELETE /api/bets?id=...    eine Wette löschen
//
// Einrichten in Cloudflare Pages: D1-Datenbank als Binding "DB" verbinden.
// Optional: Variable JOURNAL_KEY setzen, dann braucht es diesen Schlüssel zum Lesen/Schreiben.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function onRequest({ request, env }) {
  if (!env.DB) return json({ error: 'D1 ist nicht eingerichtet (Binding "DB" fehlt)' }, 503);
  if (env.JOURNAL_KEY && request.headers.get('x-journal-key') !== env.JOURNAL_KEY) {
    return json({ error: 'Falscher Schlüssel' }, 401);
  }

  // Tabelle beim ersten Aufruf anlegen. Jede Wette wird als JSON-Text gespeichert,
  // so muss die Datenbank nicht angepasst werden, wenn eine Wette neue Felder bekommt.
  await env.DB.exec('CREATE TABLE IF NOT EXISTS bets (id TEXT PRIMARY KEY, created TEXT, data TEXT)');

  if (request.method === 'GET') {
    const { results } = await env.DB.prepare('SELECT data FROM bets ORDER BY created DESC').all();
    return json({ bets: results.map(row => JSON.parse(row.data)) });
  }

  if (request.method === 'PUT') {
    const bet = await request.json().catch(() => null);
    if (!bet || typeof bet.id !== 'string' || !(bet.odds > 1) || !(bet.stake > 0)) {
      return json({ error: 'Ungültige Wette' }, 400);
    }
    await env.DB.prepare('INSERT OR REPLACE INTO bets (id, created, data) VALUES (?, ?, ?)')
      .bind(bet.id, bet.created || new Date().toISOString(), JSON.stringify(bet))
      .run();
    return json({ ok: true });
  }

  if (request.method === 'DELETE') {
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return json({ error: 'id fehlt' }, 400);
    await env.DB.prepare('DELETE FROM bets WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'Methode nicht erlaubt' }, 405);
}
