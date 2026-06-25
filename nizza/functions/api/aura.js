// Global aura scores (binding: DB = D1). Heroes with a video get +10% on positive gains.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const CHARS = ['Batman', 'Hulk', 'Ironman', 'Rocket Racoon'];
const START = 67;

async function ensure(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS aura (name TEXT PRIMARY KEY, value INTEGER NOT NULL, has_video INTEGER NOT NULL DEFAULT 0)').run();
  try { await env.DB.prepare('ALTER TABLE aura ADD COLUMN has_video INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* column already exists */ }
  const ins = env.DB.prepare('INSERT OR IGNORE INTO aura (name, value, has_video) VALUES (?, ?, 0)');
  await env.DB.batch(CHARS.map(c => ins.bind(c, START)));
}

async function all(env) {
  const { results } = await env.DB.prepare('SELECT name, value, has_video FROM aura').all();
  return results;
}

export async function onRequestGet({ env }) {
  await ensure(env);
  return json({ aura: await all(env) });
}

export async function onRequestPost({ env, request }) {
  await ensure(env);
  const { name, delta } = await request.json().catch(() => ({}));
  if (!CHARS.includes(name)) return json({ error: 'bad name' }, 400);
  let d = Math.trunc(Number(delta));
  if (!Number.isFinite(d) || d === 0) return json({ error: 'bad delta' }, 400);
  d = Math.max(-1000000, Math.min(1000000, d));

  const row = await env.DB.prepare('SELECT has_video FROM aura WHERE name = ?').bind(name).first();
  if (row && row.has_video && d > 0) d = Math.round(d * 1.1);   // video boost on gains

  await env.DB.prepare('UPDATE aura SET value = value + ? WHERE name = ?').bind(d, name).run();
  return json({ aura: await all(env) });
}
