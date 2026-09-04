import { codeMatches, codeLength, makeToken, setCookie, clearCookie } from './_auth.js';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

export async function onRequest(context) {
  const { request, env } = context;

  // Wie viele Felder gehören zum Code — damit die Seite weiss, wann sie absenden soll.
  if (request.method === 'GET') {
    return new Response(JSON.stringify({ len: codeLength(env) }), { headers: JSON_HEADERS });
  }

  if (request.method === 'DELETE') {
    return new Response(JSON.stringify({ ok: true }), {
      headers: Object.assign({ 'set-cookie': clearCookie() }, JSON_HEADERS)
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers: JSON_HEADERS });
  }

  let body = {};
  try { body = await request.json(); } catch (e) { /* leerer Rumpf ist einfach falsch */ }

  if (!codeMatches(body.code, env)) {
    // Bremst automatisches Durchprobieren spürbar aus.
    await new Promise(function (r) { setTimeout(r, 900); });
    return new Response(JSON.stringify({ ok: false }), { status: 401, headers: JSON_HEADERS });
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: Object.assign({ 'set-cookie': setCookie(await makeToken(env)) }, JSON_HEADERS)
  });
}
