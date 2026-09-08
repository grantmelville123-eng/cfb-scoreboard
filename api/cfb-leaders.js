// Vercel Function: national statistical leaders, fully resolved server-side.
//
// File path -> URL: this file -> /api/cfb-leaders
// Query: ?stat=passingYards&conf=p4&season=2024&limit=10
//
// WHY THIS EXISTS
// ---------------
// ESPN's core leaders feed has two problems the browser can't solve cheaply:
//
//   1. Athlete names arrive as $ref URLs, so rendering a top-10 needs 10 extra
//      round trips. Doing that from the browser was slow, rate-limit-prone,
//      and it needed a catch-all proxy route.
//   2. The feed spans all of Division I, so an FCS quarterback can top the
//      "national" list. Filtering needs the FBS team-id set, which only the
//      2.5 MB standings payload provides.
//
// Doing all of it here means the browser makes ONE request and gets rows that
// are ready to render. Everything is cached: the response at Vercel's edge for
// 30 minutes, and the three upstream payloads in module scope so warm
// invocations skip the network entirely.
//
// (This also replaced an /api/espn-core/[...path].js catch-all proxy. Vercel's
// zero-config filesystem API only matches a SINGLE segment for [...path] in a
// project with no framework, so multi-segment ESPN paths 404'd. A purpose-built
// endpoint sidesteps the routing question entirely.)

const CACHE_SECONDS = 30 * 60;

// How many leaders to pull per category before filtering. See the note in
// getLeaders() — the default of 25 is nowhere near enough once FCS players are
// removed. The whole payload is fetched once and shared by every stat tab.
const RAW_LIMIT = 300;

// Categories the UI exposes. The core API also has interceptions, receptions,
// rushingTouchdowns, receivingTouchdowns, quarterbackRating, interceptionYards
// and kickoffYards if you want more tabs.
const ALLOWED_STATS = new Set([
  "passingYards", "rushingYards", "receivingYards",
  "passingTouchdowns", "sacks", "totalTackles",
  "interceptions", "receptions", "rushingTouchdowns",
  "receivingTouchdowns", "quarterbackRating",
]);

const P4_CONF = new Set(["1", "4", "5", "8"]);   // ACC, Big 12, Big Ten, SEC
const P4_EXTRA_TEAMS = new Set(["87"]);           // Notre Dame

const TTL = { teams: 6 * 60 * 60 * 1000, leaders: 30 * 60 * 1000, names: 24 * 60 * 60 * 1000 };

// Everything except athlete names is cached PER SEASON. That isn't just an
// optimisation — conference realignment means membership is a property of the
// season. USC and UCLA were Pac-12 in 2023 and Big Ten in 2026, so filtering a
// 2023 leaderboard through a 2026 team map would quietly put them in the wrong
// conference. Athlete names are season-independent and shared.
const cache = { teams: new Map(), leaders: new Map(), names: new Map() };

const EARLIEST_SEASON = 2015;

export default async function handler(request, response) {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const stat  = url.searchParams.get("stat") || "passingYards";
  const conf  = (url.searchParams.get("conf") || "p4").toLowerCase();
  const limit = Math.min(25, Math.max(1, parseInt(url.searchParams.get("limit") || "10", 10) || 10));

  const current = seasonYear();
  const asked = parseInt(url.searchParams.get("season") || "", 10);
  const season = Number.isFinite(asked)
    ? Math.min(current, Math.max(EARLIEST_SEASON, asked))
    : current;

  if (!ALLOWED_STATS.has(stat)) {
    return response.status(400).json({ error: "bad_stat", allowed: [...ALLOWED_STATS] });
  }

  try {
    const [teams, leaders] = await Promise.all([getTeams(season), getLeaders(season, current)]);
    const raw = (leaders.cats && leaders.cats[stat]) || [];
    const knowFbs = teams.size > 0;

    // Walk the feed in rank order, keeping only teams that clear the filter.
    const picked = [];
    for (const r of raw) {
      const t = r.teamId ? teams.get(r.teamId) : null;
      if (knowFbs && !t) continue;                       // FCS, or unknown team
      if (!passesConf(r.teamId, t, conf)) continue;
      picked.push(r);
      if (picked.length >= limit) break;
    }

    const names = await resolveNames(picked.map(r => r.athleteId));

    const rows = picked.map((r, i) => {
      const t = teams.get(r.teamId) || {};
      return {
        rank: i + 1,
        name: names.get(r.athleteId) || null,
        teamId: r.teamId,
        team: t.abbr || "",
        teamName: t.name || "",
        conf: t.conf || "",
        value: r.value,
        display: r.display,
      };
    }).filter(r => r.name);

    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader(
      "Cache-Control",
      `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 2}`
    );
    return response.status(200).json({
      at: Date.now(),
      stat, conf, limit,
      season: leaders.season,
      seasonType: leaders.type,
      fbsFiltered: knowFbs,
      rows,
    });
  } catch (err) {
    response.setHeader("Cache-Control", "public, s-maxage=60");
    return response.status(502).json({ error: "leaders_failed", message: String((err && err.message) || err) });
  }
}

function passesConf(teamId, team, conf) {
  if (conf === "all") return true;
  if (!team) return false;
  if (conf === "p4") return P4_CONF.has(team.conf) || P4_EXTRA_TEAMS.has(teamId);
  return team.conf === conf;
}

/* ─────────── FBS team directory (id -> {abbr, name, conf}) ─────────── */

async function getTeams(season) {
  const hit = cache.teams.get(season);
  if (hit && Date.now() - hit.at < TTL.teams) return hit.map;

  const target = "https://site.web.api.espn.com/apis/v2/sports/football/college-football/standings"
               + `?region=us&lang=en&contentorigin=espn&season=${season}&type=0&level=2`;
  const map = new Map();
  try {
    const res = await fetch(target, { headers: espnHeaders() });
    if (res.ok) {
      const data = await res.json();
      for (const conf of (data.children || [])) {
        for (const e of ((conf.standings && conf.standings.entries) || [])) {
          const t = e.team || {};
          if (t.id) map.set(String(t.id), {
            abbr: t.abbreviation || "",
            name: t.shortDisplayName || t.name || "",
            conf: String(conf.id || ""),
          });
        }
      }
    }
  } catch (_) { /* fall through with an empty map — we then skip FBS filtering */ }

  cache.teams.set(season, { at: Date.now(), map });
  return map;
}

/* ─────────── Raw leader categories ─────────── */

async function getLeaders(season, current) {
  const hit = cache.leaders.get(season);
  if (hit && Date.now() - hit.at < TTL.leaders) return hit;

  // For a PAST season the answer is settled: regular season, that year, done.
  // Only the current season needs the walk-back, because in week 1 its
  // regular-season totals can still be empty and an empty card is worse than
  // last year's numbers clearly labelled.
  const combos = season === current
    ? [[season, 2], [season - 1, 2], [season - 1, 3]]
    : [[season, 2]];

  for (const [year, type] of combos) {
    // RAW_LIMIT matters more than it looks. The feed covers all of Division I
    // and is ordered by raw total, so early in a season it is dominated by FCS
    // teams that have simply played more games — of the default 25 passing-yards
    // leaders, only FOUR were FBS, and only two of those were Power 4. Asking
    // for 300 leaves 60-170 FBS players per category to filter from, which is
    // enough for a top-10 in any single conference.
    const target = `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football`
                 + `/seasons/${year}/types/${type}/leaders?lang=en&region=us&limit=${RAW_LIMIT}`;
    try {
      const res = await fetch(target, { headers: espnHeaders() });
      if (!res.ok) continue;
      const data = await res.json();
      const cats = {};
      let any = false;
      for (const c of (data.categories || [])) {
        const rows = (c.leaders || []).map(l => ({
          value: typeof l.value === "number" ? l.value : parseFloat(l.displayValue || "0"),
          display: l.displayValue,
          athleteId: idFrom(l.athlete && l.athlete.$ref, "athletes"),
          teamId: idFrom(l.team && l.team.$ref, "teams"),
        })).filter(r => r.athleteId);
        if (rows.length) { cats[c.name] = rows; any = true; }
      }
      if (!any) continue;
      const out = { at: Date.now(), cats, season: year, type };
      cache.leaders.set(season, out);
      return out;
    } catch (_) { /* try the next combo */ }
  }

  const empty = { at: Date.now(), cats: {}, season, type: 2 };
  cache.leaders.set(season, empty);
  return empty;
}

/* ─────────── Athlete names ─────────── */

async function resolveNames(ids) {
  const out = new Map();
  const missing = [];
  for (const id of ids) {
    if (!id) continue;
    const hit = cache.names.get(id);
    if (hit && Date.now() - hit.at < TTL.names) out.set(id, hit.name);
    else missing.push(id);
  }
  // Server-side these are fast and same-region, but keep the fan-out modest so
  // ESPN doesn't rate-limit a cold invocation.
  await pool(missing, 8, async id => {
    const target = `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/athletes/${id}?lang=en&region=us`;
    try {
      const res = await fetch(target, { headers: espnHeaders() });
      if (!res.ok) return;
      const d = await res.json();
      const name = d.displayName || d.fullName || d.shortName;
      if (name) { cache.names.set(id, { at: Date.now(), name }); out.set(id, name); }
    } catch (_) { /* a missing name just drops that row */ }
  });
  return out;
}

async function pool(items, size, worker) {
  const queue = items.slice();
  await Promise.all(Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await worker(queue.shift());
  }));
}

/* ─────────── helpers ─────────── */

function idFrom(ref, kind) {
  const m = String(ref || "").match(new RegExp("/" + kind + "/(\\d+)"));
  return m ? m[1] : null;
}

// ESPN 403s data-centre IPs without a browser-looking User-Agent.
function espnHeaders() {
  return {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.espn.com/",
  };
}

// CFB seasons are labelled by the calendar year they start in.
function seasonYear() {
  const now = new Date();
  return now.getMonth() < 6 ? now.getFullYear() - 1 : now.getFullYear();
}
