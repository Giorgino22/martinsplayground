// Reset the game (POST): all heroes back to 67, bonus % cleared, all quests un-completed.
// Uploaded videos are kept (use the ✕ on a hero to remove a video).
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
const CHARS = ['Batman', 'Hulk', 'Ironman', 'Rocket Racoon'];

export async function onRequestPost({ env }) {
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS aura (name TEXT PRIMARY KEY, value INTEGER NOT NULL, has_video INTEGER NOT NULL DEFAULT 0, bonus_pct INTEGER NOT NULL DEFAULT 0)').run();
  try { await env.DB.prepare('ALTER TABLE aura ADD COLUMN has_video INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* exists */ }
  try { await env.DB.prepare('ALTER TABLE aura ADD COLUMN bonus_pct INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* exists */ }
  const ins = env.DB.prepare('INSERT OR IGNORE INTO aura (name, value, has_video, bonus_pct) VALUES (?, 67, 0, 0)');
  await env.DB.batch(CHARS.map(c => ins.bind(c)));
  await env.DB.prepare('UPDATE aura SET value = 67, bonus_pct = 0').run();

  await env.DB.prepare('CREATE TABLE IF NOT EXISTS quests (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, title TEXT NOT NULL, amount INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0, completed_by TEXT)').run();
  try { await env.DB.prepare('ALTER TABLE quests ADD COLUMN completed INTEGER NOT NULL DEFAULT 0').run(); } catch (e) { /* exists */ }
  try { await env.DB.prepare('ALTER TABLE quests ADD COLUMN completed_by TEXT').run(); } catch (e) { /* exists */ }
  await env.DB.prepare('UPDATE quests SET completed = 0, completed_by = NULL').run();

  const aura = (await env.DB.prepare('SELECT name, value, has_video, bonus_pct FROM aura').all()).results;
  const quests = (await env.DB.prepare('SELECT id, category, title, amount, completed, completed_by FROM quests ORDER BY id').all()).results;
  return json({ aura, quests });
}
