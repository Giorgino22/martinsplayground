// Stream a single file from R2 (GET ?key=...&download=1). Supports range requests for video.
export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const dl = url.searchParams.get('download');
  if (!key) return new Response('missing key', { status: 400 });

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
  headers.set('cache-control', 'private, max-age=3600');
  const fn = (obj.customMetadata?.filename || 'file').replace(/"/g, '');
  if (dl) headers.set('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fn)}`);

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
