// Catch-all proxy: /api/espn-web/* → https://site.web.api.espn.com/*
// Same shape as the espn-core proxy — see that file for context.
//
// Used for endpoints on ESPN's "web" host that are CORS-blocked in the
// browser (standings, byathlete statistics, injuries).

export async function onRequest(context) {
  const segs = Array.isArray(context.params.path)
    ? context.params.path
    : (context.params.path ? [context.params.path] : []);
  const path = segs.join("/");
  const url = new URL(context.request.url);
  const target = `https://site.web.api.espn.com/${path}${url.search}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.espn.com/",
      },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=300, s-maxage=300, stale-while-revalidate=600",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "proxy_failed", target, message: String((err && err.message) || err) }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
