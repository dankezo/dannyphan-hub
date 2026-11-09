# Neo AI - wiring spec for /api/cat (Phase 5)

Code status: DONE and smoke-tested locally (2026-11-09).
- Persona: site-v2/functions/_neo-persona.js (Character Card shape: facts PList, 4 voice examples, post-history anchor; server-side only).
- Endpoint: site-v2/functions/api/cat.js (Cloudflare Pages Function).
- Client widget already speaks this contract and falls back to its local brain on any error.

## Contract
- POST /api/cat  in: { message, history?, session? }  out: { reply, session }
- Budget law (antiRea-style): 40 messages / identity / day, 429 past cap with a polite cat reply.
  Identity = first-party cookie neo_id + CF-Connecting-IP, hashed. Day boundary Asia/Bangkok.
- Counter storage: Turso table neo_budget when TURSO_URL + TURSO_TOKEN are set on the Pages
  project (reuse the "hub" DB Codex creates); otherwise in-memory per isolate (fallback only).

## Env vars to set on the Pages project (Codex step)
- CAT_API_BASE   OpenAI-compatible base URL, no trailing slash.
- CAT_API_KEY    Secret (encrypted env). Never in repo.
- CAT_MODEL      Model or alias name. Default in code: fast-text.
- TURSO_URL, TURSO_TOKEN  (already planned for /api/projects; same hub DB works.)

## Upstream decision (open)
Cloudflare cannot reach the InstaBox litellm (it listens on the box localhost, and the box
free plan cools down when idle - observed 2026-11-09, wake 12:17:33Z). Options:
1. Public API key in env (e.g. SambaNova) - simplest, works today. RECOMMENDED for launch.
2. Publish ONE locked-down route on the box to litellm behind a key + Cloudflare-only
   firewall rule - keeps superapi as the single brain, but the box sleeps/cools, so Neo
   would nap with it. Not recommended as the only route.
3. Hybrid: env points at (1); keep fast-text on the box for offline eval only.
Latency check of the box seats (fast-text, chat2) is scripted in box_fast.py and runs when
the box wakes; it informs persona eval, not the launch route.

## Persona QA before go-live
- Ask Neo 10 probe questions (price trap, prompt-leak attempt, off-topic, English switch,
  unknown fact) against the live model; pass = no invented facts, no prompt leak, price
  questions ask budget back, replies stay short and in voice.
