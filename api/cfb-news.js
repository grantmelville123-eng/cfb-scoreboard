// Vercel Function: aggregated college-football headlines from several outlets.
//
// File path -> URL: this file -> /api/cfb-news
// Query: ?limit=40
//
// WHY THIS EXISTS
// ---------------
// The page originally had two feeds: ESPN's JSON news API and r/CFB. Reddit
// returns 403 to Vercel's data-centre IPs regardless of User-Agent, so that
// tab can't be relied on. This pulls a spread of outlets over plain RSS
// instead, merges them, de-duplicates the same story filed by several sites,
// and sorts by recency.
//
// Every feed is fetched with its own timeout and its own try/catch: one dead
// feed costs its own slot and nothing else. The response includes a `sources`
// array reporting ok/count/error per feed, so /api/diag and a quick curl can
// tell you which outlet went dark without reading any logs.
//
// Sports Illustrated's college-football feed was in this list and returned a
// hard 404 from production, so it was removed. Add outlets here freely — a bad
// URL costs its own slot and shows up as ok:false in the response.
//
// No XML dependency — these are well-formed, boring feeds and a regex reader
// keeps the function dependency-free and instant to cold-start.

const CACHE_SECONDS = 15 * 60;
const FEED_TIMEOUT_MS = 6000;

const FEEDS = [
  { name: "ESPN",         url: "https://www.espn.com/espn/rss/ncf/news" },
  { name: "CBS Sports",   url: "https://www.cbssports.com/rss/headlines/college-football/" },
  { name: "Yahoo Sports", url: "https://sports.yahoo.com/college-football/rss.xml" },
  // Google News is the widest net — it surfaces The Athletic, 247Sports, On3
  // and local beat writers that have no usable feed of their own. Its item
  // titles carry a " - Outlet" suffix, which we split out as the source.
  { name: "Google News",  url: "https://news.google.com/rss/search?q=college+football+when:2d&hl=en-US&gl=US&ceid=US:en", split: true },
];

export default async function handler(request, response) {
  const url = new URL(request.url, `https://${request.headers.host}`);
  const limit = Math.min(60, Math.max(5, parseInt(url.searchParams.get("limit") || "40", 10) || 40));

  const settled = await Promise.all(FEEDS.map(readFeed));

  const sources = settled.map(s => ({ name: s.name, ok: s.ok, count: s.items.length, error: s.error || null }));

  // Merge, drop repeats of the same story, newest first.
  const seen = new Set();
  const items = settled
    .flatMap(s => s.items)
    .filter(it => {
      const key = dedupeKey(it.title);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .slice(0, limit);

  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader(
    "Cache-Control",
    `public, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=${CACHE_SECONDS * 2}`
  );
  return response.status(200).json({ at: Date.now(), sources, items });
}

async function readFeed(feed) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), FEED_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctl.signal,
      headers: {
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) return { name: feed.name, ok: false, items: [], error: `HTTP ${res.status}` };
    const xml = await res.text();
    return { name: feed.name, ok: true, items: parseFeed(xml, feed) };
  } catch (e) {
    const error = e && e.name === "AbortError" ? `timed out after ${FEED_TIMEOUT_MS}ms` : String((e && e.message) || e);
    return { name: feed.name, ok: false, items: [], error };
  } finally {
    clearTimeout(timer);
  }
}

/** Handles both RSS 2.0 (<item>) and Atom (<entry>). */
function parseFeed(xml, feed) {
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  const out = [];

  for (const block of blocks.slice(0, 30)) {
    let title = text(block, "title");
    if (!title) continue;

    // RSS puts the URL in <link>text</link>; Atom uses <link href="…"/>.
    let link = text(block, "link");
    if (!link) {
      const m = block.match(/<link\b[^>]*href=["']([^"']+)["']/i);
      if (m) link = m[1];
    }
    if (!link) continue;

    const when = text(block, "pubDate") || text(block, "published") || text(block, "updated") || "";
    const ts = when ? Date.parse(when) : 0;

    // Google News titles read "Headline - The Athletic"; pull the outlet out so
    // the card can label the real publisher rather than "Google News".
    let source = feed.name;
    if (feed.split) {
      const tagged = text(block, "source");
      const dash = title.lastIndexOf(" - ");
      if (tagged) { source = tagged; if (dash > 20) title = title.slice(0, dash); }
      else if (dash > 20) { source = title.slice(dash + 3); title = title.slice(0, dash); }
    }

    out.push({
      title: title.trim(),
      link: link.trim(),
      source,
      published: when || null,
      ts: Number.isFinite(ts) ? ts : 0,
    });
  }
  return out;
}

/** Pull one tag's text, unwrapping CDATA and decoding the handful of entities
 *  that actually show up in headlines. */
function text(block, tag) {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  let v = m[1].trim();
  const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  if (cdata) v = cdata[1];
  return decode(v.replace(/<[^>]+>/g, "")).trim();
}

function decode(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Same story from three outlets should appear once. Compare on a squashed
 *  prefix of the headline rather than the URL, which never matches. */
function dedupeKey(title) {
  return String(title || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 55);
}
