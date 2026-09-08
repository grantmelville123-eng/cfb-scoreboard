// Vercel Function: live college-football odds via The Odds API.
//
// File path -> URL: this file -> /api/cfb-odds
//
// ARCHITECTURE
// ------------
// - The API key lives server-side only (process.env.THE_ODDS_API_KEY), set in
//   the Vercel dashboard under Settings -> Environment Variables. The browser
//   never sees it.
// - Vercel's CDN caches this response for 5 minutes because the Cache-Control
//   header carries s-maxage. That is what protects the quota: 100 visitors
//   inside one 5-minute window cost exactly ONE upstream call.
//
// QUOTA MATH (free tier = 500 credits/month)
// ------------------------------------------
// Cost per request = (number of markets) x (number of regions) credits.
// We ask for 2 markets (spreads, totals) in 1 region -> 2 credits per call.
// IMPORTANT: the cost does NOT scale with the number of games, so one call
// covering all ~90 FBS games on a Saturday still costs 2 credits.
//
// With 5-minute CDN caching that's a ceiling of 12 calls/hour = 24 credits/hour.
// A 12-hour Saturday is ~290 credits, which would burn the monthly cap in two
// weekends. Mitigations, in order of preference:
//   1) The frontend only calls this when the visible week actually has games
//      that are live or starting soon, so weekdays are nearly free.
//   2) Raise CACHE_SECONDS below to 600 (10 min) -> halves the ceiling.
//   3) Drop "totals" from MARKETS -> halves per-call cost.
//   4) Upgrade to a paid Odds API tier.
//
// If THE_ODDS_API_KEY is unset this returns 503 and the frontend silently
// keeps ESPN's pregame line. The site never breaks over odds.

const SPORT         = "americanfootball_ncaaf";
const REGIONS       = "us";
const MARKETS       = "spreads,totals";
const BOOKMAKERS    = "draftkings,fanduel";
const ODDS_FORMAT   = "american";
const CACHE_SECONDS = 300;

export default async function handler(request, response) {
  // Trim defensively: a key pasted out of an email often arrives with a
  // trailing newline or space, which The Odds API rejects as INVALID_KEY.
  const apiKey = (process.env.THE_ODDS_API_KEY || "").trim();

  if (!apiKey) {
    response.setHeader("Cache-Control", "public, s-maxage=60");
    return response.status(503).json({
      error: "no_api_key",
      message: "THE_ODDS_API_KEY is not set on this Vercel project.",
    });
  }

  const url = `https://api.the-odds-api.com/v4/sports/${SPORT}/odds`
            + `?apiKey=${encodeURIComponent(apiKey)}`
            + `&regions=${REGIONS}`
            + `&markets=${MARKETS}`
            + `&bookmakers=${BOOKMAKERS}`
            + `&oddsFormat=${ODDS_FORMAT}`;

  try {
    const upstream = await fetch(url, { headers: { Accept: "application/json" } });

    // Read quota headers BEFORE consuming the body.
    const remaining = upstream.headers.get("x-requests-remaining") || "";
    const used      = upstream.headers.get("x-requests-used")      || "";
    const lastCost  = upstream.headers.get("x-requests-last")      || "";

    response.setHeader("X-Odds-Remaining", remaining);
    response.setHeader("X-Odds-Used", used);
    response.setHeader("X-Odds-Last-Cost", lastCost);

    if (!upstream.ok) {
      const text = await upstream.text();
      return response.status(upstream.status).json({
        error: "upstream",
        status: upstream.status,
        body: text.slice(0, 500),
      });
    }

    // Slim the payload before it goes over the wire. The raw NCAAF response is
    // ~90 events x 2 books x 2 markets and can top 300KB; the frontend only
    // needs a favourite/spread/total triple per game, so we reduce it here
    // instead of shipping the whole thing to every phone.
    let slim = [];
    try {
      const events = await upstream.json();
      if (Array.isArray(events)) slim = events.map(slimEvent).filter(Boolean);
    } catch (_) {
      slim = [];
    }

    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader(
      "Cache-Control",
      `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 2}`
    );
    return response.status(200).json({ at: Date.now(), events: slim });
  } catch (err) {
    return response.status(502).json({
      error: "fetch_failed",
      message: String((err && err.message) || err),
    });
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
      // The favourite is the side with the more negative point.
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
