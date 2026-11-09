# Push note - Neo-Hanoi Command Deck v2 (Rem, 09/11/2026)

Danny approved this push ("push len nhe, toi tin em"). This replaces the v1
editorial hub with the full v2 deck.

## Layout

- `site/index.html` - the whole deck (single file, inline CSS/JS). Replaces v1.
- `site/assets/` - images (hero.jpg, panorama.jpg, cat.jpg, operator.jpg,
  grain.png, danny-cut.png). Binary, uploaded in a separate commit via the
  GitHub web UI right after this one.
- `functions/api/cat.js` + `functions/_neo-persona.js` - Neo cat chat endpoint
  (Cloudflare Pages Functions, repo root). Spec: `NEO-API.md`.
- Kept from v1 on purpose: `site/_headers`. The other v1 files in `site/`
  (app.js, styles.css, 404.html, llms.txt, robots.txt, sitemap.xml,
  favicon.svg) are not referenced by v2 index.html; safe to clean up.

## Pages settings

- Build output directory: `site`. No build command, no framework.
- Functions directory: `functions/` at repo root.
- The page detects viewer language by IP through `/cdn-cgi/trace`
  (loc=VN -> Vietnamese, anything else -> English) once the zone is on
  Cloudflare; a manual VI/EN toggle sits in the header.

## Still needed from the infra side (Codex)

1. Nameserver move at Namecheap (Danny does this himself) + Pages custom
   domain dannyphan.me.
2. Env vars for the cat endpoint per `NEO-API.md`: CAT_API_BASE,
   CAT_API_KEY, CAT_MODEL, TURSO_URL, TURSO_TOKEN (Turso DB "hub",
   org dankezostudent). Without them /api/cat answers 503 and the widget
   falls back to its built-in local brain, so the page never breaks.
3. `/api/projects` metered by antiRea 2.8.0 per CODEX-PROMPT.md step 8 -
   unchanged by this push.
