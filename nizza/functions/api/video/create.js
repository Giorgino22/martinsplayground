// Start a hero video upload (POST {name, contentType}) -> {key, uploadId}.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const CHARS = ['Batman', 'Hulk', 'Ironman', 'Rocket Racoon'];
const slug = n => n.replace(/\s+/g, '_');

export async function onRequestPost({ env, request }) {
  const { name, contentType } = await request.json().catch(() => ({}));
  if (!CHARS.includes(name)) return json({ error: 'bad name' }, 400);
  const key = 'videos/' + slug(name);
  const mp = await env.BUCKET.createMultipartUpload(key, { httpMetadata: { contentType: contentType || 'video/mp4' } });
  return json({ key, uploadId: mp.uploadId });
}
