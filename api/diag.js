// Diagnostic endpoint: GET /api/diag
//
// Strategy: render the HTML shell IMMEDIATELY (no upstream fetches), then let
// the page call /api/diag?json client-side to fill in each row. A hung
// upstream can't blank the whole page.
//
//   /api/diag       -> HTML dashboard
//   /api/diag?json  -> JSON status report (8s timeout per upstream)

export default async function handler(request, response) {
  const hasOddsKey = !!process.env.THE_ODDS_API_KEY;
  const url = new URL(request.url, `https://${request.headers.host}`);

  if (url.searchParams.has("json")) return jsonReport(response, hasOddsKey);

  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).send(htmlShell(hasOddsKey));
}

/* ───────────── JSON report ───────────── */

async function jsonReport(response, hasOddsKey) {
  const season = seasonYear();
  const browserHeaders = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.espn.com/",
  };

  async function timedFetch(target, headers, ms = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try { return await fetch(target, { headers, signal: ctl.signal }); }
    finally { clearTimeout(timer); }
  }

  async function pingOdds() {
    if (!hasOddsKey) {
      return { ok: false, status: null, note: "THE_ODDS_API_KEY is NOT set on this deployment." };
    }
    const u = `https://api.the-odds-api.com/v4/sports/?apiKey=${encodeURIComponent(process.env.THE_ODDS_API_KEY)}`;
    try {
      const r = await timedFetch(u, { Accept: "application/json" });
      return {
        ok: r.ok,
        status: r.status,
        remaining: r.headers.get("x-requests-remaining") || null,
        used: r.headers.get("x-requests-used") || null,
        note: r.ok ? "API key valid."
          : `HTTP ${r.status} — ${r.status === 401 ? "key invalid or not yet activated." : "unexpected upstream response."}`,
      };
    } catch (e) { return { ok: false, status: null, error: errString(e) }; }
  }

  async function ping(label, target) {
    try {
      const r = await timedFetch(target, browserHeaders);
      let bodyHint = "";
      try { bodyHint = (await r.text()).slice(0, 200).replace(/\s+/g, " ").trim(); } catch (_) {}
      return { label, target, ok: r.ok, status: r.status, contentType: r.headers.get("content-type") || "", bodyHint };
    } catch (e) { return { label, target, ok: false, error: errString(e) }; }
  }

  const [odds, scoreboard, leaders, news, rankings, standings] = await Promise.all([
    pingOdds(),
    ping("ESPN site (scoreboard)", "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard?groups=80&limit=5"),
    ping("ESPN core (leaders)",    `https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/${season}/types/2/leaders?lang=en&region=us`),
    ping("ESPN site (news)",       "https://site.api.espn.com/apis/site/v2/sports/football/college-football/news?limit=3"),
    ping("ESPN site (rankings)",   "https://site.api.espn.com/apis/site/v2/sports/football/college-football/rankings"),
    ping("ESPN web (standings)",   `https://site.web.api.espn.com/apis/v2/sports/football/college-football/standings?region=us&lang=en&contentorigin=espn&season=${season}&type=0&level=2`),
  ]);

  const report = {
    deployedAt: new Date().toISOString(),
    platform: "vercel",
    region: process.env.VERCEL_REGION || null,
    seasonAssumed: season,
    envVars: { THE_ODDS_API_KEY_set: hasOddsKey },
    upstreams: { odds, scoreboard, leaders, news, rankings, standings },
    hint: !hasOddsKey
      ? "Odds key missing. Add THE_ODDS_API_KEY in Vercel → Settings → Environment Variables, then redeploy. Everything except the live betting line works without it."
      : (odds && odds.ok ? "All systems look healthy." : "Key is set but The Odds API rejected the request — see odds.note."),
  };

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  return response.status(200).json(report);
}

function seasonYear() {
  const now = new Date();
  return now.getMonth() < 6 ? now.getFullYear() - 1 : now.getFullYear();
}

function errString(e) {
  if (!e) return "unknown error";
  if (e.name === "AbortError") return "timed out after 8s";
  return String((e && e.message) || e);
}

/* ───────────── HTML shell ───────────── */

function htmlShell(hasOddsKey) {
  const envBadge = hasOddsKey ? `<span class="badge ok">SET</span>` : `<span class="badge fail">MISSING</span>`;
  const envNote  = hasOddsKey
    ? "Variable is visible to this Function."
    : "Not visible. Add it in Vercel → Settings → Environment Variables, then redeploy.";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><title>CFB Scoreboard — Diagnostics</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{background:#f4f0e7;color:#1d1a15;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;padding:24px}
  h1{font-size:22px;margin:0 0 8px} h2{font-size:12px;margin:24px 0 8px;color:#8a5c07;text-transform:uppercase;letter-spacing:1px}
  table{border-collapse:collapse;width:100%;max-width:960px}
  th{text-align:left;padding:8px 10px;border-bottom:2px solid #cdc3ad;font-size:11px;color:#8b8375;text-transform:uppercase}
  td{padding:10px;border-bottom:1px solid #e4ddcd;vertical-align:top}
  pre{background:#fffdf8;border:1px solid #e4ddcd;padding:12px;border-radius:8px;overflow:auto;font-size:12px;color:#544e44;max-width:960px}
  .meta{color:#8b8375;font-size:13px;margin-bottom:24px} a{color:#8a5c07}
  .badge{padding:2px 8px;border-radius:4px;font-size:11px;color:#fff;font-weight:700}
  .badge.ok{background:#12764a}.badge.fail{background:#a8271b}.badge.pending{background:#8b8375}
  .muted{color:#8b8375;font-size:12px}.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:#6b6459}
</style></head><body>
  <h1>CFB Scoreboard — Deployment Diagnostics</h1>
  <div class="meta">Loaded at <span id="loadedAt"></span> · <a href="?json">Raw JSON</a> · <a href="/">Back to site</a></div>

  <h2>Environment</h2>
  <table><tr><td><strong>THE_ODDS_API_KEY</strong></td><td>${envBadge}</td><td colspan="2" class="muted">${envNote}</td></tr></table>

  <h2>Upstreams</h2>
  <table><thead><tr><th>Source</th><th>Status</th><th>HTTP</th><th>Detail</th></tr></thead>
  <tbody id="upstreams"><tr><td colspan="4" class="muted">contacting upstreams…</td></tr></tbody></table>

  <h2>Hint</h2><p style="color:#544e44;max-width:960px" id="hint">…</p>
  <h2>Raw report</h2><pre id="raw">loading…</pre>

<script>
  document.getElementById("loadedAt").textContent = new Date().toLocaleString();
  function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
  function row(label,info){
    var ok=info&&info.ok;
    var status=info&&info.status!=null?"HTTP "+info.status:(info&&info.error?"error":"—");
    var note=info?(info.note||info.error||info.bodyHint||""):"";
    var extras=[];
    if(info&&info.remaining!=null)extras.push("Quota remaining: "+info.remaining);
    if(info&&info.used!=null)extras.push("Quota used: "+info.used);
    if(info&&info.contentType)extras.push("Content-Type: "+info.contentType);
    return "<tr><td><strong>"+esc(label)+"</strong></td><td><span class='badge "+(ok?"ok":"fail")+"'>"+(ok?"OK":"FAIL")+"</span></td>"
      +"<td class='mono'>"+esc(status)+"</td><td>"+esc(note)
      +(extras.length?"<div class='muted' style='margin-top:4px'>"+esc(extras.join(" · "))+"</div>":"")+"</td></tr>";
  }
  fetch("/api/diag?json",{cache:"no-store"}).then(function(r){return r.json();}).then(function(rep){
    document.getElementById("raw").textContent=JSON.stringify(rep,null,2);
    document.getElementById("hint").textContent=rep.hint||"";
    var u=rep.upstreams||{};
    document.getElementById("upstreams").innerHTML=
      row("The Odds API",u.odds)+row("ESPN site (scoreboard)",u.scoreboard)+row("ESPN core (leaders)",u.leaders)
      +row("ESPN site (news)",u.news)+row("ESPN site (rankings)",u.rankings)+row("ESPN web (standings)",u.standings);
  }).catch(function(e){
    document.getElementById("raw").textContent="Failed to load /api/diag?json: "+(e&&e.message?e.message:e);
    document.getElementById("hint").textContent="The shell loaded but the upstream check did not. Try refreshing.";
  });
</script></body></html>`;
}
