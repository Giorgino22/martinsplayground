// Remove a hero's video (POST {name}): delete from R2 and clear the boost flag.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const CHARS = ['Batman', 'Hulk', 'Ironman', 'Rocket Racoon'];
const slug = n => n.replace(/\s+/g, '_');

export async function onRequestPost({ env, request }) {
  const { name } = await request.json().catch(() => ({}));
  if (!CHARS.includes(name)) return json({ error: 'bad name' }, 400);
  await env.BUCKET.delete('videos/' + slug(name));
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS aura (name TEXT PRIMARY KEY, value INTEGER NOT NULL, has_video INTEGER NOT NULL DEFAULT 0, bonus_pct INTEGER NOT NULL DEFAULT 0)').run();
  await env.DB.prepare('UPDATE aura SET has_video = 0 WHERE name = ?').bind(name).run();
  return json({ ok: true });
}
