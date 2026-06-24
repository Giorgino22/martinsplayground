// Delete an entire folder. Owner only: requires the admin password (POST {folderId, adminKey}).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

export async function onRequestPost({ env, request }) {
  const { folderId, adminKey } = await request.json().catch(() => ({}));
  if (!folderId) return json({ error: 'missing' }, 400);
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);

  let cursor;
  const keys = [];
  do {
    const l = await env.BUCKET.list({ prefix: `${folderId}/`, cursor });
    keys.push(...l.objects.map(o => o.key));
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  for (let i = 0; i < keys.length; i += 1000) await env.BUCKET.delete(keys.slice(i, i + 1000));
  return json({ ok: true });
}
