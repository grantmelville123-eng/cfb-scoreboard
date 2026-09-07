// Vercel Function: server-side Reddit fetch with a proper User-Agent.
//
// File path -> URL: this file -> /api/reddit-fn
//
// Why this exists: Reddit rate-limits or blocks requests whose User-Agent
// looks like a stock browser or HTTP library -- mobile Safari especially. A
// server-side call lets us set a unique UA that Reddit accepts.
//
// Caching: Vercel's CDN holds the JSON for 5 minutes, so every visitor in that
// window shares one upstream call and we stay far under Reddit's rate limit.

export default async function handler(request, response) {
  const url   = new URL(request.url, `https://${request.headers.host}`);
  const sub   = (url.searchParams.get("sub")   || "CFB").replace(/[^a-zA-Z0-9_]/g, "");
  const limit = (url.searchParams.get("limit") || "15").replace(/[^0-9]/g, "") || "15";
  const target = `https://www.reddit.com/r/${sub}/hot.json?limit=${limit}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        // Reddit's rules recommend "platform:appname:version (by /u/username)"
        // but accept most unique, non-generic strings.
        "User-Agent": "CFBScoreboard/1.0 (+https://cfb-scoreboard.vercel.app) by anonymous",
        "Accept": "application/json",
      },
    });

    if (!upstream.ok) {
      response.setHeader("Cache-Control", "public, s-maxage=60");
      return response.status(upstream.status).json({ error: "reddit_upstream", status: upstream.status });
    }

    const text = await upstream.text();
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    return response.status(200).send(text);
  } catch (err) {
    return response.status(502).json({ error: "fetch_failed", message: String((err && err.message) || err) });
  }
}
