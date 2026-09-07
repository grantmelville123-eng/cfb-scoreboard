// Vercel Function: slim FBS team directory + conference standings.
//
// File path -> URL: this file -> /api/cfb-teams
//
// WHY THIS EXISTS
// ---------------
// Two things the frontend needs are only available from endpoints that are
// either enormous or CORS-blocked:
//
//   1. "Which team ids are FBS, and what conference is each in?"
//      ESPN's /teams?limit=900 list is 1.8 MB, includes all 761 Division I
//      teams (FBS + FCS), ignores the groups filter, and has no usable
//      conference field.
//   2. Conference standings (overall record, conference record, streak).
//      site.web.api.espn.com is CORS-blocked in the browser.
//
// ESPN's standings endpoint at level=2 answers both -- it returns exactly the
// 11 FBS conferences and their member teams (138 teams) -- but the raw payload
// is ~2.5 MB because every team carries 60+ stats and a dozen link objects. We
// fetch it once server-side, strip it to the ~15 fields the UI uses, and serve
// the result (~60 KB) with a 6-hour cache. Standings change at most once a day
// during the season, so this costs almost nothing.
//
// Response shape:
// {
//   at: 1757278000000,
//   season: 2026,
//   conferences: [
//     { id:"8", name:"Southeastern Conference", short:"SEC",
//       teams:[ { id, abbr, name, full, conf, overall, confRec, streak, pf, pa, diff } ] }
//   ]
// }
//
// Team logos are NOT included -- they're deterministic from the id:
//   https://a.espncdn.com/i/teamlogos/ncaa/500/<id>.png

const CACHE_SECONDS = 6 * 60 * 60;  // 6 hours

// Display abbreviations for the conferences ESPN names in full.
const CONF_SHORT = {
  "1":   "ACC",
  "4":   "Big 12",
  "5":   "Big Ten",
  "8":   "SEC",
  "9":   "Pac-12",
  "12":  "C-USA",
  "15":  "MAC",
  "17":  "Mtn West",
  "18":  "Independent",
  "37":  "Sun Belt",
  "151": "American",
};

export default async function handler(request, response) {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const season = (url.searchParams.get("season") || "").replace(/[^0-9]/g, "")
              || String(guessSeasonYear());

  const target = "https://site.web.api.espn.com/apis/v2/sports/football/college-football/standings"
               + `?region=us&lang=en&contentorigin=espn&season=${season}&type=0&level=2`;

  try {
    const upstream = await fetch(target, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.espn.com/",
      },
    });

    if (!upstream.ok) {
      response.setHeader("Cache-Control", "public, s-maxage=60");
      return response.status(upstream.status).json({ error: "upstream", status: upstream.status, season });
    }

    const data = await upstream.json();
    const conferences = (data.children || []).map(conf => ({
      id:    String(conf.id || ""),
      name:  conf.name || conf.shortName || "",
      short: CONF_SHORT[String(conf.id)] || conf.abbreviation || conf.shortName || conf.name || "",
      teams: ((conf.standings && conf.standings.entries) || []).map(e => slimEntry(e, conf.id)),
    })).filter(c => c.id && c.teams.length);

    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader(
      "Cache-Control",
      `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400`
    );
    return response.status(200).json({ at: Date.now(), season: Number(season), conferences });
  } catch (err) {
    response.setHeader("Cache-Control", "public, s-maxage=60");
    return response.status(502).json({ error: "fetch_failed", message: String((err && err.message) || err) });
  }
}

function slimEntry(entry, confId) {
  const t = entry.team || {};
  const stat = name => {
    const s = (entry.stats || []).find(x => x.type === name || x.name === name);
    return s ? (s.displayValue != null ? s.displayValue : s.value) : null;
  };
  const num = name => {
    const s = (entry.stats || []).find(x => x.type === name || x.name === name);
    return s && typeof s.value === "number" ? s.value : null;
  };
  return {
    id:      String(t.id || ""),
    abbr:    t.abbreviation || "",
    name:    t.shortDisplayName || t.name || "",
    full:    t.displayName || "",
    conf:    String(confId || ""),
    overall: stat("total")   || "0-0",
    confRec: stat("vsconf")  || "0-0",
    streak:  stat("streak")  || "",
    pf:      num("pointsfor"),
    pa:      num("pointsagainst"),
    diff:    stat("pointdifferential") || "",
  };
}

// College football seasons are labelled by the calendar year they start in, so
// January-June belongs to the previous season's year.
function guessSeasonYear() {
  const now = new Date();
  return now.getMonth() < 6 ? now.getFullYear() - 1 : now.getFullYear();
}
