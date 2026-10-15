// The Cloudflare Worker for Humm.
// Every request comes in here first: /api/identify goes to the song finder,
// everything else (the page itself) is served from the public/ folder.
import { onRequestPost as identify } from './identify.js';

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === '/api/identify') {
      if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
      return identify({ env, request });
    }

    // env.ASSETS is the public/ folder (configured in wrangler.jsonc).
    return env.ASSETS.fetch(request);
  },
};
