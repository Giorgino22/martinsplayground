// Schützt die ganze App: Ohne Anmeldung gibt es nur die Login-Seite.
// Cloudflare ruft diese Datei vor JEDER Anfrage auf (Seite, Daten, Schnittstellen).
import { passwordMatches, makeToken, isAuthed, setCookie, clearCookie } from './_auth.js';

const page = (body, status = 200, headers = {}) => new Response(loginHtml(body), {
  status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers },
});
const redirect = (to, headers = {}) => new Response(null, { status: 303, headers: { location: to, ...headers } });

export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);

  if (!env.SITE_PASSWORD) {
    return page('<p>Die App ist gesperrt, bis in Cloudflare die Variable <b>SITE_PASSWORD</b> gesetzt ist.</p>', 503);
  }

  if (url.pathname === '/logout') return redirect('/login', { 'set-cookie': clearCookie() });

  if (url.pathname === '/login') {
    if (request.method === 'POST') {
      const form = await request.formData().catch(() => null);
      if (form && passwordMatches(form.get('password'), env)) {
        return redirect('/', { 'set-cookie': setCookie(await makeToken(env)) });
      }
      await new Promise(resolve => setTimeout(resolve, 900));   // bremst automatisches Durchprobieren
      return page(form ? '<p class="error">Falsches Passwort.</p>' + loginForm() : loginForm(), 401);
    }
    return page(loginForm());
  }

  if (await isAuthed(request, env)) {
    const response = await next();
    // Die Daten nie in fremden Zwischenspeichern ablegen
    const headers = new Headers(response.headers);
    headers.set('cache-control', 'private, no-store');
    return new Response(response.body, { status: response.status, headers });
  }

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/data/')) {
    return new Response(JSON.stringify({ error: 'Nicht angemeldet' }), {
      status: 401, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }
  return redirect('/login');
}

const loginForm = () => `
  <form method="post" action="/login">
    <input type="password" name="password" placeholder="Passwort" autocomplete="current-password" autofocus required>
    <button>Anmelden</button>
  </form>`;

const loginHtml = body => `<!DOCTYPE html>
<html lang="de"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Pastonmartin</title>
<style>
  :root { color-scheme: light; --bg: #f6f6f4; --card: #fcfcfb; --line: #e4e3df; --text: #0b0b0b; --accent: #2a78d6; --bad: #c03030; }
  @media (prefers-color-scheme: dark) { :root { color-scheme: dark; --bg: #121211; --card: #1a1a19; --line: #2e2e2b; --text: #f0efec; --accent: #3987e5; --bad: #e66767; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
    font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  main { width: min(340px, calc(100vw - 32px)); background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 24px; }
  h1 { margin: 0 0 16px; font-size: 1.4rem; }
  form { display: flex; flex-direction: column; gap: 10px; }
  input, button { font: inherit; padding: 10px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--bg); color: var(--text); }
  button { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; cursor: pointer; }
  .error { color: var(--bad); margin: 0 0 10px; }
</style></head>
<body><main><h1>Pastonmartin</h1>${body}</main></body></html>`;
