// Create a folder (POST {name, adminKey}) -> {folderId}. Owner only.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const rid = n => { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };

export async function onRequestPost({ env, request }) {
  const { name, adminKey } = await request.json().catch(() => ({}));
  if (!env.ADMIN_KEY || adminKey !== env.ADMIN_KEY) return json({ error: 'forbidden' }, 403);
  const folderId = rid(10);
  await env.BUCKET.put(`${folderId}/_meta.json`,
    JSON.stringify({ created: Date.now(), name: name || '' }),
    { httpMetadata: { contentType: 'application/json' }, customMetadata: { name: String(name || '').slice(0, 100) } });
  return json({ folderId });
}
