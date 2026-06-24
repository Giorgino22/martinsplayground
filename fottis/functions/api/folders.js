// List ALL folders for the home page (GET). One scan, grouped by folder.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

export async function onRequestGet({ env }) {
  const map = new Map();
  let cursor;
  do {
    const l = await env.BUCKET.list({ cursor, include: ['customMetadata', 'httpMetadata'] });
    for (const o of l.objects) {
      const i = o.key.indexOf('/');
      if (i < 0) continue;
      const fid = o.key.slice(0, i);
      const rest = o.key.slice(i + 1);
      let f = map.get(fid);
      if (!f) { f = { folderId: fid, name: '', created: 0, count: 0, cover: null }; map.set(fid, f); }
      if (rest === '_meta.json') {
        f.name = o.customMetadata?.name || '';
        f.created = o.uploaded ? new Date(o.uploaded).getTime() : 0;
      } else {
        f.count++;
        const ct = o.httpMetadata?.contentType || '';
        const fn = o.customMetadata?.filename || rest;
        if (!f.cover && (ct.startsWith('image/') || /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(fn))) f.cover = o.key;
      }
    }
    cursor = l.truncated ? l.cursor : undefined;
  } while (cursor);
  const folders = [...map.values()].sort((a, b) => b.created - a.created);
  return json({ folders });
}
