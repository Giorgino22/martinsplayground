// Finish a multipart upload (POST {key, uploadId, parts:[{partNumber, etag}]}).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

export async function onRequestPost({ env, request }) {
  const { key, uploadId, parts } = await request.json();
  if (!key || !uploadId || !Array.isArray(parts)) return json({ error: 'missing' }, 400);
  const mp = env.BUCKET.resumeMultipartUpload(key, uploadId);
  await mp.complete(parts.map(p => ({ partNumber: p.partNumber, etag: p.etag })));
  return json({ ok: true });
}
