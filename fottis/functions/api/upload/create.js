// Start a multipart upload (POST {folderId, filename, contentType}) -> {key, uploadId}.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const rid = n => { const b = new Uint8Array(n); crypto.getRandomValues(b); return [...b].map(x => x.toString(16).padStart(2, '0')).join(''); };

export async function onRequestPost({ env, request }) {
  const { folderId, filename, contentType } = await request.json();
  if (!folderId || !filename) return json({ error: 'missing' }, 400);
  const meta = await env.BUCKET.head(`${folderId}/_meta.json`);
  if (!meta) return json({ error: 'no folder' }, 404);

  const fileId = rid(6);
  const safe = String(filename).replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const key = `${folderId}/${fileId}__${safe}`;
  const mp = await env.BUCKET.createMultipartUpload(key, {
    httpMetadata: { contentType: contentType || 'application/octet-stream' },
    customMetadata: { filename: String(filename).slice(0, 200) }
  });
  return json({ key, uploadId: mp.uploadId });
}
