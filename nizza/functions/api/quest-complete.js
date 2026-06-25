// Complete a quest (POST {id, heroes:[names]}). Awards aura (boosted) or battle-pass % to each hero.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const CHARS = ['Batman', 'Hulk', 'Ironman', 'Rocket Racoon'];

async function ensureAura(env) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS aura (name TEXT PRIMARY KEY, value INTEGER NOT NULL, has_video INTEGER NOT NULL DEFAULT 0, bonus_pct INTEGER NOT NULL DEFAULT 0)').run();
  const ins = env.DB.prepare('INSERT OR IGNORE INTO aura (name, value, has_video, bonus_pct) VALUES (?, 67, 0, 0)');
  await env.DB.batch(CHARS.map(c => ins.bind(c)));
}

export async function onRequestPost({ env, request }) {
  await ensureAura(env);
  const { id, heroes } = await request.json().catch(() => ({}));
  const picked = Array.isArray(heroes) ? heroes.filter(h => CHARS.includes(h)) : [];
  if (!id || picked.length === 0) return json({ error: 'missing' }, 400);

  const quest = await env.DB.prepare('SELECT category, amount FROM quests WHERE id = ?').bind(id).first();
  if (!quest) return json({ error: 'no quest' }, 404);

  for (const name of picked) {
    if (quest.category === 'battlepass') {
      await env.DB.prepare('UPDATE aura SET bonus_pct = bonus_pct + ? WHERE name = ?').bind(quest.amount, name).run();
    } else {
      const row = await env.DB.prepare('SELECT has_video, bonus_pct FROM aura WHERE name = ?').bind(name).first();
      const pct = (row && row.has_video ? 10 : 0) + (row ? row.bonus_pct : 0);
      const d = Math.round(quest.amount * (1 + pct / 100));
      await env.DB.prepare('UPDATE aura SET value = value + ? WHERE name = ?').bind(d, name).run();
    }
  }

  const { results } = await env.DB.prepare('SELECT name, value, has_video, bonus_pct FROM aura').all();
  return json({ aura: results });
}
