// Vercel Function: catch-all proxy /api/espn-web/* -> https://site.web.api.espn.com/*
//
// Vercel routes every path under /api/espn-web/ to this file because of the
// [...path] filename. We read the path off request.url rather than
// request.query so the behaviour doesn't depend on the param name.
//
// Why a proxy at all: this host is CORS-blocked in the browser, so standings and
// byathlete statistics can only be reached server-side.
//
// Caching: Vercel's CDN caches a function response when Cache-Control carries
// s-maxage, so repeat visitors are served from the edge without re-invoking
// this function. (Vercel does not support stale-if-error, so it's omitted.)

const ORIGIN = "https://site.web.api.espn.com";
const PREFIX = "/api/espn-web/";
const MAX_AGE = 300;

export default async function handler(request, response) {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : "";
  const target = `${ORIGIN}/${path}${url.search}`;

  try {
    const upstream = await fetch(target, {
      headers: {
        "Accept": "application/json",
        // ESPN returns 403 to data-centre IPs unless the User-Agent looks like
        // a real browser. This is the single most common cause of a working
        // local page and a broken deployed one.
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.espn.com/",
      },
    });

    const text = await upstream.text();
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json; charset=utf-8");
    response.setHeader("Cache-Control", `public, s-maxage=${MAX_AGE}, stale-while-revalidate=${MAX_AGE * 2}`);
    return response.status(upstream.status).send(text);
  } catch (err) {
    return response.status(502).json({
      error: "proxy_failed",
      target,
      message: String((err && err.message) || err),
    });
  }
}
