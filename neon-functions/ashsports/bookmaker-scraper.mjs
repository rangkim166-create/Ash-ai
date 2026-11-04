const ALLOWED_BOOKMAKER_HOSTS = [
  "betpawa.com",
  "betika.com",
  "sportybet.com",
  "bet365.com",
  "1xbet.com"
];

const MAX_HTML_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT = "AshSportsResearchBot/1.0 (+public sports data research)";

function allowedHost(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  return ALLOWED_BOOKMAKER_HOSTS.some(root => host === root || host.endsWith("." + root));
}

function validateSourceUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:") throw new Error("Only HTTPS bookmaker pages are allowed");
  if (!allowedHost(url.hostname)) throw new Error("Bookmaker domain is not on Ash's approved source list");
  if (url.username || url.password) throw new Error("Credentials in source URLs are not allowed");
  return url;
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanText(html) {
  return decodeEntities(String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe|header|footer|nav)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()).slice(0, 18_000);
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function extractEmbeddedJson(html) {
  const found = [];
  const patterns = [
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) && found.length < 30) {
      const parsed = safeJson(match[1].trim());
      if (parsed !== null) found.push(parsed);
    }
  }
  return found;
}

function collectOddsCandidates(value, output = [], depth = 0) {
  if (depth > 9 || output.length >= 250 || value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectOddsCandidates(item, output, depth + 1);
    return output;
  }
  if (typeof value !== "object") return output;
  const entries = Object.entries(value);
  const normalized = Object.fromEntries(entries.map(([key, val]) => [key.toLowerCase(), val]));
  const priceValue = normalized.odds ?? normalized.price ?? normalized.decimalodds ?? normalized.value;
  const price = typeof priceValue === "number" ? priceValue : Number(String(priceValue ?? "").replace(",", "."));
  const label = normalized.name ?? normalized.label ?? normalized.selection ?? normalized.outcome ?? normalized.runner ?? normalized.team;
  if (label != null && String(label).trim() && Number.isFinite(price) && price > 1 && price <= 1000) {
    output.push({
      selection: String(label).trim().slice(0, 160),
      decimalOdds: price,
      market: String(normalized.market ?? normalized.marketname ?? normalized.market_name ?? "").slice(0, 120) || null,
      line: Number.isFinite(Number(normalized.line ?? normalized.handicap ?? normalized.point))
        ? Number(normalized.line ?? normalized.handicap ?? normalized.point) : null
    });
  }
  for (const [, child] of entries) {
    if (child && typeof child === "object") collectOddsCandidates(child, output, depth + 1);
  }
  return output;
}

function uniqueOdds(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = [item.selection.toLowerCase(), item.decimalOdds, item.market || "", item.line ?? ""].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 150);
}

async function fetchPublicPage(inputUrl) {
  let url = validateSourceUrl(inputUrl);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const response = await fetch(url, {
      redirect: "manual",
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/json;q=0.9,*/*;q=0.5" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === 3) throw new Error("Too many or invalid redirects");
      url = validateSourceUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error("Source returned HTTP " + response.status);
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("text/html") && !type.includes("application/json") && !type.includes("text/plain")) {
      throw new Error("Unsupported source content type");
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > MAX_HTML_BYTES) throw new Error("Source page exceeds the 2 MB limit");
    const body = await response.text();
    if (body.length > MAX_HTML_BYTES) throw new Error("Source page exceeds the 2 MB limit");
    return { html: body, finalUrl: url.toString(), contentType: type, status: response.status };
  }
  throw new Error("Unable to fetch source");
}

export function getAllowedBookmakerHosts() {
  return [...ALLOWED_BOOKMAKER_HOSTS];
}

export async function ensureScraperTables(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS ash_scraper_sources(
    id bigserial PRIMARY KEY,
    bookmaker text NOT NULL,
    source_url text NOT NULL UNIQUE,
    enabled boolean NOT NULL DEFAULT true,
    last_status text,
    last_error text,
    last_scraped_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS ash_scraper_runs(
    id bigserial PRIMARY KEY,
    source_id bigint REFERENCES ash_scraper_sources(id) ON DELETE SET NULL,
    bookmaker text NOT NULL,
    source_url text NOT NULL,
    final_url text,
    status text NOT NULL,
    http_status integer,
    content_type text,
    extracted_text text,
    structured_data jsonb NOT NULL DEFAULT '[]'::jsonb,
    odds_candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
    error_message text,
    fetched_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.query("CREATE INDEX IF NOT EXISTS ash_scraper_runs_fetched_idx ON ash_scraper_runs(fetched_at DESC)");
  await db.query("CREATE INDEX IF NOT EXISTS ash_scraper_sources_enabled_idx ON ash_scraper_sources(enabled, id)");
  await db.query(`INSERT INTO ash_scraper_sources(bookmaker,source_url) VALUES
    ('BetPawa','https://www.betpawa.com/'),
    ('Betika','https://www.betika.com/'),
    ('SportyBet','https://www.sportybet.com/'),
    ('Bet365','https://www.bet365.com/'),
    ('1xBet','https://1xbet.com/')
    ON CONFLICT(source_url) DO NOTHING`);
}

export async function addScraperSource(db, { bookmaker, url }) {
  await ensureScraperTables(db);
  const safeUrl = validateSourceUrl(url);
  const name = String(bookmaker || safeUrl.hostname.split(".")[0]).trim().slice(0, 80);
  if (!name) throw new Error("Bookmaker name is required");
  const result = await db.query(`INSERT INTO ash_scraper_sources(bookmaker,source_url)
    VALUES($1,$2) ON CONFLICT(source_url) DO UPDATE SET bookmaker=EXCLUDED.bookmaker,
    enabled=true,updated_at=now() RETURNING id,bookmaker,source_url,enabled`, [name, safeUrl.toString()]);
  return result.rows[0];
}

export async function runBookmakerScrapers(db, { limit = 8 } = {}) {
  await ensureScraperTables(db);
  const sources = await db.query("SELECT id,bookmaker,source_url FROM ash_scraper_sources WHERE enabled=true ORDER BY COALESCE(last_scraped_at,'epoch'::timestamptz) ASC,id ASC LIMIT $1", [Math.max(1, Math.min(20, Number(limit) || 8))]);
  const results = [];
  for (const source of sources.rows) {
    try {
      const page = await fetchPublicPage(source.source_url);
      const json = page.contentType.includes("application/json") ? safeJson(page.html) : null;
      const embedded = json == null ? extractEmbeddedJson(page.html) : [json];
      const candidates = uniqueOdds(embedded.flatMap(item => collectOddsCandidates(item)));
      const text = json == null ? cleanText(page.html) : JSON.stringify(json).slice(0, 18_000);
      const status = text.length || embedded.length ? "success" : "empty";
      const saved = await db.query(`INSERT INTO ash_scraper_runs(
        source_id,bookmaker,source_url,final_url,status,http_status,content_type,extracted_text,structured_data,odds_candidates
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
      RETURNING id,fetched_at`, [
        source.id, source.bookmaker, source.source_url, page.finalUrl, status,
        page.status, page.contentType, text, JSON.stringify(embedded), JSON.stringify(candidates)
      ]);
      await db.query("UPDATE ash_scraper_sources SET last_status=$2,last_error=NULL,last_scraped_at=now(),updated_at=now() WHERE id=$1", [source.id, status]);
      results.push({ sourceId: source.id, bookmaker: source.bookmaker, status, runId: saved.rows[0].id, fetchedAt: saved.rows[0].fetched_at, textCharacters: text.length, structuredBlocks: embedded.length, oddsCandidates: candidates.length, finalUrl: page.finalUrl });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      await db.query(`INSERT INTO ash_scraper_runs(source_id,bookmaker,source_url,status,error_message)
        VALUES($1,$2,$3,'failed',$4)`, [source.id, source.bookmaker, source.source_url, message]);
      await db.query("UPDATE ash_scraper_sources SET last_status='failed',last_error=$2,last_scraped_at=now(),updated_at=now() WHERE id=$1", [source.id, message]);
      results.push({ sourceId: source.id, bookmaker: source.bookmaker, status: "failed", error: message });
    }
  }
  return { sourcesChecked: results.length, succeeded: results.filter(x => x.status === "success").length, failed: results.filter(x => x.status === "failed").length, results };
}

export async function getScraperStatus(db) {
  await ensureScraperTables(db);
  const sources = await db.query("SELECT id,bookmaker,source_url,enabled,last_status,last_error,last_scraped_at FROM ash_scraper_sources ORDER BY id");
  const runs = await db.query("SELECT id,bookmaker,source_url,final_url,status,http_status,odds_candidates,fetched_at,error_message FROM ash_scraper_runs ORDER BY fetched_at DESC LIMIT 30");
  return { allowedHosts: getAllowedBookmakerHosts(), sources: sources.rows, recentRuns: runs.rows };
}
