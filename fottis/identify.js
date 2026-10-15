// Guess a song from a hummed / sung recording plus text hints, using Gemini.
//
// POST {
//   audio?:  base64 WAV (16 kHz mono, made in the browser),
//   hint?:   "Brazilian, World Cup, lots of long O's",
//   rounds?: [{ answer, feedback }]   // earlier guesses + what the user said about them
// }
// -> { heard, guesses: [{ title, artist, year, confidence, why }], question }
//
// Called from worker.js. Needs the secret GEMINI_API_KEY (Google AI Studio). GEMINI_MODEL is optional.

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });

const MAX_AUDIO_CHARS = 4_000_000; // ~3 MB of WAV, roughly 90 s at 16 kHz. The page stops at 30 s.

const SYSTEM = `You are a music expert who identifies songs from someone humming, whistling,
singing "na na na", or half-remembered lyrics, plus any hints they give.

How to work:
1. Listen closely to the recording: melody shape, rhythm, tempo, vowel sounds, any real words.
2. Combine it with the hints (country, era, event, genre, where they heard it).
3. Return up to 5 REAL, existing songs, most likely first. Never invent songs.
4. confidence is 0-100 and must be honest. Humming is hard; low numbers are fine.
5. In "why", say briefly which part of the melody, rhythm or hint matches.
6. If the user rejects guesses, never suggest those again and use their feedback.
7. If you are unsure, put ONE short question in "question" that would narrow it down
   (e.g. "Was it sung by a man or a woman?"). Otherwise leave it empty.
8. In "heard", describe in one or two sentences what you heard in the recording
   (or say there was no recording). Answer in the user's language.`;

// Tells Gemini to answer with exactly this JSON shape (so we never parse free text).
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    heard: { type: 'STRING' },
    guesses: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' },
          artist: { type: 'STRING' },
          year: { type: 'STRING' },
          confidence: { type: 'INTEGER' },
          why: { type: 'STRING' },
        },
        required: ['title', 'artist', 'confidence', 'why'],
      },
    },
    question: { type: 'STRING' },
  },
  required: ['heard', 'guesses'],
};

export async function onRequestPost({ env, request }) {
  if (!env.GEMINI_API_KEY) return json({ error: 'GEMINI_API_KEY is not set on the Pages project.' }, 500);

  const { audio, hint, rounds } = await request.json().catch(() => ({}));
  if (!audio && !hint) return json({ error: 'Record something or type a hint first.' }, 400);
  if (audio && (typeof audio !== 'string' || audio.length > MAX_AUDIO_CHARS)) return json({ error: 'Recording is too long.' }, 413);

  // First user turn: the recording (if any) + the hints.
  const first = [];
  if (audio) first.push({ inlineData: { mimeType: 'audio/wav', data: audio } });
  first.push({ text: `Hints: ${String(hint || '').slice(0, 1000) || '(none)'}\nWhich song is this?` });
  const contents = [{ role: 'user', parts: first }];

  // Follow-up chat: replay every earlier answer and the user's feedback on it.
  // The API is stateless, so the whole conversation is sent each time.
  for (const r of Array.isArray(rounds) ? rounds.slice(-10) : []) {
    contents.push({ role: 'model', parts: [{ text: JSON.stringify(r.answer ?? {}) }] });
    contents.push({ role: 'user', parts: [{ text: String(r.feedback || '').slice(0, 1000) }] });
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: { responseMimeType: 'application/json', responseSchema: SCHEMA, temperature: 0.4 },
  });

  // Try each model in turn. If one is busy, too slow or not available for this key, move on.
  const errors = []; // one line per model that failed, shown to the user if all fail
  const started = Date.now();
  for (const model of modelsToTry(env)) {
    const timeLeft = TOTAL_LIMIT_MS - (Date.now() - started);
    if (timeLeft < 5000) break; // not enough time left for another try

    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
        body,
        // Give up on this model after a while instead of waiting forever.
        signal: AbortSignal.timeout(Math.min(MODEL_LIMIT_MS, timeLeft)),
      });
    } catch {
      errors.push(`${model}: no answer after ${Math.round((Date.now() - t0) / 1000)} s`);
      console.log(`${model}: timeout after ${Date.now() - t0} ms`);
      continue;
    }
    const data = await res.json().catch(() => ({}));
    console.log(`${model}: status ${res.status} after ${Date.now() - t0} ms`); // visible in Cloudflare logs

    if (!res.ok) {
      const message = data.error?.message || `Gemini error ${res.status}`;
      errors.push(`${model}: ${message}`);
      if (TRY_NEXT.includes(res.status)) continue;
      return json({ error: message }, 502); // e.g. a wrong API key: other models won't help
    }

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
    try {
      const answer = JSON.parse(text);
      answer.guesses = (answer.guesses || []).slice(0, 5);
      answer.model = model;
      return json(answer);
    } catch {
      errors.push(`${model}: answer was not valid JSON`);
    }
  }
  return json({ error: `No model could answer:\n${errors.join('\n')}` }, 502);
}

// How long to wait for one model, and for all tries together.
const MODEL_LIMIT_MS = 45_000;
const TOTAL_LIMIT_MS = 85_000;

// Best first. Newer Flash models are free-tier, fast and understand audio.
// GEMINI_MODEL (optional, set in Cloudflare) is always tried first.
const MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-flash-latest'];

// Status codes where another model might work:
// 404 model doesn't exist, 429 quota used up, 500/503 overloaded, 400 model doesn't support this.
const TRY_NEXT = [400, 404, 429, 500, 503];

function modelsToTry(env) {
  const list = env.GEMINI_MODEL ? [env.GEMINI_MODEL, ...MODELS] : MODELS;
  return [...new Set(list)]; // Set removes duplicates
}
