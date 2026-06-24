// Check the admin password (POST {adminKey}) -> {ok}. Used to unlock delete buttons on the owner's device.
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

export async function onRequestPost({ env, request }) {
  const { adminKey } = await request.json().catch(() => ({}));
  return json({ ok: !!env.ADMIN_KEY && adminKey === env.ADMIN_KEY });
}
