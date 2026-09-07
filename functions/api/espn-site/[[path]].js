// Catch-all proxy: /api/espn-site/* → https://site.api.espn.com/*
// Same shape as the espn-core proxy — see that file for context.
//
// site.api.espn.com is CORS-open, so the frontend normally hits it directly.
// This proxy exists as a fallback for networks/browsers that block the
// cross-origin call, and so /api/diag can exercise the same path.

export async function onRequest(context) {
  const segs = Array.isArray(context.params.path)
    ? context.params.path
    : (context.params.path ? [context.params.path] : []);
  const path = segs.join("/");
  const url = new URL(context.request.url);
  const target = `https://site.api.espn.com/${path}${url.search}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.espn.com/",
      },
      // Scoreboard data changes fast during games — keep this cache short.
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    const text = await upstream.text();
    return new Response(text, {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") || "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=60, s-maxage=60, stale-while-revalidate=300",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "proxy_failed", target, message: String((err && err.message) || err) }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    );
  }
}
