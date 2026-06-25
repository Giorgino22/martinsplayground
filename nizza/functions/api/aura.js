// Global aura scores (binding: DB = D1).
// Positive gains are boosted by: video (+10%) + accumulated battle-pass bonus_pct.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const CHARS = ['Batman', 'Hulk', 'Ironman', 'Rocket Racoon'];
const START = 67;

export async function ensureAura(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS aura (name TEXT PRIMARY KEY, value INTEGER NOT NULL, has_video INTEGER NOT NULL DEFAULT 0, bonus_pct INTEGER NOT NULL DEFAULT 0)').run();
  try { await env.DB.prepare('ALTER TABLE aura ADD COLUMN has_video INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* exists */ }
  try { await env.DB.prepare('ALTER TABLE aura ADD COLUMN bonus_pct INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* exists */ }
  const ins = env.DB.prepare('INSERT OR IGNORE INTO aura (name, value, has_video, bonus_pct) VALUES (?, ?, 0, 0)');
  await env.DB.batch(CHARS.map(c => ins.bind(c, START)));
}

async function all(env) {
  const { results } = await env.DB.prepare('SELECT name, value, has_video, bonus_pct FROM aura').all();
  return results;
}

export async function onRequestGet({ env }) {
  await ensureAura(env);
  return json({ aura: await all(env) });
}

export async function onRequestPost({ env, request }) {
  await ensureAura(env);
  const { name, delta } = await request.json().catch(() => ({}));
  if (!CHARS.includes(name)) return json({ error: 'bad name' }, 400);
  let d = Math.trunc(Number(delta));
  if (!Number.isFinite(d) || d === 0) return json({ error: 'bad delta' }, 400);
  d = Math.max(-1000000, Math.min(1000000, d));

  const row = await env.DB.prepare('SELECT has_video, bonus_pct FROM aura WHERE name = ?').bind(name).first();
  const pct = (row && row.has_video ? 10 : 0) + (row ? row.bonus_pct : 0);
  if (d > 0 && pct > 0) d = Math.round(d * (1 + pct / 100));   // boost on gains only

  await env.DB.prepare('UPDATE aura SET value = value + ? WHERE name = ?').bind(d, name).run();
  return json({ aura: await all(env) });
}
