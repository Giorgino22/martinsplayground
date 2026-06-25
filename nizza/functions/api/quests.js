// Quests (binding: DB = D1). GET list, POST create, DELETE ?id remove. Shared globally.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const CATS = ['main', 'giga', 'side', 'battlepass'];

async function ensure(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS quests (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL, amount INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, completed_by TEXT)').run();
  try { await env.DB.prepare('ALTER TABLE quests ADD COLUMN completed INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* exists */ }
  try { await env.DB.prepare('ALTER TABLE quests ADD COLUMN completed_by TEXT').run(); } catch (e) { /* exists */ }
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS c FROM quests').all();
  if (results[0].c === 0) {
    const ins = env.DB.prepare('INSERT INTO quests (category, title, amount) VALUES (?, ?, ?)');
    await env.DB.batch([
      ins.bind('main', 'Rap Battle Winner', 100),
      ins.bind('giga', 'An en taffe ort ihglade werde', 500),
      ins.bind('side', 'Nackt is meer ga bade', 50),
      ins.bind('battlepass', 'Es ganzes Wochenend duremache', 10)
    ]);
  }
}

async function all(env) {
  const { results } = await env.DB.prepare('SELECT id, category, title, amount, completed, completed_by FROM quests ORDER BY id').all();
  return results;
}

export async function onRequestGet({ env }) {
  await ensure(env);
  return json({ quests: await all(env) });
}

export async function onRequestPost({ env, request }) {
  await ensure(env);
  const { category, title, amount } = await request.json().catch(() => ({}));
  if (!CATS.includes(category)) return json({ error: 'bad category' }, 400);
  const t = String(title || '').trim().slice(0, 120);
  const a = Math.trunc(Number(amount));
  if (!t) return json({ error: 'no title' }, 400);
  if (!Number.isFinite(a) || a <= 0) return json({ error: 'bad amount' }, 400);
  await env.DB.prepare('INSERT INTO quests (category, title, amount, completed) VALUES (?, ?, ?, 0)').bind(category, t, a).run();
  return json({ quests: await all(env) });
}

export async function onRequestDelete({ env, request }) {
  await ensure(env);
  const id = parseInt(new URL(request.url).searchParams.get('id'), 10);
  if (!id) return json({ error: 'bad id' }, 400);
  await env.DB.prepare('DELETE FROM quests WHERE id = ?').bind(id).run();
  return json({ quests: await all(env) });
}
