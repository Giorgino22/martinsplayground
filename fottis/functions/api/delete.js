// Delete an entire folder. Only works with the creator's delete token (POST {folderId, deleteToken}).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const sha256 = async s => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); };

export async function onRequestPost({ env, request }) {
  const { folderId, deleteToken } = await request.json();
  if (!folderId || !deleteToken) return json({ error: 'missing' }, 400);
  const meta = await env.BUCKET.get(`${folderId}/_meta.json`);
  if (!meta) return json({ error: 'gone' }, 404);
  const { tokenHash } = await meta.json();
  if (await sha256(deleteToken) !== tokenHash) return json({ error: 'forbidden' }, 403);

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
