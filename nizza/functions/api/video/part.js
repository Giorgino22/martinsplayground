// Upload one part (PUT ?key=&uploadId=&partNumber=, body = chunk) -> {partNumber, etag}.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

export async function onRequestPut({ env, request }) {
  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  const uploadId = url.searchParams.get('uploadId');
  const partNumber = parseInt(url.searchParams.get('partNumber'), 10);
  if (!key || !uploadId || !partNumber) return json({ error: 'missing' }, 400);
  const mp = env.BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await mp.uploadPart(partNumber, request.body);
  return json({ partNumber, etag: part.etag });
}
