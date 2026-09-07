// Catch-all proxy: /api/espn-core/* → https://sports.core.api.espn.com/*
//
// Cloudflare Pages `_redirects` external rewrites are flaky for third-party
// hosts; a Pages Function makes the proxy deterministic and lets us attach
// edge caching so repeat visitors don't re-invoke the Worker.
//
// The file path drives the URL: [[path]].js handles ANY number of segments
// under /api/espn-core/. context.params.path is an array of those segments.
//
// Used for: season leaders (sports.core.api.espn.com/v2/sports/football/
// leagues/college-football/seasons/<yr>/types/<t>/leaders) and the athlete /
// team $ref dereferences those leaders point at.

export async function onRequest(context) {
  return proxy(context, "https://sports.core.api.espn.com");
}

async function proxy(context, origin) {
  const segs = Array.isArray(context.params.path)
    ? context.params.path
    : (context.params.path ? [context.params.path] : []);
  const path = segs.join("/");
  const url = new URL(context.request.url);
  const target = `${origin}/${path}${url.search}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        "Accept": "application/json",
        // ESPN's core API returns 403 to data-center IPs unless the UA looks
        // like a real browser. This was the #1 cause of "leaders won't load".
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
