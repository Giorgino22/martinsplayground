// Stream a hero video (GET ?name=). Supports range requests for seeking/playback.
const CHARS = ['Batman', 'Hulk', 'Ironman', 'Rocket Racoon'];
const slug = n => n.replace(/\s+/g, '_');

export async function onRequestGet({ env, request }) {
  const name = new URL(request.url).searchParams.get('name');
  if (!CHARS.includes(name)) return new Response('bad name', { status: 400 });
  const key = 'videos/' + slug(name);

  const rangeHeader = request.headers.get('range');
  let options = {};
  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (m) {
      const s = m[1] ? +m[1] : undefined, e = m[2] ? +m[2] : undefined;
      if (s !== undefined && e !== undefined) options.range = { offset: s, length: e - s + 1 };
      else if (s !== undefined) options.range = { offset: s };
      else if (e !== undefined) options.range = { suffix: e };
    }
  }

  const obj = await env.BUCKET.get(key, options);
  if (!obj) return new Response('not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('etag', obj.httpEtag);
  headers.set('accept-ranges', 'bytes');
  if (obj.range && rangeHeader) {
    const off = obj.range.offset || 0;
    const len = obj.range.length ?? (obj.size - off);
    headers.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    headers.set('content-length', String(len));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set('content-length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}
