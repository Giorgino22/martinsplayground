// Roast an uploaded photo. Body = raw JPEG bytes. Uses Workers AI (binding: AI).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

function run(env, bytes) {
  const messages = [
    { role: 'system', content: 'Du bist ein gnadenloser, urkomischer Roast-Comedian unter Freunden. Schau dir das Foto an und mach dich brutal aber spielerisch über die Person lustig – maximaler Schaden, aber es bleibt ein Spass. Antworte auf Deutsch (gern Schweizerdeutsch), 3 bis 5 freche Sätze, ohne Vorrede.' },
    { role: 'user', content: 'Roaste die Person auf diesem Foto.' }
  ];
  return env.AI.run(MODEL, { messages, image: bytes, max_tokens: 400 });
}

export async function onRequestPost({ env, request }) {
  try {
    const buf = await request.arrayBuffer();
    if (!buf || buf.byteLength === 0) return json({ error: 'no image' }, 400);
    const bytes = [...new Uint8Array(buf)];

    let r;
    try {
      r = await run(env, bytes);
    } catch (e) {
      // Llama vision needs a one-time Meta license acceptance per account.
      if (/agree|license|terms|consent/i.test(String(e))) {
        await env.AI.run(MODEL, { prompt: 'agree' });
        r = await run(env, bytes);
      } else {
        throw e;
      }
    }
    return json({ roast: (r.response || '').trim() || '🤷 Kein Roast.' });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
