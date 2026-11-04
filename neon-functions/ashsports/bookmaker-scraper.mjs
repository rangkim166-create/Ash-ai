const ALLOWED_BOOKMAKER_HOSTS = [
  "betpawa.ug",
  "betika.com",
  "1xbet.ug",
  "22bet.ug",
  "ecobetug.com"
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

function extractAssignedJson(html, found) {
  const source = String(html || "");
  const marker = /(?:window\\.)?__(?:INITIAL_STATE|INITIAL_DATA|APOLLO_STATE|PRELOADED_STATE|STATE|NUXT_DATA)__?\\s*=\\s*/gi;
  let match;
  while ((match = marker.exec(source)) && found.length < 40) {
    let start = marker.lastIndex;
    while (/\\s/.test(source[start] || "")) start++;
    const opening = source[start];
    if (opening !== "{" && opening !== "[") continue;
    const closing = opening === "{" ? "}" : "]";
    let depth = 0, quote = "", escaped = false, end = -1;
    for (let i = start; i < Math.min(source.length, start + 1_500_000); i++) {
      const ch = source[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\\\") escaped = true;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === opening) depth++;
      else if (ch === closing && --depth === 0) { end = i + 1; break; }
    }
    if (end > start) {
      const parsed = safeJson(source.slice(start, end));
      if (parsed !== null) found.push(parsed);
    }
    marker.lastIndex = Math.max(marker.lastIndex, start + 1);
  }
}
export function extractEmbeddedJson(html) {
  const found = [];
  const patterns = [
    /<script[^>]*type=["']application\\/ld\\+json["'][^>]*>([\\s\\S]*?)<\\/script>/gi,
    /<script[^>]*id=["'](?:__NEXT_DATA__|__NUXT_DATA__|__APOLLO_STATE__)["'][^>]*>([\\s\\S]*?)<\\/script>/gi,
    /<script[^>]*type=["']application\\/json["'][^>]*>([\\s\\S]*?)<\\/script>/gi
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(html)) && found.length < 30) {
      const parsed = safeJson(match[1].trim());
      if (parsed !== null) found.push(parsed);
    }
  }
  extractAssignedJson(html, found);
  return found.slice(0, 40);
}
function normalizeTeam(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function parseEventTeams(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const match = text.match(/^(.+?)\s+(?:vs?\.?|v\.|@|[-–—])\s+(.+?)(?:\s+[|•].*)?$/i);
  return match ? { homeTeam: match[1].trim(), awayTeam: match[2].trim() } : {};
}
function candidateContext(object, inherited = {}) {
  const entries = Object.entries(object || {});
  const normalized = Object.fromEntries(entries.map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
  const firstString = keys => keys.map(key => normalized[key]).find(value => typeof value === "string" && value.trim()) || null;
  let homeTeam = firstString(["hometeam","home_team","home","participant1","team1"]);
  let awayTeam = firstString(["awayteam","away_team","away","participant2","team2"]);
  const participants = normalized.participants || normalized.teams;
  if ((!homeTeam || !awayTeam) && Array.isArray(participants) && participants.length >= 2) {
    const label = value => typeof value === "string" ? value : value?.name || value?.label || null;
    homeTeam ||= label(participants[0]); awayTeam ||= label(participants[1]);
  }
  const explicitEvent = firstString(["eventname","event_name","eventtitle","matchname","match_name","fixture","match","event","title"]);
  const namedEvent = firstString(["name"]);
  const eventName = explicitEvent || (parseEventTeams(namedEvent || "").homeTeam ? namedEvent : null) || inherited.eventName || null;
  const parsed = parseEventTeams(eventName || "");
  homeTeam ||= parsed.homeTeam || inherited.homeTeam || null;
  awayTeam ||= parsed.awayTeam || inherited.awayTeam || null;
  return {
    homeTeam, awayTeam, eventName,
    sport: firstString(["sport","sportname"]) || inherited.sport || null,
    competition: firstString(["competition","league","tournament"]) || inherited.competition || null,
    startsAt: firstString(["startdate","starttime","commencetime","starts_at","datetime"]) || inherited.startsAt || null, market: firstString(["market","marketname","market_name"]) || inherited.market || null
  };
}
export function collectOddsCandidates(value, output = [], depth = 0, inherited = {}) {
  if (depth > 9 || output.length >= 250 || value == null) return output;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 500)) collectOddsCandidates(item, output, depth + 1, inherited);
    return output;
  }
  if (typeof value !== "object") return output;
  const entries = Object.entries(value);
  const normalized = Object.fromEntries(entries.map(([key, val]) => [key.toLowerCase(), val]));
  const context = candidateContext(value, inherited);
  const priceValue = normalized.odds ?? normalized.price ?? normalized.decimalodds ?? normalized.value;
  const price = typeof priceValue === "number" ? priceValue : Number(String(priceValue ?? "").replace(",", "."));
  const label = normalized.name ?? normalized.label ?? normalized.selection ?? normalized.outcome ?? normalized.runner ?? normalized.team;
  if (label != null && String(label).trim() && Number.isFinite(price) && price > 1 && price <= 1000) {
    output.push({
      selection: String(label).trim().slice(0, 160), decimalOdds: price,
      market: String(normalized.market ?? normalized.marketname ?? normalized.market_name ?? context.market ?? "").slice(0, 120) || null,
      line: Number.isFinite(Number(normalized.line ?? normalized.handicap ?? normalized.point))
        ? Number(normalized.line ?? normalized.handicap ?? normalized.point) : null,
      homeTeam: context.homeTeam, awayTeam: context.awayTeam, eventName: context.eventName,
      sport: context.sport, competition: context.competition, startsAt: context.startsAt
    });
  }
  for (const [, child] of entries) {
    if (child && typeof child === "object") collectOddsCandidates(child, output, depth + 1, context);
  }
  return output;
}
export function mapCandidateToFixture(candidate, fixture) {
  const market = String(candidate?.market || "").toLowerCase();
  if (!/^(h2h|1x2|match result|full[ -]?time result|match winner|moneyline|winner|to win match)$/.test(market.trim())) return null;
  let home = candidate.homeTeam, away = candidate.awayTeam;
  if (!home || !away) ({ homeTeam: home, awayTeam: away } = parseEventTeams(candidate.eventName || ""));
  const fixtureHome = normalizeTeam(fixture.home), fixtureAway = normalizeTeam(fixture.away);
  const candidateHome = normalizeTeam(home), candidateAway = normalizeTeam(away);
  if (!candidateHome || !candidateAway) return null;
  const sameOrder = candidateHome === fixtureHome && candidateAway === fixtureAway;
  const reverseOrder = candidateHome === fixtureAway && candidateAway === fixtureHome;
  if (!sameOrder && !reverseOrder) return null;
  if (candidate.startsAt && fixture.starts_at) { const delta=Math.abs(new Date(candidate.startsAt).getTime()-new Date(fixture.starts_at).getTime()); if (!Number.isFinite(delta) || delta > 6*60*60*1000) return null; }
  const selection = normalizeTeam(candidate.selection);
  let outcomeName = null;
  if (selection === fixtureHome) outcomeName = fixture.home;
  else if (selection === fixtureAway) outcomeName = fixture.away;
  else if (["draw","the draw","tie","x"].includes(selection) && String(fixture.sport).toLowerCase() === "football") outcomeName = "Draw";
  if (!outcomeName) return null;
  const price = Number(candidate.decimalOdds);
  if (!Number.isFinite(price) || price <= 1 || price > 1000) return null;
  return { matchId: fixture.id, marketKey: "h2h", outcomeName, decimalOdds: price, line: candidate.line ?? null };
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


export function discoverBookmakerLinks(html, baseUrl, limit = 12) {
  const base = validateSourceUrl(baseUrl);
  const found = new Map();
  const pattern = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = pattern.exec(String(html || ""))) && found.size < Math.max(1, Math.min(20, limit))) {
    const href = decodeEntities(match[2]).trim();
    const label = cleanText(match[3]).toLowerCase();
    if (!href || /^(?:javascript:|mailto:|tel:|#)/i.test(href)) continue;
    let url;
    try { url = validateSourceUrl(new URL(href, base).toString()); } catch { continue; }
    if (url.hostname !== base.hostname) continue;
    if (url.pathname === "/" && !url.search) continue;
    const signal = (url.pathname + " " + url.search + " " + label).toLowerCase();
    if (!/(event|match|fixture|sport|football|soccer|tennis|basketball|odds|live|competition|league|premier)/.test(signal)) continue;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    const normalized = url.toString();
    if (!found.has(normalized)) found.set(normalized, { url: normalized, label: label.slice(0, 100) });
  }
  return [...found.values()];
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
    ('BetPawa','https://www.betpawa.ug/'),
    ('Betika','https://www.betika.com/en-ug/'),
    ('1xBet','https://www.1xbet.ug/'),
    ('22Bet','https://22bet.ug/'),
    ('BetPaka','https://www.ecobetug.com/')
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
      const discovered = discoverBookmakerLinks(page.html, page.finalUrl, 12);
      let discoveredSaved = 0;
      for (const item of discovered) {
        const added = await db.query(`INSERT INTO ash_scraper_sources(bookmaker,source_url)
          VALUES($1,$2) ON CONFLICT(source_url) DO NOTHING RETURNING id`, [source.bookmaker, item.url]);
        discoveredSaved += added.rowCount;
      }
      const json = page.contentType.includes("application/json") ? safeJson(page.html) : null;
      const embedded = json == null ? extractEmbeddedJson(page.html) : [json];
      const candidates = uniqueOdds(embedded.flatMap(item => collectOddsCandidates(item)));
      const text = json == null ? cleanText(page.html) : JSON.stringify(json).slice(0, 18_000);
      const status = candidates.length > 0 ? "success" : "empty";
      const saved = await db.query(`INSERT INTO ash_scraper_runs(
        source_id,bookmaker,source_url,final_url,status,http_status,content_type,extracted_text,structured_data,odds_candidates
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
      RETURNING id,fetched_at`, [
        source.id, source.bookmaker, source.source_url, page.finalUrl, status,
        page.status, page.contentType, text, JSON.stringify(embedded), JSON.stringify(candidates)
      ]);
      await db.query("UPDATE ash_scraper_sources SET last_status=$2,last_error=NULL,last_scraped_at=now(),updated_at=now() WHERE id=$1", [source.id, status]);
      results.push({ sourceId: source.id, bookmaker: source.bookmaker, status, runId: saved.rows[0].id, fetchedAt: saved.rows[0].fetched_at, textCharacters: text.length, structuredBlocks: embedded.length, oddsCandidates: candidates.length, discoveredPages: discovered.length, newPagesQueued: discoveredSaved, finalUrl: page.finalUrl });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 300);
      await db.query(`INSERT INTO ash_scraper_runs(source_id,bookmaker,source_url,status,error_message)
        VALUES($1,$2,$3,'failed',$4)`, [source.id, source.bookmaker, source.source_url, message]);
      await db.query("UPDATE ash_scraper_sources SET last_status='failed',last_error=$2,last_scraped_at=now(),updated_at=now() WHERE id=$1", [source.id, message]);
      results.push({ sourceId: source.id, bookmaker: source.bookmaker, status: "failed", error: message });
    }
  }
  const importedOdds = await importScrapedOdds(db);
  return { sourcesChecked: results.length, discoveredPages: results.reduce((n,x)=>n+Number(x.discoveredPages||0),0), newPagesQueued: results.reduce((n,x)=>n+Number(x.newPagesQueued||0),0), succeeded: results.filter(x => x.status === "success").length, failed: results.filter(x => x.status === "failed").length, importedOdds, results };
}

export function fixtureFromCandidate(candidate, now = new Date()) {
  let home = candidate?.homeTeam, away = candidate?.awayTeam;
  if (!home || !away) ({ homeTeam: home, awayTeam: away } = parseEventTeams(candidate?.eventName || ""));
  if (!home || !away) return null;
  const sportText = String(candidate.sport || "").toLowerCase();
  const sport = /tennis/.test(sportText) ? "tennis" : /basketball/.test(sportText) ? "basketball" : /football|soccer/.test(sportText) ? "football" : null;
  if (!sport) return null;
  const starts = new Date(candidate.startsAt || "");
  const current = new Date(now);
  if (!Number.isFinite(starts.getTime()) || !Number.isFinite(current.getTime())) return null;
  if (starts.getTime() < current.getTime() - 12 * 60 * 60 * 1000 || starts.getTime() > current.getTime() + 14 * 24 * 60 * 60 * 1000) return null;
  const slug = [sport, normalizeTeam(home), normalizeTeam(away), starts.toISOString()]
    .join("-").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 145);
  return { id: "public-scrape:" + slug, sport, competition: String(candidate.competition || "Public bookmaker fixtures").slice(0, 180),
    home, away, starts_at: starts.toISOString() };
}

export async function importScrapedOdds(db) {
  const runs = await db.query("SELECT bookmaker,odds_candidates,fetched_at FROM ash_scraper_runs WHERE status='success' AND fetched_at>now()-interval '6 hours' ORDER BY fetched_at DESC LIMIT 100");
  const fixturesResult = await db.query("SELECT id,sport,home_or_player_one AS home,away_or_player_two AS away,starts_at FROM sports_matches WHERE status='scheduled' AND starts_at>now()-interval '12 hours' AND starts_at<now()+interval '14 days'");
  const fixtures = fixturesResult.rows;
  let saved = 0, unmatched = 0, fixturesCreated = 0;
  for (const run of runs.rows) {
    const bookmakerKey = String(run.bookmaker || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || "unknown";
    for (const candidate of Array.isArray(run.odds_candidates) ? run.odds_candidates : []) {
      const scrapedFixture = fixtureFromCandidate(candidate);
      const existingEvent = scrapedFixture ? fixtures.filter(f => normalizeTeam(f.home) === normalizeTeam(scrapedFixture.home) && normalizeTeam(f.away) === normalizeTeam(scrapedFixture.away) && Math.abs(new Date(f.starts_at).getTime()-new Date(scrapedFixture.starts_at).getTime()) <= 6*60*60*1000) : [];
      if (scrapedFixture && !existingEvent.length && !fixtures.some(f => f.id === scrapedFixture.id)) {
        await db.query("INSERT INTO sports_matches(id,sport,competition,home_or_player_one,away_or_player_two,starts_at,status,source,source_updated_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::timestamptz,'scheduled','public_scrape',now(),now()) ON CONFLICT(id) DO UPDATE SET competition=EXCLUDED.competition,source_updated_at=now(),updated_at=now()",
          [scrapedFixture.id,scrapedFixture.sport,scrapedFixture.competition,scrapedFixture.home,scrapedFixture.away,scrapedFixture.starts_at]);
        fixtures.push(scrapedFixture); fixturesCreated++;
      }
      const matches = fixtures.filter(fixture => mapCandidateToFixture(candidate, fixture));
      if (matches.length !== 1) { unmatched++; continue; }
      const mapped = mapCandidateToFixture(candidate, matches[0]);
      const result = await db.query("INSERT INTO bookmaker_odds(match_id,bookmaker_key,market_key,outcome_name,decimal_odds,line,observed_at,source) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,'public_scrape') ON CONFLICT DO NOTHING RETURNING id",
        [mapped.matchId,bookmakerKey,mapped.marketKey,mapped.outcomeName,mapped.decimalOdds,mapped.line,run.fetched_at]);
      saved += result.rowCount;
    }
  }
  return { runs: runs.rowCount, fixtures: fixtures.length, fixturesCreated, oddsSaved: saved, unmatchedCandidates: unmatched, source: "public_scrape" };
}
export async function getScraperStatus(db) {
  await ensureScraperTables(db);
  const sources = await db.query("SELECT id,bookmaker,source_url,enabled,last_status,last_error,last_scraped_at FROM ash_scraper_sources ORDER BY id");
  const runs = await db.query("SELECT id,bookmaker,source_url,final_url,status,http_status,odds_candidates,fetched_at,error_message FROM ash_scraper_runs ORDER BY fetched_at DESC LIMIT 30");
  return { allowedHosts: getAllowedBookmakerHosts(), sources: sources.rows, recentRuns: runs.rows };
}
