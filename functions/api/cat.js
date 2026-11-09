// POST /api/cat - Neo the deck cat, as a Cloudflare Pages Function.
//
// Contract (client widget in index.html):
//   in : { message: string, history?: [{role, content}...], session?: string }
//   out: 200 { reply: string, session: string }
//        429 { error: 'budget', reply: string }  - per-identity daily cap hit
//        502 { error: 'upstream' }               - LLM upstream failed; widget falls back to its local brain
//        405 / 400 for wrong method / bad body
//
// Abuse control follows the antiRea budget law: meter per identity, cap per day,
// 429 when exceeded. Counter storage: Turso (env TURSO_URL + TURSO_TOKEN) when set,
// otherwise an in-memory map (per isolate - acceptable fallback, documented in NEO-API.md).
//
// Upstream is any OpenAI-compatible chat endpoint, configured by env only:
//   CAT_API_BASE  e.g. https://api.sambanova.ai/v1   (no trailing slash)
//   CAT_API_KEY   secret, set in Pages project env (encrypted)
//   CAT_MODEL     e.g. fast-text (default)

import { NEO_SYSTEM, NEO_POST_HISTORY, NEO_FIRST_MES } from '../_neo-persona.js';

const DAILY_CAP = 40;              // messages per identity per day
const MAX_MSG = 500;               // chars per visitor message
const MAX_HISTORY = 6;             // turns resent to the model
const UPSTREAM_TIMEOUT_MS = 25000;

const memStore = new Map();        // fallback counter: key -> {day, count}

function json(body, status, extraHeaders) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}),
  });
}

async function sha256hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function dayKey() {
  // Asia/Bangkok day boundary for the budget window.
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  return s; // YYYY-MM-DD
}

async function tursoExec(env, sql, args) {
  const res = await fetch(env.TURSO_URL.replace(/\/$/, '') + '/v2/pipeline', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + env.TURSO_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [
      { type: 'execute', stmt: { sql, args: (args || []).map(v => ({ type: 'text', value: String(v) })) } },
      { type: 'close' },
    ] }),
  });
  if (!res.ok) throw new Error('turso ' + res.status);
  return res.json();
}

async function bumpBudget(env, identity) {
  const day = dayKey();
  if (env.TURSO_URL && env.TURSO_TOKEN) {
    await tursoExec(env,
      'CREATE TABLE IF NOT EXISTS neo_budget (day TEXT, identity TEXT, count INTEGER, PRIMARY KEY (day, identity))');
    await tursoExec(env,
      'INSERT INTO neo_budget (day, identity, count) VALUES (?, ?, 1) ' +
      'ON CONFLICT(day, identity) DO UPDATE SET count = count + 1', [day, identity]);
    const out = await tursoExec(env, 'SELECT count FROM neo_budget WHERE day = ? AND identity = ?', [day, identity]);
    const rows = out.results[0].response.result.rows;
    return rows.length ? Number(rows[0][0].value) : 1;
  }
  const key = day + ':' + identity;
  const cur = memStore.get(key) || { day, count: 0 };
  cur.count += 1; memStore.set(key, cur);
  return cur.count;
}

function shapeReply(text) {
  let t = String(text || '').trim();
  t = t.replace(/\|[^\n]*\|/g, '');            // strip markdown table rows if the model slips
  if (t.length > 700) {                        // cap at a sentence boundary near 700 chars
    const cut = t.slice(0, 700);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    t = (end > 200 ? cut.slice(0, end + 1) : cut).trim();
  }
  return t;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }
  const message = String(body.message || '').slice(0, MAX_MSG).trim();
  if (!message) return json({ error: 'empty' }, 400);

  // Identity: first-party cookie, else a hash of IP + UA. Never third-party fingerprinting.
  const cookie = request.headers.get('Cookie') || '';
  let session = String(body.session || '').slice(0, 64);
  const m = cookie.match(/neo_id=([a-zA-Z0-9-]{8,64})/);
  if (!session) session = m ? m[1] : '';
  const headers = {};
  if (!session) {
    session = crypto.randomUUID();
    headers['Set-Cookie'] = 'neo_id=' + session + '; Path=/; Max-Age=2592000; SameSite=Lax; Secure; HttpOnly';
  }
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const identity = await sha256hex(session + '|' + ip);

  let count;
  try { count = await bumpBudget(env, identity); }
  catch (e) { count = 1; } // metering store hiccup must not kill the cat
  if (count > DAILY_CAP) {
    return json({ error: 'budget', session,
      reply: 'Prr, hôm nay tớ tiếp khách quá đà rồi, cổ họng khàn mất. Mai bạn quay lại nhé - hoặc mở kênh liên hệ ở cuối trang, Danny trả lời trực tiếp luôn.' }, 429, headers);
  }

  if (!env.CAT_API_BASE || !env.CAT_API_KEY) return json({ error: 'upstream' }, 502, headers);

  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY)
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
    .map(h => ({ role: h.role, content: h.content.slice(0, 600) })) : [];

  const messages = [{ role: 'system', content: NEO_SYSTEM }]
    .concat(history)
    .concat([{ role: 'user', content: message }])
    .concat([{ role: 'system', content: NEO_POST_HISTORY }]);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(env.CAT_API_BASE.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + env.CAT_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: env.CAT_MODEL || 'fast-text', temperature: 0.7,
        max_tokens: 320, messages }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return json({ error: 'upstream' }, 502, headers);
    const data = await res.json();
    const reply = shapeReply(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
    if (!reply) return json({ error: 'upstream' }, 502, headers);
    return json({ reply, session }, 200, headers);
  } catch (e) {
    clearTimeout(timer);
    return json({ error: 'upstream' }, 502, headers);
  }
}

export async function onRequestGet() {
  return json({ cat: 'Neo', awake: true, greeting: NEO_FIRST_MES });
}
