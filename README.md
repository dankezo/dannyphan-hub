# dannyphan.me

Personal hub of Danny Phan (Hanoi, Vietnam) - security operations, automation and web tooling.

Live: https://dannyphan.me

## Stack

- Hosting: Cloudflare Pages (static, deployed from this repo, root directory = site/)
- DNS: Cloudflare (domain registered at Namecheap)
- Security: HTTPS enforced + HSTS, security headers in site/_headers, Bot Fight Mode and WAF at the Cloudflare edge
- Database convention: Turso, one database per project, personal org dankezostudent (tokens live only in server-side env, never in this repo)

## Layout

- site/ - the static site (index, styles, _headers, robots, sitemap, llms.txt, security.txt)
- SETUP-PLAN.md is kept in the local workspace, not published.
