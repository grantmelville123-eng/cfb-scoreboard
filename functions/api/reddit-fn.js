// Cloudflare Pages Function: server-side Reddit fetch with a proper User-Agent.
//
// File path → URL: this file → /api/reddit-fn
//
// Why this exists: Reddit rate-limits or blocks requests whose User-Agent
// looks like a stock browser or HTTP library — mobile Safari especially. A
// passive redirect proxy forwards the original UA, so those get blocked too.
// A Function lets us *set* a unique UA that Reddit accepts.
//
// Caching: Cloudflare's edge holds the JSON for 5 minutes, so every visitor in
// that window shares one upstream call and we stay far under Reddit's per-IP
// rate limit.

export async function onRequest(context) {
  const url   = new URL(context.request.url);
  const sub   = (url.searchParams.get("sub")   || "CFB").replace(/[^a-zA-Z0-9_]/g, "");
  const limit = (url.searchParams.get("limit") || "15").replace(/[^0-9]/g, "") || "15";
  const target = `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`;

  try {
    const res = await fetch(target, {
      headers: {
        // Reddit's rules recommend "platform:appname:version (by /u/username)"
        // but accept most unique, non-generic strings.
        "User-Agent": "CFBScoreboard/1.0 (+https://cfb-scoreboard.pages.dev) by anonymous",
        "Accept": "application/json",
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });

    if (!res.ok) {
      return new Response(JSON.stringify({ error: "reddit_upstream", status: res.status }), {
        status: res.status,
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
      });
    }

    const text = await res.text();
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "fetch_failed", message: String((err && err.message) || err) }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
