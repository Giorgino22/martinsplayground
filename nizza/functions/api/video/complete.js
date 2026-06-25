// Finish a hero video upload and flag the hero as boosted (POST {name, key, uploadId, parts}).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const CHARS = ['Batman', 'Hulk', 'Ironman', 'Rocket Racoon'];

export async function onRequestPost({ env, request }) {
  const { name, key, uploadId, parts } = await request.json().catch(() => ({}));
  if (!CHARS.includes(name) || !key || !uploadId || !Array.isArray(parts)) return json({ error: 'missing' }, 400);
  const mp = env.BUCKET.resumeMultipartUpload(key, uploadId);
  await mp.complete(parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })));

  await env.DB.prepare('CREATE TABLE IF NOT EXISTS aura (name TEXT PRIMARY KEY, value INTEGER NOT NULL, has_video INTEGER NOT NULL DEFAULT 0)').run();
  await env.DB.prepare('INSERT OR IGNORE INTO aura (name, value, has_video) VALUES (?, 67, 0)').bind(name).run();
  await env.DB.prepare('UPDATE aura SET has_video = 1 WHERE name = ?').bind(name).run();
  return json({ ok: true });
}
