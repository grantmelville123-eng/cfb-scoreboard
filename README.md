# CFB Scoreboard

A single-page FBS scoreboard with live scores, betting lines, national leaders,
rankings and news. Static HTML at the edge, serverless functions for anything
that needs a secret or a proxy, and no build step at all.

```
index.html        Scoreboard — week nav, filters, game cards, news, leaders
rankings.html     AP / Coaches / CFP polls + full conference standings
package.json      type:module only — no dependencies, no build

api/              Vercel Functions          (this is the deployed platform)
  cfb-leaders.js          → national leaders, names + FBS filter resolved server-side
  cfb-news.js             → headlines merged from five outlets' RSS
  cfb-odds.js             → The Odds API (NCAAF), key held server-side
  cfb-teams.js            → slimmed FBS directory + conference standings
  reddit-fn.js            → r/CFB hot posts (best-effort — see below)
  diag.js                 → /api/diag deployment health dashboard

functions/        Cloudflare Pages Functions, left from the original build.
_redirects        NOTE: these are now BEHIND — they still contain the ESPN
                  catch-all proxies and have no cfb-leaders or cfb-news. Moving
                  back to Cloudflare would mean porting those two first.
                  Vercel ignores both directories entirely.
```

### Two Vercel gotchas worth knowing

**Catch-all routes.** The original build proxied ESPN through
`api/espn-core/[...path].js`. On Vercel that 404s: with no framework, the
zero-config filesystem API matches only a **single** path segment for a
catch-all, so `/api/espn-core/v2/sports/...` never routes. Rather than paper
over it with rewrites, the one thing that needed it — leaders — became a
purpose-built endpoint that does the whole job server-side.

**Reddit.** Reddit returns 403 to Vercel's data-centre IPs no matter what
User-Agent you send. `reddit-fn.js` still exists and the r/CFB tab still tries,
but it fails honestly and says why. That is what `cfb-news.js` is for.

## Deploying to Vercel

1. Push to GitHub.
2. [vercel.com/new](https://vercel.com/new) → **Import** the repo.
3. Framework preset **Other**. Leave Build Command, Output Directory and
   Install Command empty — there is no build step. **Deploy**.
4. Settings → **Environment Variables** → add `THE_ODDS_API_KEY`
   (free key from https://the-odds-api.com), applied to all environments.
5. **Redeploy** — environment variables are injected at build time, so the
   deployment that already exists won't see the key.
6. Visit `/api/diag` to confirm every upstream is green.

Without the odds key everything still works; the game cards just keep ESPN's
pregame line instead of a live sportsbook number.

## How it works

**Week navigation.** ESPN's scoreboard payload carries the full season calendar
(`leagues[0].calendar`), so the week dropdown is built from live data rather
than hardcoded dates — it rolls into bowls and the CFP automatically. On load
the page picks whichever week contains "now".

**Power 4 filtering** happens client-side on `team.conferenceId`, which ESPN
puts on every competitor. A game qualifies if *either* team is in the ACC, Big
Ten, Big 12 or SEC — so Alabama vs. an FCS opponent still shows up. Notre Dame
is allow-listed by team id since it's an independent everyone expects to see.
One fetch (`groups=80`, ~99 games) backs every filter, so switching between
Power 4 / All FBS / Top 25 and the conference chips is instant and free.

**Team colours.** `tone()` converts each school's brand hex to HSL and clamps
lightness while preserving hue and saturation. Straight brand hex doesn't work
on a cream page — Iowa gold and Tennessee orange disappear into the paper —
and blending toward black flattens every hue into mud. Clamping lightness
keeps burnt orange burnt orange. Colourless brands (Army black) fall back to a
warm neutral.

**Odds.** `/api/cfb-odds` calls The Odds API once and slims the response
server-side. Cost is per *market*, not per game, so one call covers all ~90
Saturday games for 2 credits. The `s-maxage=300` response header makes Vercel's
CDN serve it for 5 minutes, so 100 simultaneous visitors still cost 2 credits.
The frontend skips the call entirely unless something is live or kicking off
within six hours, which makes weekdays free. The free tier is 500
credits/month — see the notes at the top of `api/cfb-odds.js` if you run short.

**Leaders.** ESPN's core leaders feed spans all of Division I and returns
athlete names as `$ref` URLs, so a top-10 needs ten extra round trips plus the
FBS team set to filter out FCS players. `/api/cfb-leaders` does all of that
server-side and returns rows ready to paint — one browser request instead of
eleven. It takes `?stat=` and `?conf=` (`p4`, `all`, or a conference id: 1 ACC,
4 Big 12, 5 Big Ten, 8 SEC), and each combination is cached separately at the
edge for 30 minutes. Notre Dame is counted as Power 4.

**Headlines.** `/api/cfb-news` fetches five RSS feeds in parallel, each with
its own timeout and try/catch, then merges, de-duplicates by headline and sorts
by recency. Google News is in the mix because it surfaces The Athletic,
247Sports, On3 and local beat writers that have no usable feed of their own;
its `" - Outlet"` title suffix is split back out so cards credit the real
publisher. The response carries a `sources` array reporting ok/count/error per
feed — `curl -s .../api/cfb-news | jq .sources` tells you instantly which
outlet went dark, and the browser console logs any that are down.

**Standings** would be a 2.5 MB download straight from ESPN. `cfb-teams.js`
strips it to the ~15 fields the UI uses (~60 KB) and caches for six hours.

**Auto-refresh** only runs when a game is actually live, the tab is visible,
and the user has interacted in the last 15 minutes.

## Things you may want to change

- **Name and branding** — the wordmark and goalpost mark are in the `<header>`
  of both pages plus the `<title>` tags.
- **Power 4 definition** — `CONFS` / `P4_EXTRA_TEAMS` near the top of the
  script in `index.html`.
- **Leader categories** — the `STATS` array. The core API also exposes
  `interceptions`, `receptions`, `rushingTouchdowns`, `receivingTouchdowns`,
  `quarterbackRating`, `interceptionYards` and `kickoffYards`.
- **Odds cost** — `CACHE_SECONDS` and `MARKETS` in `api/cfb-odds.js`.
- **News outlets** — the `FEEDS` array in `api/cfb-news.js`.
- **Leader conference filter** — `LEADER_CONFS` in `index.html` and
  `P4_CONF` / `P4_EXTRA_TEAMS` in `api/cfb-leaders.js`.

## Local preview

The pages call `/api/*` for odds, standings and leaders, so those parts need
the functions running: `npx vercel dev` serves the static files and the `api/`
directory together. Opening `index.html` straight from disk still renders
scores, headlines and the AP poll, since those hit ESPN directly.

## Notes on the platform port

- Vercel runs the Node runtime, so handlers are `(request, response)` and read
  secrets from `process.env`. Cloudflare Pages Functions are `onRequest(context)`
  and read `context.env`. That difference is why the two directories exist.
- `package.json` sets `"type": "module"` because Vercel requires it for ESM
  handlers in a project with no framework.
- Edge caching is header-driven on Vercel (`Cache-Control: s-maxage=…`) rather
  than the `cf: { cacheTtl }` option Cloudflare uses. Vercel does not support
  `stale-if-error`, so only `stale-while-revalidate` is set.
