// List all files in a folder (GET ?f=folderId).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

export async function onRequestGet({ env, request }) {
  const id = new URL(request.url).searchParams.get('f');
  if (!id) return json({ error: 'missing' }, 400);
  const files = [];
  let cursor;
  do {
    const l = await env.BUCKET.list({ prefix: `${id}/`, cursor, include: ['customMetadata', 'httpMetadata'] });
    for (const o of l.objects) {
      if (o.key.endsWith('/_meta.json')) continue;
      files.push({
        key: o.key,
        size: o.size,
        uploaded: o.uploaded,
        filename: o.customMetadata?.filename || o.key.split('__').slice(1).join('__'),
        contentType: o.httpMetadata?.contentType || ''
      });
    }
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  files.sort((a, b) => new Date(a.uploaded) - new Date(b.uploaded));
  return json({ files });
}
