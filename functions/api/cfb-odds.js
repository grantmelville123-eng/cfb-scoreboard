// Cloudflare Pages Function: live college-football odds via The Odds API.
//
// File path → URL: this file → /api/cfb-odds
//
// ARCHITECTURE
// ------------
// - The API key lives server-side only (context.env.THE_ODDS_API_KEY), set in
//   the Cloudflare Pages dashboard under Settings → Variables and Secrets.
//   The browser never sees it.
// - Cloudflare's edge cache holds the response for 5 minutes, so 100 visitors
//   inside one 5-minute window cost exactly ONE upstream call. That matters:
//   the free tier is 500 credits/month.
// - The Odds API's X-Requests-* quota headers are passed through so you can
//   watch remaining quota in DevTools.
//
// QUOTA MATH (free tier = 500 credits/month)
// ------------------------------------------
// Cost per request = (number of markets) x (number of regions) credits.
// We ask for 2 markets (spreads, totals) in 1 region → 2 credits per call.
// IMPORTANT: the cost does NOT scale with the number of games, so one call
// covering all ~80 FBS games on a Saturday still costs 2 credits.
//
// With 5-min edge caching that's a ceiling of 12 calls/hour = 24 credits/hour.
// A 12-hour Saturday is ~290 credits — which would blow the monthly cap in
// two weekends. Mitigations, in order of preference:
//   1) The frontend only calls this when the visible week actually has games
//      that are live or starting soon, so weekdays are nearly free.
//   2) Raise CACHE_SECONDS below to 600 (10 min) → halves the ceiling.
//   3) Drop "totals" from MARKETS → halves per-call cost.
//   4) Upgrade to a paid Odds API tier (20k credits is a few dollars/month).
//
// If THE_ODDS_API_KEY is unset the function returns 503 and the frontend
// silently keeps ESPN's pregame line. The site never breaks over odds.

const SPORT        = "americanfootball_ncaaf";
const REGIONS      = "us";
const MARKETS      = "spreads,totals";
const BOOKMAKERS   = "draftkings,fanduel";
const ODDS_FORMAT  = "american";
const CACHE_SECONDS = 300;

export async function onRequest(context) {
  const apiKey = context.env && context.env.THE_ODDS_API_KEY;

  if (!apiKey) {
    return jsonResponse(
      { error: "no_api_key", message: "THE_ODDS_API_KEY is not set on this Pages project." },
      503,
      { "Cache-Control": "public, max-age=60" }
    );
  }

  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`
            + `?apiKey=${encodeURIComponent(apiKey)}`
            + `&regions=${REGIONS}`
            + `&markets=${MARKETS}`
            + `&bookmakers=${BOOKMAKERS}`
            + `&oddsFormat=${ODDS_FORMAT}`;

  try {
    const upstream = await fetch(url, {
      headers: { "Accept": "application/json" },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    });

    // Read quota headers BEFORE consuming the body.
    const remaining = upstream.headers.get("x-requests-remaining") || "";
    const used      = upstream.headers.get("x-requests-used")      || "";
    const lastCost  = upstream.headers.get("x-requests-last")      || "";

    if (!upstream.ok) {
      const text = await upstream.text();
      return jsonResponse(
        { error: "upstream", status: upstream.status, body: text.slice(0, 500) },
        upstream.status,
        { "X-Odds-Remaining": remaining, "X-Odds-Used": used, "X-Odds-Last-Cost": lastCost }
      );
    }

    // Slim the payload before it goes over the wire. The raw NCAAF response is
    // ~80 events x 2 books x 2 markets and can top 300KB; the frontend only
    // needs a favorite/spread/total triple per game, so we reduce here at the
    // edge instead of shipping the whole thing to every phone.
    let slim = [];
    try {
      const events = await upstream.json();
      if (Array.isArray(events)) slim = events.map(slimEvent).filter(Boolean);
    } catch (_) {
      slim = [];
    }

    return new Response(JSON.stringify({ at: Date.now(), events: slim }), {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": `public, max-age=${CACHE_SECONDS}, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=600`,
        "X-Odds-Remaining": remaining,
        "X-Odds-Used": used,
        "X-Odds-Last-Cost": lastCost,
      },
    });
  } catch (err) {
    return jsonResponse({ error: "fetch_failed", message: String((err && err.message) || err) }, 502);
  }
}

function slimEvent(ev) {
  if (!ev || !Array.isArray(ev.bookmakers) || !ev.bookmakers.length) return null;
  // Prefer DraftKings for consistency with the pill's "book" label.
  const book = ev.bookmakers.find(b => b.key === "draftkings") || ev.bookmakers[0];
  const out = {
    home: ev.home_team,
    away: ev.away_team,
    commence: ev.commence_time,
    book: book.title || book.key,
    lastUpdate: book.last_update,
  };
  for (const market of (book.markets || [])) {
    if (market.key === "spreads") {
      // outcomes look like [{name:"Alabama Crimson Tide", point:-6.5, price:-110}, ...]
      // The favorite is the side with the more negative point.
      let fav = null;
      for (const o of (market.outcomes || [])) {
        if (o.point == null) continue;
        if (!fav || Number(o.point) < Number(fav.point)) fav = o;
      }
      if (fav) { out.favTeam = fav.name; out.spread = Number(fav.point); out.spreadPrice = fav.price; }
    } else if (market.key === "totals") {
      const over = (market.outcomes || []).find(o => /over/i.test(o.name || ""));
      if (over && over.point != null) out.total = Number(over.point);
    }
  }
  return (out.spread != null || out.total != null) ? out : null;
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
