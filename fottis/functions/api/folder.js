// Create a folder (POST) or check if one exists (GET ?f=).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const rid = n => { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };
const sha256 = async s => { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join(''); };

export async function onRequestPost({ env }) {
  const folderId = rid(10);          // 20 hex chars, unguessable
  const deleteToken = rid(16);       // creator's private delete key
  await env.BUCKET.put(`${folderId}/_meta.json`,
    JSON.stringify({ created: Date.now(), tokenHash: await sha256(deleteToken) }),
    { httpMetadata: { contentType: 'application/json' } });
  return json({ folderId, deleteToken });
}

export async function onRequestGet({ env, request }) {
  const id = new URL(request.url).searchParams.get('f');
  if (!id) return json({ error: 'missing' }, 400);
  const h = await env.BUCKET.head(`${id}/_meta.json`);
  return json({ exists: !!h });
}
