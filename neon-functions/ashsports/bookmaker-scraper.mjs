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
  const marker = /(?:window\.)?__(?:INITIAL_STATE|INITIAL_DATA|APOLLO_STATE|PRELOADED_STATE|STATE|NUXT_DATA)__?\s*=\s*/gi;
  let match;
  while ((match = marker.exec(source)) && found.length < 40) {
    let start = marker.lastIndex;
    while (/\s/.test(source[start] || "")) start++;
    const opening = source[start];
    if (opening !== "{" && opening !== "[") continue;
    const closing = opening === "{" ? "}" : "]";
    let depth = 0, quote = "", escaped = false, end = -1;
    for (let i = start; i < Math.min(source.length, start + 1_500_000); i++) {
      const ch = source[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
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
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*id=["'](?:__NEXT_DATA__|__NUXT_DATA__|__APOLLO_STATE__)["'][^>]*>([\s\S]*?)<\/script>/gi,
    /<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi
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
export function isRealWorldCandidate(candidate) {
  const home = String(candidate?.homeTeam || "").trim();
  const away = String(candidate?.awayTeam || "").trim();
  const event = String(candidate?.eventName || "").trim();
  const competition = String(candidate?.competition || "").trim();
  const sport = String(candidate?.sport || "").trim();
  const descriptor = [event, competition, sport, home, away].join(" ").toLowerCase();
  if (/\b(virtual|zoom|esports?|e-sports?|cyber|simulated|simulation|e-?soccer|e-?football|srl|instant games?)\b/i.test(descriptor)) return false;
  if (/^z\./i.test(home) || /^z\./i.test(away)) return false;
  if (/^\s*(?:team|player)\s*[0-9]+\s*$/i.test(home) || /^\s*(?:team|player)\s*[0-9]+\s*$/i.test(away)) return false;
  return true;
}

export function mapCandidateToFixture(candidate, fixture) {
  if (!isRealWorldCandidate(candidate)) return null;
  const market = String(candidate?.market || "").toLowerCase();
  if (!/^(h2h|1x2|match result|regulation result|full[ -]?time result|match winner|moneyline|winner|to win match)$/.test(market.trim())) return null;
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
  else if (["draw","the draw","tie","x"].includes(selection) && (
    String(fixture.sport).toLowerCase() === "football" ||
    (String(fixture.sport).toLowerCase() === "basketball" && market.trim() === "regulation result")
  )) outcomeName = "Draw";
  if (!outcomeName) return null;
  const price = Number(candidate.decimalOdds);
  if (!Number.isFinite(price) || price <= 1 || price > 1000) return null;
  return { matchId: fixture.id, marketKey: "h2h", outcomeName, decimalOdds: price, line: candidate.line ?? null };
}
function parseUgandaKickoff(value, now = new Date()) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2}),\s*(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const day = Number(match[1]), month = Number(match[2]), hour = Number(match[3]), minute = Number(match[4]);
  if (day < 1 || day > 31 || month < 1 || month > 12 || hour > 23 || minute > 59) return null;
  let year = now.getUTCFullYear();
  let parsed = new Date(Date.UTC(year, month - 1, day, hour - 3, minute));
  const deltaDays = (parsed.getTime() - now.getTime()) / 86_400_000;
  if (deltaDays < -180) parsed = new Date(Date.UTC(year + 1, month - 1, day, hour - 3, minute));
  else if (deltaDays > 180) parsed = new Date(Date.UTC(year - 1, month - 1, day, hour - 3, minute));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function extractVisibleOddsCandidates(text, now = new Date(), fixtures = [], knownTeams = []) {
  const rawText = String(text || "");
  const lines = rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length < 3 && ((fixtures?.length || 0) > 0 || (knownTeams?.length || 0) > 0)) {
    const markers = [...rawText.matchAll(/(\d{1,2}\/\d{1,2},\s*\d{1,2}:\d{2})/g)];
    const flatCandidates = [];
    const aliasOwners = new Map();
    const ignored = new Set(["fc","afc","cf","sc","sv","tsg","ac","1899","real","bayer","borussia","olympique","deportivo","club","athletic","sporting","union"]);
    for (const rawTeam of knownTeams || []) {
      const canonical = String(rawTeam || "").trim();
      const full = normalizeTeam(canonical);
      if (!full) continue;
      const cleaned = full.split(" ").filter(token => !ignored.has(token)).join(" ");
      for (const alias of new Set([full, cleaned])) {
        if (alias.length < 5) continue;
        const owners = aliasOwners.get(alias) || [];
        if (!owners.includes(canonical)) owners.push(canonical);
        aliasOwners.set(alias, owners);
      }
    }
    for (let index = 0; index < markers.length; index++) {
      const marker = markers[index];
      const startsAt = parseUgandaKickoff(marker[1], now);
      if (!startsAt) continue;
      const segment = rawText.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? rawText.length);
      const pricePattern = /(?<![A-Za-z0-9])([1-9]\d{0,2}[.,]\d{1,3})(?![A-Za-z0-9])/g;
      const priceMatches = [...segment.matchAll(pricePattern)];
      const prices = priceMatches.map(match => Number(match[1].replace(",", "."))).filter(price => price > 1 && price <= 1000).slice(0, 3);
      if (prices.length < 2) continue;
      const normalizedTeams = normalizeTeam(segment.slice(0, priceMatches[0]?.index ?? segment.length));
      const startMs = Date.parse(startsAt);
      let best = null;
      for (const fixture of fixtures || []) {
        const kickoff = Date.parse(fixture.starts_at || fixture.startsAt || "");
        if (!Number.isFinite(kickoff) || Math.abs(kickoff - startMs) > 6 * 60 * 60 * 1000) continue;
        const home = normalizeTeam(fixture.home || fixture.home_or_player_one);
        const away = normalizeTeam(fixture.away || fixture.away_or_player_two);
        if (!home || !away) continue;
        const homeIndex = normalizedTeams.indexOf(home);
        const awayIndex = normalizedTeams.indexOf(away);
        if (homeIndex < 0 || awayIndex < 0 || homeIndex >= awayIndex) continue;
        const score = home.length + away.length;
        if (!best || score > best.score) best = {
          homeTeam: fixture.home || fixture.home_or_player_one,
          awayTeam: fixture.away || fixture.away_or_player_two,
          sport: fixture.sport || null,
          competition: fixture.competition || "Public bookmaker fixtures",
          score
        };
      }
      if (!best && prices.length === 3) {
        const matches = [];
        for (const [alias, owners] of aliasOwners) {
          const position = normalizedTeams.indexOf(alias);
          if (position < 0) continue;
          const before = normalizedTeams[position - 1] || " ";
          const after = normalizedTeams[position + alias.length] || " ";
          if (before !== " " || after !== " ") continue;
          const canonical = [...owners].sort((a,b) => normalizeTeam(a).length - normalizeTeam(b).length)[0];
          matches.push({ alias, canonical, start: position, end: position + alias.length });
        }
        let pair = null;
        for (const home of matches) for (const away of matches) {
          if (home === away || home.end > away.start) continue;
          const gap = normalizedTeams.slice(home.end, away.start).trim();
          if (gap && !/^(?:v|vs|at)$/i.test(gap)) continue;
          const trailing = normalizedTeams.slice(away.end).trim();
          if (trailing && trailing.split(" ").length > 1) continue;
          const score = home.alias.length + away.alias.length - gap.length * 2 - trailing.length;
          if (!pair || score > pair.score) pair = { home, away, score };
        }
        if (pair) best = {
          homeTeam: pair.home.canonical,
          awayTeam: pair.away.canonical,
          sport: "football",
          competition: "Public bookmaker fixtures",
          score: pair.score
        };
      }
      if (!best) continue;
      const { homeTeam, awayTeam, sport, competition } = best;
      const eventName = homeTeam + " vs " + awayTeam;
      const market = prices.length === 3 ? "Match Result" : "Match Winner";
      const outcomes = prices.length === 3
        ? [[homeTeam, prices[0]], ["Draw", prices[1]], [awayTeam, prices[2]]]
        : [[homeTeam, prices[0]], [awayTeam, prices[1]]];
      for (const [selection, decimalOdds] of outcomes) flatCandidates.push({
        selection, decimalOdds, market, homeTeam, awayTeam, eventName, sport, competition, startsAt
      });
    }
    return uniqueOdds(flatCandidates);
  }
  const candidates = [];
  const datePattern = /^\d{1,2}\/\d{1,2},\s*\d{1,2}:\d{2}$/;
  const pricePattern = /^\d{1,3}(?:[.,]\d{1,3})$/;
  const marketMarker = /^(?:\+\s*)?\d+\s+markets?$/i;
  for (let i = 0; i < lines.length && candidates.length < 300; i++) {
    if (!datePattern.test(lines[i])) continue;
    const startsAt = parseUgandaKickoff(lines[i], now);
    if (!startsAt) continue;
    let cursor = i + 1;
    const teams = [];
    while (cursor < lines.length && teams.length < 2) {
      const line = lines[cursor];
      if (datePattern.test(line) || pricePattern.test(line) || marketMarker.test(line)) break;
      if (!/^(?:load more|upcoming|highlights|today|tomorrow|live)$/i.test(line)) teams.push(line);
      cursor++;
    }
    if (teams.length !== 2 || teams.some(team => team.length < 2 || team.length > 100)) continue;
    const prices = [];
    while (cursor < lines.length && prices.length < 3 && pricePattern.test(lines[cursor])) {
      const price = Number(lines[cursor].replace(",", "."));
      if (price > 1 && price <= 1000) prices.push(price);
      cursor++;
    }
    if (prices.length < 2) continue;
    const [homeTeam, awayTeam] = teams;
    const eventName = homeTeam + " vs " + awayTeam;
    const market = prices.length === 3 ? "Match Result" : "Match Winner";
    const outcomes = prices.length === 3
      ? [[homeTeam, prices[0]], ["Draw", prices[1]], [awayTeam, prices[2]]]
      : [[homeTeam, prices[0]], [awayTeam, prices[1]]];
    for (const [selection, decimalOdds] of outcomes) candidates.push({
      selection, decimalOdds, market, homeTeam, awayTeam, eventName,
      sport: prices.length === 3 ? "football" : null, startsAt
    });
    i = cursor - 1;
  }
  return candidates;
}

function uniqueOdds(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = [item.eventName || [item.homeTeam, item.awayTeam].join(" vs "), item.selection.toLowerCase(), item.decimalOdds, item.market || "", item.line ?? ""].join("|");
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

const BETPAWA_MARKET_TYPES = ["3743","28000810","28000850","4693","1096755","3795"];
export function buildBetPawaListQuery(now = new Date(), skip = 0, categoryId = "2") {
  const category = String(categoryId);
  if (!["2", "3", "452"].includes(category)) throw new Error("Unsupported real-sport BetPawa category");
  const start = new Date(now);
  return {
    queries: [{
      query: {
        eventType: "UPCOMING",
        categories: [category],
        zones: {},
        hasOdds: true,
        startTime: {
          gte: start.toISOString(),
          lt: new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString()
        }
      },
      view: { marketTypes: BETPAWA_MARKET_TYPES },
      skip: Math.max(0, Math.floor(Number(skip) || 0)),
      take: 50
    }]
  };
}

export function extractBetPawaListEvents(body) {
  const envelope = body?.responses;
  if (!Array.isArray(envelope) || envelope.length === 0) return { status: "malformed", events: [] };
  const first = envelope[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) return { status: "malformed", events: [] };
  if (Array.isArray(first.responses)) return { status: "ok", events: first.responses };
  if (Object.keys(first).length === 0) return { status: "empty", events: [] };
  return { status: "malformed", events: [] };
}

export function extractBetPawaEventCandidates(game) {
  const participants = Array.isArray(game?.participants) ? game.participants : [];
  if (participants.length !== 2) return [];
  const home = participants.find(p => String(p?.type || "").toLowerCase() === "home") || participants[0];
  const away = participants.find(p => String(p?.type || "").toLowerCase() === "away") || participants[1];
  const homeTeam = String(home?.name || "").trim();
  const awayTeam = String(away?.name || "").trim();
  const startsAtDate = new Date(game?.startTime || game?.start_time || "");
  if (!homeTeam || !awayTeam || !Number.isFinite(startsAtDate.getTime())) return [];
  const categoryId = String(game?.category?.id ?? game?.categoryId ?? game?.category_id ?? "");
  const categoryName = String(game?.category?.name || game?.sport?.name || game?.sportName || "").toLowerCase();
  const legacyFootballMarket = !categoryId && !categoryName && (Array.isArray(game?.markets) ? game.markets : [])
    .some(market => String(market?.marketType?.id ?? market?.marketTypeId ?? "") === "3743");
  const sport = categoryId === "2" || /football|soccer/.test(categoryName) || legacyFootballMarket ? "football"
    : categoryId === "3" || /basketball/.test(categoryName) ? "basketball"
    : categoryId === "452" || /tennis/.test(categoryName) ? "tennis" : null;
  if (!sport) return [];
  const competition = String(game?.competition?.name || game?.category?.name || game?.tournament?.name || "BetPawa");
  const eventName = homeTeam + " vs " + awayTeam;
  const candidates = [];
  for (const market of Array.isArray(game?.markets) ? game.markets : []) {
    const typeId = String(market?.marketType?.id ?? market?.marketTypeId ?? "");
    const marketName = String(market?.marketType?.displayName || market?.marketType?.name || market?.name || "").trim();
    const isStandardOneXTwo = sport === "football" && (typeId
      ? typeId === "3743"
      : /^(?:1x2(?:\s*[|/-]\s*full.?time|\s*-\s*ft)?|match result|full.?time result)$/i.test(marketName));
    // BetPawa's verified basketball 1X2 - FT market is regulation time only;
    // its own market explainer explicitly excludes overtime.
    const isBasketballRegulationResult = sport === "basketball" && (typeId
      ? typeId === "3743" && /^(?:1x2(?:\s*[|/-]\s*full.?time|\s*-\s*ft)?)$/i.test(marketName)
      : /^(?:1x2(?:\s*[|/-]\s*full.?time|\s*-\s*ft)?)$/i.test(marketName));
    const isTwoWayWinner = sport !== "football" && /^(?:match winner|winner|to win match|moneyline|match result)$/i.test(marketName);
    if (!isStandardOneXTwo && !isBasketballRegulationResult && !isTwoWayWinner) continue;
    for (const row of Array.isArray(market?.row) ? market.row : []) {
      for (const price of Array.isArray(row?.prices) ? row.prices : []) {
        const decimalOdds = Number(price?.odds ?? price?.odd_value);
        if (!Number.isFinite(decimalOdds) || decimalOdds <= 1 || decimalOdds > 1000) continue;
        const rawSelection = String(price?.name || price?.display || "").trim();
        let selection = rawSelection;
        if (/^(?:1|home)$/i.test(rawSelection)) selection = homeTeam;
        else if (/^(?:x|draw)$/i.test(rawSelection)) selection = "Draw";
        else if (/^(?:2|away)$/i.test(rawSelection)) selection = awayTeam;
        const allowsDraw = sport === "football" || isBasketballRegulationResult;
        if (![homeTeam, awayTeam, ...(allowsDraw ? ["Draw"] : [])].includes(selection)) continue;
        candidates.push({
          selection, decimalOdds,
          market: sport === "football" ? "Match Result" : isBasketballRegulationResult ? "Regulation Result" : "Match Winner",
          homeTeam, awayTeam, eventName, sport, competition, startsAt: startsAtDate.toISOString()
        });
      }
    }
  }
  return uniqueOdds(candidates);
}

async function fetchBetPawaPublicOdds(sourceUrl, now = new Date()) {
  const source = validateSourceUrl(sourceUrl);
  const origin = source.origin;
  const listEndpoint = new URL("/api/sportsbook/v4/events/lists/by-queries", origin);
  const buildListUrl = (skip = 0, categoryId = "2") => {
    const url = new URL(listEndpoint);
    url.searchParams.set("q", JSON.stringify(buildBetPawaListQuery(now, skip, categoryId)));
    return url;
  };
  const baseHeaders = {
    accept: "application/json, text/plain, */*",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36",
    devicetype: "web", dnt: "1", origin,
    referer: origin + "/events?marketId=1X2&categoryId=2&day=tomorrow",
    "x-pawa-language": "en"
  };
  const requestJson = async (url, brand, depth = 0) => {
    if (depth > 2) throw new Error("BetPawa API redirected too many times");
    const headers = { ...baseHeaders };
    if (brand) headers["x-pawa-brand"] = brand;
    const response = await fetch(url, { redirect: "manual", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("BetPawa API redirect missing location");
      const target = validateSourceUrl(new URL(location, url).toString());
      return requestJson(target.toString(), brand, depth + 1);
    }
    if (!response.ok) throw new Error("BetPawa public endpoint returned HTTP " + response.status);
    const finalUrl = validateSourceUrl(response.url || url).toString();
    const body = await response.text();
    if (body.length > MAX_HTML_BYTES) throw new Error("BetPawa JSON response exceeds the 2 MB limit");
    const data = safeJson(body);
    if (!data || typeof data !== "object") throw new Error("BetPawa public endpoint returned invalid JSON");
    return { data, status: response.status, finalUrl };
  };

  let selectedBrand = null, lastError = null, listResults = [];
  for (const brand of ["betpawa-uganda", "betpawa-ug", null]) {
    try {
      const bySport = [];
      for (const categoryId of ["2", "3", "452"]) {
        const pageOffsets = categoryId === "2" ? [0, 50] : [0];
        for (const skip of pageOffsets) {
          const response = await requestJson(buildListUrl(skip, categoryId).toString(), brand);
          const outcome = extractBetPawaListEvents(response.data);
          if (outcome.status === "malformed") throw new Error("BetPawa event-list response shape was not recognized");
          bySport.push({ categoryId, response, events: outcome.events });
          if (outcome.events.length < 50) break;
        }
      }
      listResults = bySport;
      selectedBrand = brand;
      if (bySport.some(group => group.events.length)) break;
    } catch (error) { lastError = error; }
  }
  if (!listResults.length) throw lastError || new Error("BetPawa public event list unavailable");

  const eventMap = new Map();
  for (const group of listResults) for (const event of group.events) {
    const id = String(event?.id ?? event?.eventId ?? "");
    if (id) eventMap.set(group.categoryId + ":" + id, { ...event, __ashCategoryId: group.categoryId });
  }
  const events = [...eventMap.values()]
    .filter(event => event && (event.id != null || event.eventId != null))
    .sort((a,b) => Date.parse(a.startTime || a.start_time || "") - Date.parse(b.startTime || b.start_time || ""))
    .slice(0, 200);
  const structuredData = listResults.map(group => group.response.data);
  const candidates = [], failures = [];
  for (let offset = 0; offset < events.length; offset += 4) {
    const batch = await Promise.all(events.slice(offset, offset + 4).map(async event => {
      const eventId = String(event.id ?? event.eventId);
      const eventUrl = new URL("/api/sportsbook/v4/events/" + encodeURIComponent(eventId), origin);
      try {
        const detail = await requestJson(eventUrl.toString(), selectedBrand);
        const game = detail.data?.data && !Array.isArray(detail.data.data) ? detail.data.data : (detail.data?.event || detail.data);
        const enriched = { ...game, category: game?.category || { id: event.__ashCategoryId, name: event.__ashCategoryId === "2" ? "Football" : event.__ashCategoryId === "3" ? "Basketball" : "Tennis" } };
        return { data: detail.data, candidates: extractBetPawaEventCandidates(enriched), error: null };
      } catch (error) { return { data: null, candidates: [], error: String(error?.message || error).slice(0, 240) }; }
    }));
    for (const result of batch) {
      if (result.data) structuredData.push(result.data);
      if (result.error) failures.push(result.error);
      candidates.push(...result.candidates);
    }
  }
  const unique = uniqueOdds(candidates);
  const lastResponse = listResults.at(-1)?.response;
  return {
    candidates: unique, structuredData, events: events.length, detailFailures: failures.length,
    visibleText: "BetPawa public website JSON: " + events.length + " football, basketball and tennis events, " + unique.length + " match-winner prices",
    finalUrl: lastResponse?.finalUrl || source.toString(), status: lastResponse?.status || 200
  };
}

export function extractBetikaListItems(body) {
  if (Array.isArray(body?.data)) return { status: "ok", items: body.data };
  if (Array.isArray(body?.data?.data)) return { status: "ok", items: body.data.data };
  return { status: "malformed", items: [] };
}

function parseBetikaStartTime(value) {
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value || ""))) {
    const numeric = Number(value);
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const raw = String(value || "").trim();
  const local = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?$/);
  const date = new Date(local ? `${local[1]}T${local[2]}:${local[3] || "00"}+03:00` : raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function extractBetikaEventCandidates(base, detail) {
  const meta = detail?.meta && typeof detail.meta === "object" ? detail.meta : {};
  const game = { ...base, ...meta };
  const homeTeam = String(game.home_team || base?.home_team || "").trim();
  const awayTeam = String(game.away_team || base?.away_team || "").trim();
  const startsAt = parseBetikaStartTime(game.start_time || base?.start_time);
  if (!homeTeam || !awayTeam || !startsAt) return [];
  const sportId = Number(game.sport_id || base?.sport_id || 0);
  const sportLabel = [game.sport_name, game.sport, game.category, game.competition_name, base?.category, base?.competition_name].filter(Boolean).join(" ").toLowerCase();
  // Zoom leagues and virtual/eSoccer events are simulated products, not real fixtures.
  if (game.is_esport === true || base?.is_esport === true || /zoom|virtual|esport|e.?soccer|simulated|cyber/.test(sportLabel)) return [];
  const sport = sportId === 14 || /football|soccer/.test(sportLabel) ? "football"
    : sportId === 30 || /basket/.test(sportLabel) ? "basketball"
    : sportId === 28 || /tennis/.test(sportLabel) ? "tennis" : null;
  const markets = Array.isArray(detail?.data) ? detail.data
    : Array.isArray(detail?.data?.data) ? detail.data.data
    : Array.isArray(game.odds) ? game.odds : [];
  const competition = String(game.competition_name || game.category || "Betika");
  const eventName = homeTeam + " vs " + awayTeam;
  const candidates = [];
  for (const market of markets) {
    const subtype = Number(market?.sub_type_id);
    const marketName = String(market?.name || market?.market_name || "").trim();
    const isFootballResult = sport === "football" && (
      subtype === 1 || /^(?:1x2|match result|full.?time result)$/i.test(marketName)
    );
    // Betika's basketball 1X2 is the regulation-time three-way result.
    // Its separate "WINNER (INCL. OVERTIME)" market is intentionally excluded.
    const isBasketballRegulationResult = sport === "basketball" &&
      subtype === 1 && /^1x2$/i.test(marketName);
    // The full-match tennis winner market has its own subtype (186).
    // Exclude first-set winner and all handicap/total markets.
    const isTennisMatchWinner = sport === "tennis" &&
      subtype === 186 && /^winner$/i.test(marketName);
    if (!isFootballResult && !isBasketballRegulationResult && !isTennisMatchWinner) continue;
    const prices = Array.isArray(market?.odds) ? market.odds : [];
    if (prices.length < 2) continue;
    if (isBasketballRegulationResult && prices.length !== 3) continue;
    if (isTennisMatchWinner && prices.length !== 2) continue;
    if (prices.length === 3 && sport !== "football" && !isBasketballRegulationResult) continue;
    const marketLabel = isBasketballRegulationResult ? "Regulation Result"
      : sport === "football" && prices.length === 3 ? "Match Result" : "Match Winner";
    for (const price of prices) {
      const decimalOdds = Number(price?.odd_value ?? price?.odds);
      if (!Number.isFinite(decimalOdds) || decimalOdds <= 1 || decimalOdds > 1000) continue;
      const rawSelection = String(price?.display || price?.name || "").trim();
      let selection = rawSelection;
      if (/^(?:1|home)$/i.test(rawSelection)) selection = homeTeam;
      else if (/^(?:x|draw)$/i.test(rawSelection)) selection = "Draw";
      else if (/^(?:2|away)$/i.test(rawSelection)) selection = awayTeam;
      const allowsDraw = sport === "football" && prices.length === 3 || isBasketballRegulationResult;
      if (![homeTeam, awayTeam, ...(allowsDraw ? ["Draw"] : [])].includes(selection)) continue;
      candidates.push({
        selection, decimalOdds, market: marketLabel, homeTeam, awayTeam,
        eventName, sport, competition, startsAt
      });
    }
  }
  return uniqueOdds(candidates);
}

async function fetchBetikaPublicOdds(now = new Date()) {
  const apiOrigin = "https://api.betika.com";
  const basePath = "/v1/uo";
  const baseHeaders = {
    accept: "application/json, text/plain, */*",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    "cache-control": "no-cache",
    dnt: "1",
    origin: "https://www.betika.com",
    pragma: "no-cache",
    referer: "https://www.betika.com/en-ug/",
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/134.0.0.0 Safari/537.36"
  };
  const requestJson = async url => {
    const safeUrl = validateSourceUrl(url);
    const response = await fetch(safeUrl.toString(), {
      redirect: "manual",
      headers: baseHeaders,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Betika public endpoint redirect missing location");
      const target = validateSourceUrl(new URL(location, safeUrl).toString());
      return requestJson(target.toString());
    }
    if (!response.ok) throw new Error("Betika public endpoint returned HTTP " + response.status);
    const finalUrl = validateSourceUrl(response.url || safeUrl.toString()).toString();
    const body = await response.text();
    if (body.length > MAX_HTML_BYTES) throw new Error("Betika JSON response exceeds the 2 MB limit");
    const data = safeJson(body);
    if (!data || typeof data !== "object") throw new Error("Betika public endpoint returned invalid JSON");
    return { data, status: response.status, finalUrl };
  };

  const structuredData = [];
  const eventMap = new Map();
  const listUrls = [];
  // Betika's public API accepts one sport ID per request:
  // 14=Soccer, 6=Basketball, 1=Tennis. Sport 139 is Zoom Soccer and excluded.
  // IDs read from Betika's current Uganda public catalogue:
  // 14=Soccer, 30=Basketball, 28=Tennis. Sport 139 is Zoom Soccer.
  const sports = [
    { id: "14", name: "Soccer" },
    { id: "30", name: "Basketball" },
    { id: "28", name: "Tennis" }
  ];
  for (const { id: sportId, name: sportName } of sports) {
    for (const period of [-1, 1]) {
      for (const page of [1, 2]) {
        const listUrl = new URL(basePath + "/matches", apiOrigin);
        for (const [key,value] of Object.entries({
          page: String(page), limit: "50", tab: "upcoming", sub_type_id: "1",
          sport_id: sportId, sort_id: "2", period_id: String(period), esports: "false"
        })) listUrl.searchParams.set(key, value);
        listUrls.push(listUrl.toString());
        try {
          const response = await requestJson(listUrl.toString());
          const outcome = extractBetikaListItems(response.data);
          if (outcome.status === "malformed") throw new Error("Betika event-list response shape was not recognized");
          structuredData.push(response.data);
          for (const event of outcome.items) {
            const id = String(event?.parent_match_id || "");
            if (!id) continue;
            eventMap.set(sportId + ":" + id, {
              ...event,
              sport_id: String(event?.sport_id ?? sportId),
              sport_name: event?.sport_name || sportName
            });
          }
          if (outcome.items.length < 50) break;
        } catch (error) {
          if (page === 1) console.warn("[ash-bookmaker-scraper] Betika sport list unavailable", sportId, String(error?.message || error).slice(0, 180));
          break;
        }
      }
    }
  }
  const bySport = new Map(sports.map(({ id }) => [id, []]));
  for (const event of eventMap.values()) {
    const id = String(event.sport_id || "");
    if (bySport.has(id)) bySport.get(id).push(event);
  }
  // Detail a balanced sample from each verified sport rather than letting
  // football consume the entire 48-event processing budget.
  const events = sports.flatMap(({ id: sportId }) =>
    bySport.get(sportId)
      .sort((a,b) => Date.parse(parseBetikaStartTime(a.start_time) || "") - Date.parse(parseBetikaStartTime(b.start_time) || ""))
      .slice(0, 16)
  ).sort((a,b) => Date.parse(parseBetikaStartTime(a.start_time) || "") - Date.parse(parseBetikaStartTime(b.start_time) || ""));
  const candidates = [];
  const failures = [];
  for (let offset = 0; offset < events.length; offset += 6) {
    const batch = await Promise.all(events.slice(offset, offset + 6).map(async event => {
      const detailUrl = new URL(basePath + "/match", apiOrigin);
      detailUrl.searchParams.set("parent_match_id", String(event.parent_match_id));
      try {
        const detail = await requestJson(detailUrl.toString());
        return { data: detail.data, candidates: extractBetikaEventCandidates(event, detail.data), error: null };
      } catch (error) {
        return { data: null, candidates: [], error: String(error?.message || error).slice(0, 240) };
      }
    }));
    for (const result of batch) {
      if (result.data) structuredData.push(result.data);
      if (result.error) failures.push(result.error);
      candidates.push(...result.candidates);
    }
  }
  const unique = uniqueOdds(candidates);
  return {
    candidates: unique,
    structuredData,
    events: events.length,
    detailFailures: failures.length,
    visibleText: "Betika public website JSON: " + events.length + " events, " + unique.length + " match-result prices",
    finalUrl: listUrls[0],
    status: 200
  };
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
    ('BetPaka','https://ecobetug.com/')
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

async function launchRenderedBrowser() {
  const [{ chromium: playwright }, chromium] = await Promise.all([
    import("playwright-core"),
    import("@sparticuz/chromium")
  ]);
  chromium.default.setGraphicsMode = false;
  return playwright.launch({
    args: chromium.default.args,
    executablePath: await chromium.default.executablePath(),
    headless: true
  });
}

async function createBrowserSession(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.route("**/*", async route => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { return route.abort(); }
    if (url.protocol === "about:" && url.href === "about:blank") return route.continue();
    if (url.protocol !== "https:" || !allowedHost(url.hostname)) return route.abort();
    if (["image", "font", "media"].includes(request.resourceType())) return route.abort();
    return route.continue();
  });
  return { browser, context, page };
}

async function renderBookmakerPage(session, inputUrl) {
  const initialUrl = validateSourceUrl(inputUrl);
  const { page } = session;
  const structuredData = [];
  const responseTasks = [];
  const onResponse = response => {
    const task = (async () => {
      try {
        const url = new URL(response.url());
        if (!allowedHost(url.hostname) || structuredData.length >= 35) return;
        const type = (await response.headerValue("content-type") || "").toLowerCase();
        if (!type.includes("json")) return;
        const body = await response.body();
        if (!body || body.length > MAX_HTML_BYTES) return;
        const parsed = safeJson(body.toString("utf8"));
        if (parsed !== null) structuredData.push(parsed);
      } catch {}
    })();
    responseTasks.push(task);
  };
  page.on("response", onResponse);
  try {
    const response = await page.goto(initialUrl.toString(), { waitUntil: "commit", timeout: 20000 });
    await page.waitForFunction(() => {
      const text = document.body?.innerText || "";
      return /\d{1,2}\/\d{1,2},\s*\d{1,2}:\d{2}/.test(text) && /\d+\s+markets?/i.test(text);
    }, null, { timeout: 8000 }).catch(() => {});
    await Promise.allSettled(responseTasks);
    const browserState = await page.evaluate(() => {
      const keys = ["__INITIAL_STATE__", "__INITIAL_DATA__", "__APOLLO_STATE__", "__PRELOADED_STATE__", "__NUXT__", "__NEXT_DATA__", "__REDUX_STATE__"];
      const state = [];
      for (const key of keys) {
        try {
          const value = window[key] ?? (window.__store && key === "__REDUX_STATE__" ? window.__store.getState?.() : undefined);
          if (value && typeof value === "object") state.push(value);
        } catch {}
      }
      const odds = [...document.querySelectorAll("[data-odds], [data-price], [data-decimal-odds], [data-odd]")]
        .slice(0, 500).map(node => {
          const raw = node.getAttribute("data-odds") || node.getAttribute("data-price") ||
            node.getAttribute("data-decimal-odds") || node.getAttribute("data-odd");
          const price = Number(String(raw || "").replace(",", "."));
          const selection = node.getAttribute("data-selection") || node.getAttribute("data-outcome") ||
            node.getAttribute("aria-label") || node.innerText || "";
          const event = node.closest("[data-event], [data-match], [class*='event'], [class*='match']");
          return Number.isFinite(price) && price > 1 && selection.trim()
            ? { name: selection.trim().slice(0, 140), odds: price,
                market: node.getAttribute("data-market") || event?.getAttribute("data-market") || "Match Result",
                eventName: event?.getAttribute("data-event") || event?.getAttribute("data-match") || event?.innerText?.slice(0, 180) || "" }
            : null;
        }).filter(Boolean);
      return { state, odds, text: document.body?.innerText?.slice(0, 18000) || "" };
    });
    structuredData.push(...browserState.state);
    if (browserState.odds.length) structuredData.push({ outcomes: browserState.odds });
    const html = await page.content();
    if (!html || html.length > MAX_HTML_BYTES) throw new Error("Rendered bookmaker page is empty or exceeds size limit");
    return { html, finalUrl: page.url(), status: response?.status() || 200, contentType: "text/html", structuredData, visibleText: browserState.text };
  } finally {
    page.off("response", onResponse);
  }
}

export async function runBookmakerScrapers(db, { limit = 8 } = {}) {
  await ensureScraperTables(db);
  const sources = await db.query("SELECT id,bookmaker,source_url FROM ash_scraper_sources WHERE enabled=true ORDER BY COALESCE(last_scraped_at,'epoch'::timestamptz) ASC,id ASC LIMIT $1", [Math.max(1, Math.min(20, Number(limit) || 8))]);
  const results = [];
  const fixtureRows = await db.query(`SELECT id,sport,home_or_player_one AS home,away_or_player_two AS away,starts_at
    FROM sports_matches WHERE status='scheduled' AND starts_at>now()+interval '5 minutes'
    AND starts_at<=now()+interval '36 hours' AND COALESCE(source,'')<>'public_scrape' ORDER BY starts_at ASC LIMIT 500`);
  const fixtureMatches = fixtureRows.rows;
  const teamRows = await db.query(`SELECT team FROM (
    SELECT home_or_player_one AS team FROM sports_matches WHERE lower(sport) IN ('football','soccer')
    UNION SELECT away_or_player_two AS team FROM sports_matches WHERE lower(sport) IN ('football','soccer')
  ) known WHERE team IS NOT NULL AND team<>'' ORDER BY length(team) DESC LIMIT 2000`);
  const knownFootballTeams = teamRows.rows.map(row => row.team);
  let browser = null, browserSession = null, browserAttempted = false;
  const getBrowserSession = async () => {
    if (process.env.ASH_BROWSER_SCRAPER_ENABLED !== "true") return null;
    if (browser?.isConnected() && browserSession) return browserSession;
    if (browser) { browser = null; browserSession = null; browserAttempted = false; }
    if (browserAttempted) return null;
    browserAttempted = true;
    try {
      const launched = await launchRenderedBrowser();
      launched.on("disconnected", () => {
        if (browser === launched) { browser = null; browserSession = null; }
        browserAttempted = false;
        console.error("[ash-bookmaker-scraper] Chromium session disconnected; it will be recreated");
      });
      browser = launched;
      browserSession = await createBrowserSession(browser);
      return browserSession;
    } catch (error) {
      if (browser?.isConnected()) await browser.close().catch(() => {});
      browser = null; browserSession = null;
      throw error;
    }
  };
  const renderWithBrowser = async inputUrl => {
    let session = await getBrowserSession();
    if (!session) return null;
    try { return await renderBookmakerPage(session, inputUrl); }
    catch (error) {
      if (!browser?.isConnected()) {
        browser = null; browserSession = null; browserAttempted = false;
        session = await getBrowserSession();
        if (session) return await renderBookmakerPage(session, inputUrl);
      }
      throw error;
    }
  };
  try {
    for (const source of sources.rows) {
      try {
        let apiResult = null, page = null, staticError = null, rendered = null;
        if (String(source.bookmaker).toLowerCase() === "betpawa") {
          try { apiResult = await fetchBetPawaPublicOdds(source.source_url); }
          catch (error) { console.warn("[ash-bookmaker-scraper] BetPawa public JSON fallback:", String(error?.message || error).slice(0, 300)); }
        } else if (String(source.bookmaker).toLowerCase() === "betika") {
          try { apiResult = await fetchBetikaPublicOdds(); }
          catch (error) { console.warn("[ash-bookmaker-scraper] Betika public JSON fallback:", String(error?.message || error).slice(0, 300)); }
        }
        if (apiResult?.candidates?.length) {
          page = { html: "", finalUrl: apiResult.finalUrl, status: apiResult.status, contentType: "application/json" };
        } else {
          try { page = await fetchPublicPage(source.source_url); }
          catch (error) { staticError = error; }
        }
        if (!page) {
          rendered = await renderWithBrowser(source.source_url);
          if (!rendered) throw staticError || new Error("Static bookmaker fetch failed");
          page = rendered;
        }
        let discovered = discoverBookmakerLinks(page.html, page.finalUrl, 12);
        let discoveredSaved = 0;
        for (const item of discovered) {
          const added = await db.query(`INSERT INTO ash_scraper_sources(bookmaker,source_url)
            VALUES($1,$2) ON CONFLICT(source_url) DO NOTHING RETURNING id`, [source.bookmaker, item.url]);
          discoveredSaved += added.rowCount;
        }
        const json = page.contentType.includes("application/json") && page.html ? safeJson(page.html) : null;
        let embedded = [...(apiResult?.structuredData || []), ...(json == null ? extractEmbeddedJson(page.html) : [json])];
        if (rendered?.structuredData?.length) embedded.push(...rendered.structuredData);
        let candidates = uniqueOdds([...(apiResult?.candidates || []), ...embedded.flatMap(item => collectOddsCandidates(item)), ...(rendered?.visibleText ? extractVisibleOddsCandidates(rendered.visibleText, new Date(), fixtureMatches, knownFootballTeams) : [])]);
        if (!candidates.length && !rendered) {
          rendered = await renderWithBrowser(page.finalUrl);
          if (rendered) {
            page = rendered;
            discovered = discoverBookmakerLinks(page.html, page.finalUrl, 12);
            embedded = [...embedded, ...extractEmbeddedJson(page.html), ...(rendered.structuredData || [])];
            candidates = uniqueOdds([...embedded.flatMap(item => collectOddsCandidates(item)), ...(rendered?.visibleText ? extractVisibleOddsCandidates(rendered.visibleText, new Date(), fixtureMatches, knownFootballTeams) : [])]);
          }
        }
        const text = apiResult?.candidates?.length ? apiResult.visibleText : (rendered?.visibleText || (json == null ? cleanText(page.html) : JSON.stringify(json).slice(0, 18_000)));
        const status = candidates.length > 0 ? "success" : "empty";
        const saved = await db.query(`INSERT INTO ash_scraper_runs(
          source_id,bookmaker,source_url,final_url,status,http_status,content_type,extracted_text,structured_data,odds_candidates
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb)
        RETURNING id,fetched_at`, [
          source.id, source.bookmaker, source.source_url, page.finalUrl, status,
          page.status, page.contentType, text, jsonDatabaseValue(db, embedded), jsonDatabaseValue(db, candidates)
        ]);
        await db.query("UPDATE ash_scraper_sources SET last_status=$2,last_error=NULL,last_scraped_at=now(),updated_at=now() WHERE id=$1", [source.id, status]);
        results.push({ sourceId: source.id, bookmaker: source.bookmaker, status, runId: saved.rows[0].id, fetchedAt: saved.rows[0].fetched_at, textCharacters: text.length, structuredBlocks: embedded.length, oddsCandidates: candidates.length, discoveredPages: discovered.length, newPagesQueued: discoveredSaved, rendered: !!rendered, siteJsonUsed: !!apiResult?.candidates?.length, siteJsonEvents: apiResult?.events || 0, siteJsonDetailFailures: apiResult?.detailFailures || 0, finalUrl: page.finalUrl });
      } catch (error) {
        const message = String(error?.message || error).slice(0, 1200);
        await db.query(`INSERT INTO ash_scraper_runs(source_id,bookmaker,source_url,status,error_message)
          VALUES($1,$2,$3,'failed',$4)`, [source.id, source.bookmaker, source.source_url, message]);
        await db.query("UPDATE ash_scraper_sources SET last_status='failed',last_error=$2,last_scraped_at=now(),updated_at=now() WHERE id=$1", [source.id, message]);
        results.push({ sourceId: source.id, bookmaker: source.bookmaker, status: "failed", error: message });
      }
    }
  } finally {
    if (browserSession?.context) await browserSession.context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
  }
  const importedOdds = await importScrapedOdds(db);
  return { sourcesChecked: results.length, discoveredPages: results.reduce((n,x)=>n+Number(x.discoveredPages||0),0), newPagesQueued: results.reduce((n,x)=>n+Number(x.newPagesQueued||0),0), succeeded: results.filter(x => x.status === "success").length, failed: results.filter(x => x.status === "failed").length, renderedSources: results.filter(x => x.rendered).length, siteJsonSources: results.filter(x => x.siteJsonUsed).length, importedOdds, results };
}

export function fixtureFromCandidate(candidate, now = new Date()) {
  if (!isRealWorldCandidate(candidate)) return null;
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

export function createSingleFlight(task) {
  let active = null;
  return (...args) => {
    if (active) return active;
    active = Promise.resolve().then(() => task(...args)).finally(() => { active = null; });
    return active;
  };
}

export function jsonDatabaseValue(db, value) {
  return typeof db?.json === "function" ? db.json(value) : JSON.stringify(value);
}

export async function importScrapedOdds(db) {
  const runs = await db.query("SELECT bookmaker,odds_candidates,fetched_at FROM ash_scraper_runs WHERE status='success' AND fetched_at>now()-interval '6 hours' ORDER BY fetched_at DESC LIMIT 100");
  const fixturesResult = await db.query("SELECT id,sport,home_or_player_one AS home,away_or_player_two AS away,starts_at FROM sports_matches WHERE status='scheduled' AND starts_at>now()-interval '12 hours' AND starts_at<now()+interval '14 days'");
  const fixtures = fixturesResult.rows;
  let saved = 0, unmatched = 0, fixturesCreated = 0;
  for (const run of runs.rows) {
    const bookmakerKey = String(run.bookmaker || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80) || "unknown";
    const candidates = Array.isArray(run.odds_candidates) ? run.odds_candidates : safeJson(run.odds_candidates) || [];
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
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
