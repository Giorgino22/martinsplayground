// Global aura scores (binding: DB = D1 database).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const CHARS = ['Batman', 'Hulk', 'Ironman', 'Rocket Racoon'];
const START = 67;

async function ensure(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS aura (name TEXT PRIMARY KEY, value INTEGER NOT NULL)').run();
  const ins = env.DB.prepare('INSERT OR IGNORE INTO aura (name, value) VALUES (?, ?)');
  await env.DB.batch(CHARS.map(c => ins.bind(c, START)));
}

async function all(env) {
  const { results } = await env.DB.prepare('SELECT name, value FROM aura').all();
  return results;
}

export async function onRequestGet({ env }) {
  await ensure(env);
  return json({ aura: await all(env) });
}

export async function onRequestPost({ env, request }) {
  await ensure(env);
  const { name, delta } = await request.json().catch(() => ({}));
  if (!CHARS.includes(name) || ![10, -10].includes(delta)) return json({ error: 'bad request' }, 400);
  await env.DB.prepare('UPDATE aura SET value = value + ? WHERE name = ?').bind(delta, name).run();
  return json({ aura: await all(env) });
}
