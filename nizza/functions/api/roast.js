// Roast an uploaded photo. Body = raw JPEG bytes. Uses Workers AI (binding: AI).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

export async function onRequestPost({ env, request }) {
  try {
    const buf = await request.arrayBuffer();
    if (!buf || buf.byteLength === 0) return json({ error: 'no image' }, 400);
    const bytes = [...new Uint8Array(buf)];

    // 1) Vision model looks at the photo and describes it.
    const desc = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      image: bytes,
      prompt: 'Describe this photo precisely: the person, their face, expression, hair, clothing, pose and the background. Be specific and brutally honest.',
      max_tokens: 300
    });
    const description = (desc && (desc.description || desc.response)) || 'eine Person auf einem Foto';

    // 2) Text model turns the description into a savage (but playful) roast.
    const roast = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'Du bist ein gnadenloser, urkomischer Roast-Comedian unter Freunden. Mach dich brutal aber spielerisch über die Person lustig – maximaler Schaden, aber es bleibt ein Spass. Antworte auf Deutsch (gern ein bisschen Schweizerdeutsch), 3 bis 5 freche Sätze, ohne Vorrede.' },
        { role: 'user', content: `Roaste diese Person knallhart anhand dieser Beschreibung: ${description}` }
      ],
      max_tokens: 400
    });

    return json({ roast: (roast.response || '').trim() });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
