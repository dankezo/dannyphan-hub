// POST /api/cat - Neo the deck cat, as a Cloudflare Pages Function. v2.
//
// Contract (client widget in index.html - unchanged from v1):
//   in : { message: string, history?: [{role, content}...], session?: string }
//   out: 200 { reply: string, session: string }
//        200 { error: 'global_budget', fallback: true, session } - global upstream
//             cap hit or global meter unavailable: no reply field on purpose,
//             the widget treats a reply-less 200 as an error and answers with
//             its local brain (v2). Neo rests upstream, the deck never dies.
//        429 { error: 'budget', reply: string }  - session / IP / burst cap hit
//        200 { error: 'upstream', fallback: true } - LLM upstream failed or no key;
//             same reply-less fallback shape as global_budget (a bare 502 status
//             gets its body replaced by the zone proxy on the custom domain,
//             so the fallback signal travels as a 200 - the widget treats any
//             reply-less response as 'use the local brain' either way)
//        405 / 400 for wrong method / bad body
//
// v2 changes (NEO-UPGRADE-PROPOSAL-2026-11-16.md, Cerebras route approved by Danny):
//   - Upstream default: Cerebras gpt-oss-120b (env can override base/model).
//   - Three meter layers in Turso: session 40/day, IP 60/day, GLOBAL 200/day.
//     The global layer is the bill kill-switch and is FAIL-CLOSED: if Turso
//     is configured but the global counter cannot be bumped, upstream is
//     NOT called. Session/IP layers keep v1's fail-open behaviour via an
//     in-memory fallback (a metering hiccup must not kill the cat).
//   - Burst guard: 6 messages / minute / IP.
//   - Answer cache (Turso neo_cache, TTL 24h, key = sha256 of the normalized
//     question): hits skip upstream and do NOT consume the global cap, but
//     DO count toward session/IP/burst meters (they are still messages).
//   - Token clamps: message 400 chars, history last 4 turns x 300 chars,
//     total input estimate capped at ~1,200 tokens (chars/4, oldest history
//     dropped first), max_tokens 256, reasoning_effort low (gpt-oss is a
//     reasoning model; Neo only needs short answers).
//   - Persona facts are generated from live stats (Turso neo_stats, cached
//     10 minutes per isolate) with the bundled snapshot as fallback.
//   - Output guard: every upstream reply is scanned for leak patterns
//     (IPs, infra vocabulary, env names, key-like strings, VN phone
//     numbers) before it is returned OR cached. A leaky reply is replaced
//     with SAFE_REPLY and never written to neo_cache, so cache hits are
//     pre-guarded by construction.
//
// Env (Pages project):
//   CAT_API_BASE  default https://api.cerebras.ai/v1 (no trailing slash)
//   CAT_API_KEY   secret, set in Pages env only. Never in repo.
//   CAT_MODEL     default gpt-oss-120b
//   TURSO_URL, TURSO_TOKEN  hub DB (tables neo_budget, neo_budget_minute,
//                 neo_cache, neo_stats - created lazily by this function)

import { buildNeoSystem, NEO_POST_HISTORY, NEO_FIRST_MES, NEO_STATS_SNAPSHOT, withStatsFallback } from '../_neo-persona.js';

const SESSION_CAP = 40;            // messages per session identity per day
const IP_CAP = 60;                 // messages per IP per day
const GLOBAL_CAP = 200;            // upstream calls per day, all visitors (kill-switch)
const BURST_PER_MIN = 6;           // messages per IP per minute
const MAX_MSG = 400;               // chars per visitor message
const MAX_HISTORY = 4;             // turns resent to the model
const MAX_TURN_CHARS = 300;        // chars per history turn
const INPUT_TOKEN_BUDGET = 1200;   // estimated with chars/4, system included
const MAX_TOKENS_OUT = 256;
const SEND_REASONING_EFFORT = true; // set false if a provider rejects the field
const UPSTREAM_TIMEOUT_MS = 25000;
const CACHE_TTL_MS = 24 * 3600 * 1000;
const STATS_CACHE_MS = 10 * 60 * 1000;

const REST_REPLY = 'Prr, hôm nay tớ tiếp khách quá đà rồi, cổ họng khàn mất. Mai bạn quay lại nhé - hoặc mở kênh liên hệ ở cuối trang, Danny trả lời trực tiếp luôn.';

const memDaily = new Map();        // fallback counters: 'day:identity' -> count
const memMinute = new Map();       // fallback counters: 'bucket:identity' -> count
let statsCache = null;             // { at, stats }
let tablesReady = false;

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

function bangkokParts() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const p = {};
  for (const part of parts) p[part.type] = part.value;
  return p;
}
function dayKey() { const p = bangkokParts(); return p.year + '-' + p.month + '-' + p.day; }
function minuteKey() { const p = bangkokParts(); return dayKey() + 'T' + p.hour + ':' + p.minute; }

// Same normalization the local brain uses: lowercase, strip Vietnamese
// diacritics, collapse punctuation/space. Cache keys survive "antiRea là gì?"
// and "antirea la gi" being the same question.
export function normalizeQuestion(q) {
  return String(q || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function estTokens(text) { return Math.ceil(String(text || '').length / 4); }

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

function tursoConfigured(env) { return !!(env.TURSO_URL && env.TURSO_TOKEN); }

async function ensureTables(env) {
  if (tablesReady || !tursoConfigured(env)) return;
  await tursoExec(env, 'CREATE TABLE IF NOT EXISTS neo_budget (day TEXT, identity TEXT, count INTEGER, PRIMARY KEY (day, identity))');
  await tursoExec(env, 'CREATE TABLE IF NOT EXISTS neo_budget_minute (bucket TEXT, identity TEXT, count INTEGER, PRIMARY KEY (bucket, identity))');
  await tursoExec(env, 'CREATE TABLE IF NOT EXISTS neo_cache (key TEXT PRIMARY KEY, reply TEXT, created INTEGER)');
  await tursoExec(env, 'CREATE TABLE IF NOT EXISTS neo_stats (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT, updated_at TEXT)');
  tablesReady = true;
}

// Generic Turso counter bump. Throws on Turso error - the caller decides
// whether that is fail-open (session/IP) or fail-closed (global).
async function tursoBump(env, table, keyCol, keyVal, identity) {
  await ensureTables(env);
  await tursoExec(env,
    'INSERT INTO ' + table + ' (' + keyCol + ', identity, count) VALUES (?, ?, 1) ' +
    'ON CONFLICT(' + keyCol + ', identity) DO UPDATE SET count = count + 1', [keyVal, identity]);
  const out = await tursoExec(env,
    'SELECT count FROM ' + table + ' WHERE ' + keyCol + ' = ? AND identity = ?', [keyVal, identity]);
  const rows = out.results[0].response.result.rows;
  return rows.length ? Number(rows[0][0].value) : 1;
}

function memBump(map, key) {
  const n = (map.get(key) || 0) + 1;
  map.set(key, n);
  return n;
}

// Session / IP daily meter: fail-open (Turso error -> in-memory count).
async function bumpDailyFailOpen(env, identity) {
  const day = dayKey();
  if (tursoConfigured(env)) {
    try { return await tursoBump(env, 'neo_budget', 'day', day, identity); }
    catch (e) { /* fall through to memory */ }
  }
  return memBump(memDaily, day + ':' + identity);
}

// Burst meter per minute: fail-open the same way.
async function bumpMinuteFailOpen(env, identity) {
  const bucket = minuteKey();
  if (tursoConfigured(env)) {
    try { return await tursoBump(env, 'neo_budget_minute', 'bucket', bucket, identity); }
    catch (e) { /* fall through to memory */ }
  }
  return memBump(memMinute, bucket + ':' + identity);
}

// GLOBAL upstream meter: FAIL-CLOSED. Returns the new count, or null when
// Turso is configured but the bump failed - null means "do not call upstream".
async function bumpGlobal(env) {
  const day = dayKey();
  if (tursoConfigured(env)) {
    try { return await tursoBump(env, 'neo_budget', 'day', day, '__global__'); }
    catch (e) { return null; }
  }
  return memBump(memDaily, day + ':__global__');
}

async function cacheGet(env, key) {
  if (!tursoConfigured(env)) return null;
  try {
    await ensureTables(env);
    const out = await tursoExec(env, 'SELECT reply, created FROM neo_cache WHERE key = ?', [key]);
    const rows = out.results[0].response.result.rows;
    if (!rows.length) return null;
    const created = Number(rows[0][1].value);
    if (Date.now() - created > CACHE_TTL_MS) return null;
    return String(rows[0][0].value);
  } catch (e) { return null; }
}

async function cachePut(env, key, reply) {
  if (!tursoConfigured(env)) return;
  try {
    await ensureTables(env);
    await tursoExec(env,
      'INSERT INTO neo_cache (key, reply, created) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET reply = excluded.reply, created = excluded.created',
      [key, reply, Date.now()]);
  } catch (e) { /* cache is best-effort */ }
}

// Live stats for the persona: Turso neo_stats (id = 1), cached 10 minutes
// per isolate, bundled snapshot as fallback. Never throws.
async function loadStats(env) {
  if (statsCache && Date.now() - statsCache.at < STATS_CACHE_MS) return statsCache.stats;
  let stats = NEO_STATS_SNAPSHOT;
  if (tursoConfigured(env)) {
    try {
      await ensureTables(env);
      const out = await tursoExec(env, 'SELECT json FROM neo_stats WHERE id = 1');
      const rows = out.results[0].response.result.rows;
      if (rows.length) stats = withStatsFallback(JSON.parse(String(rows[0][0].value)));
    } catch (e) { /* snapshot fallback */ }
  }
  statsCache = { at: Date.now(), stats };
  return stats;
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

// Output guard (Danny's order 2026-11-16: Neo must never answer anything
// that leaks security-sensitive information). The persona carries
// never-reveal rules, but the model is not trusted to obey them every
// time, so the reply text itself is scanned. On ANY match the reply is
// replaced with SAFE_REPLY and is NOT cached; meters still count the
// message normally (the scan happens after all meter bumps).
const LEAK_PATTERNS = [
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/,                                                  // IPv4 address
  /\b(?:system\s+prompt|turso|upcloud|litellm|tailscale)\b/i,                     // infra / prompt vocabulary
  /\b(?:CAT_API_KEY|TURSO_TOKEN|TURSO_URL)\b/,                                    // env var names
  /\b(?:sk-[A-Za-z0-9_-]{10,}|ghp_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|AKIA[A-Z0-9]{12,})\b/, // known key prefixes
  /\b(?:[0-9a-fA-F]{40,}|[A-Za-z0-9+/]{40,}={0,2})\b/,                             // standalone 40+ char hex/base64 token
  /\b0\d{9}\b/,                                                                   // Vietnamese phone number (0 + 9 digits)
];

export const SAFE_REPLY = 'Prr, câu vừa rồi tớ lỡ suýt kể chuyện hậu trường của deck mất rồi - phần đó tớ phải giữ kín cho Danny. Mình quay lại chuyện công khai nhé: project, dịch vụ, số liệu trên deck, bạn hỏi gì tớ kể đó.';

export function replyHasLeak(text) {
  const t = String(text || '');
  return LEAK_PATTERNS.some(re => re.test(t));
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
  const sessionIdentity = await sha256hex(session + '|' + ip);
  const ipIdentity = await sha256hex('ip:' + ip);

  // Burst guard first (cheapest tripwire for drain scripts).
  const burst = await bumpMinuteFailOpen(env, ipIdentity);
  if (burst > BURST_PER_MIN) {
    return json({ error: 'budget', session, reply: REST_REPLY }, 429, headers);
  }

  // Session + IP daily meters (fail-open).
  const sessionCount = await bumpDailyFailOpen(env, sessionIdentity);
  if (sessionCount > SESSION_CAP) {
    return json({ error: 'budget', session, reply: REST_REPLY }, 429, headers);
  }
  const ipCount = await bumpDailyFailOpen(env, ipIdentity);
  if (ipCount > IP_CAP) {
    return json({ error: 'budget', session, reply: REST_REPLY }, 429, headers);
  }

  // Answer cache: hits answer without upstream and without the global cap.
  const cacheKey = await sha256hex(normalizeQuestion(message));
  const cached = await cacheGet(env, cacheKey);
  if (cached) return json({ reply: cached, session, cached: true }, 200, headers);

  // Global kill-switch (fail-closed). null = meter unavailable -> no upstream.
  const globalCount = await bumpGlobal(env);
  if (globalCount === null || globalCount > GLOBAL_CAP) {
    return json({ error: 'global_budget', fallback: true, session }, 200, headers);
  }

  const apiKey = env.CAT_API_KEY;
  if (!apiKey) return json({ error: 'upstream', fallback: true }, 200, headers);
  const apiBase = (env.CAT_API_BASE || 'https://api.cerebras.ai/v1').replace(/\/$/, '');
  const model = env.CAT_MODEL || 'gpt-oss-120b';

  const stats = await loadStats(env);
  const system = buildNeoSystem(stats);

  const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY)
    .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
    .map(h => ({ role: h.role, content: h.content.slice(0, MAX_TURN_CHARS) })) : [];
  // Enforce the total input budget: drop the oldest history turns first.
  const totalEst = () => estTokens(system) + estTokens(NEO_POST_HISTORY) + estTokens(message) +
    history.reduce((sum, h) => sum + estTokens(h.content), 0);
  while (history.length && totalEst() > INPUT_TOKEN_BUDGET) history.shift();

  const messages = [{ role: 'system', content: system }]
    .concat(history)
    .concat([{ role: 'user', content: message }])
    .concat([{ role: 'system', content: NEO_POST_HISTORY }]);

  const payload = { model, temperature: 0.7, max_tokens: MAX_TOKENS_OUT, messages };
  if (SEND_REASONING_EFFORT) payload.reasoning_effort = 'low';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetch(apiBase + '/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return json({ error: 'upstream', fallback: true }, 200, headers);
    const data = await res.json();
    const reply = shapeReply(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
    if (!reply) return json({ error: 'upstream', fallback: true }, 200, headers);
    // Output guard: a leaky reply is replaced and NEVER cached. Only
    // guarded (clean) replies enter neo_cache, so cache hits are
    // pre-guarded by construction and need no re-scan on the way out.
    if (replyHasLeak(reply)) {
      return json({ reply: SAFE_REPLY, session }, 200, headers);
    }
    await cachePut(env, cacheKey, reply);
    return json({ reply, session }, 200, headers);
  } catch (e) {
    clearTimeout(timer);
    return json({ error: 'upstream', fallback: true }, 200, headers);
  }
}

export async function onRequestGet() {
  return json({ cat: 'Neo', awake: true, greeting: NEO_FIRST_MES });
}
