import test from "node:test";
import assert from "node:assert/strict";
import { addScraperSource, getAllowedBookmakerHosts, isRealWorldCandidate, collectOddsCandidates, extractEmbeddedJson, mapCandidateToFixture, fixtureFromCandidate, discoverBookmakerLinks, jsonDatabaseValue, extractVisibleOddsCandidates, createSingleFlight, extractBetPawaListEvents, extractBetPawaEventCandidates, buildBetPawaListQuery, extractBetikaListItems, extractBetikaEventCandidates } from "./bookmaker-scraper.mjs";

test("only approved bookmaker host families are enabled", () => {
  assert.deepEqual(getAllowedBookmakerHosts(), [
    "betpawa.ug", "betika.com", "1xbet.ug", "22bet.ug", "ecobetug.com"
  ]);
});

test("rejects non-bookmaker domains before storing a source", async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  await assert.rejects(
    addScraperSource(db, { bookmaker: "attacker", url: "https://example.com/steal" }),
    /not on Ash's approved source list/
  );
});

test("rejects insecure URLs and embedded credentials", async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  await assert.rejects(
    addScraperSource(db, { bookmaker: "BetPawa", url: "http://betpawa.com/" }),
    /Only HTTPS/
  );
  await assert.rejects(
    addScraperSource(db, { bookmaker: "BetPawa", url: "https://user:pass@betpawa.ug/" }),
    /Credentials/
  );
});

test("extracts event context from embedded bookmaker JSON", () => {
  const candidates = collectOddsCandidates({ eventName: "Arsenal vs Chelsea", market: "Match Result", outcomes: [
    { name: "Arsenal", odds: 2.1 }, { name: "Chelsea", odds: 3.2 }, { name: "Draw", odds: 3.4 }
  ] });
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].homeTeam, "Arsenal");
  assert.equal(candidates[0].awayTeam, "Chelsea");
  assert.equal(candidates[0].market, "Match Result");
});
test("maps only exact event, h2h market and valid outcome to an existing fixture", () => {
  const fixture = { id: "fixture-1", sport: "football", home: "Arsenal", away: "Chelsea" };
  const mapped = mapCandidateToFixture({ eventName: "Arsenal vs Chelsea", market: "Match Result", selection: "Arsenal", decimalOdds: 2.1 }, fixture);
  assert.deepEqual(mapped, { matchId: "fixture-1", marketKey: "h2h", outcomeName: "Arsenal", decimalOdds: 2.1, line: null });
  assert.equal(mapCandidateToFixture({ eventName: "Arsenal vs Chelsea", market: "Total Goals", selection: "Over 2.5", decimalOdds: 1.8 }, fixture), null);
  assert.equal(mapCandidateToFixture({ eventName: "Arsenal vs Tottenham", market: "Match Result", selection: "Arsenal", decimalOdds: 2.1 }, fixture), null);
});

test("rejects virtual, esports, cyber and generated fixtures before import", () => {
  for (const candidate of [
    { eventName: "Z.Genoa vs Z.Venezia", sport: "football", competition: "Serie A Zoom" },
    { eventName: "Alpha vs Beta", sport: "eSoccer", competition: "Cyber League" },
    { eventName: "Team 1 vs Team 2", sport: "Football", competition: "Virtual Soccer" },
    { eventName: "Alpha vs Beta", sport: "Football", competition: "Simulated Reality League" }
  ]) {
    assert.equal(isRealWorldCandidate(candidate), false);
    assert.equal(fixtureFromCandidate({ ...candidate, startsAt: "2026-11-04T20:00:00.000Z" }, new Date("2026-11-04T10:00:00.000Z")), null);
  }
  const virtualCandidate = { eventName: "Z.Genoa vs Z.Venezia", sport: "football", competition: "Zoom Soccer", market: "Match Result", selection: "Z.Genoa", decimalOdds: 2.1 };
  assert.equal(mapCandidateToFixture(virtualCandidate, { id: "fixture-virtual", sport: "football", home: "Z.Genoa", away: "Z.Venezia" }), null);
  assert.equal(isRealWorldCandidate({ eventName: "Arsenal vs Chelsea", sport: "football", competition: "Premier League", homeTeam: "Arsenal", awayTeam: "Chelsea" }), true);
});

test("creates a fixture only from explicit sport and valid kickoff metadata", () => {
  const fixture = fixtureFromCandidate({
    eventName: "Arsenal vs Chelsea", sport: "Football", competition: "Premier League",
    startsAt: "2026-11-04T20:00:00.000Z"
  }, new Date("2026-11-04T10:00:00.000Z"));
  assert.equal(fixture.sport, "football");
  assert.equal(fixture.home, "Arsenal");
  assert.equal(fixture.away, "Chelsea");
  assert.equal(fixture.competition, "Premier League");
  assert.match(fixture.id, /^public-scrape:/);
  assert.equal(fixtureFromCandidate({ eventName: "Arsenal vs Chelsea", sport: "Football" }, new Date("2026-11-04T10:00:00.000Z")), null);
});

test("rejects non-Uganda bookmaker domains even when the global brand is familiar", async () => {
  const db = { query: async () => ({ rows: [], rowCount: 0 }) };
  await assert.rejects(addScraperSource(db, { bookmaker: "Bet365", url: "https://www.bet365.com/" }), /not on Ash's approved source list/);
  await assert.rejects(addScraperSource(db, { bookmaker: "1xBet", url: "https://1xbet.com/" }), /not on Ash's approved source list/);
});

test("discovers only relevant public event links on the same approved bookmaker host", () => {
  const html = `
    <a href="/sports/football">Football</a>
    <a href="/event/arsenal-v-chelsea">Arsenal v Chelsea</a>
    <a href="https://example.com/event/other">External event</a>
    <a href="https://www.betpawa.ug/live/match/123?utm_source=home">Live match</a>
    <a href="javascript:alert(1)">bad</a>
    <a href="/terms">Terms</a>`;
  const links = discoverBookmakerLinks(html, "https://www.betpawa.ug/");
  assert.equal(links.length, 3);
  assert.ok(links.some(x => x.url === "https://www.betpawa.ug/event/arsenal-v-chelsea"));
  assert.ok(links.some(x => x.url === "https://www.betpawa.ug/live/match/123"));
  assert.ok(links.some(x => x.url === "https://www.betpawa.ug/sports/football"));
});
test("does not discover links that leave the approved bookmaker host", () => {
  assert.deepEqual(discoverBookmakerLinks('<a href="https://evil.example/event/1">event</a>', "https://www.betpawa.ug/"), []);
});

test("extracts odds from common JavaScript application bootstrap state", () => {
  const html = `<html><script>window.__INITIAL_STATE__ = {"event":{"name":"Arsenal vs Chelsea","market":"Match Result","outcomes":[{"name":"Arsenal","odds":2.1},{"name":"Chelsea","odds":3.2}]}};</script></html>`;
  const blocks = extractEmbeddedJson(html);
  assert.equal(blocks.length, 1);
  const candidates = collectOddsCandidates(blocks[0]);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].homeTeam, "Arsenal");
  assert.equal(candidates[0].decimalOdds, 2.1);
});
test("extracts Next/Nuxt JSON script payloads", () => {
  const html = `<script id="__NUXT_DATA__" type="application/json">{"event":{"name":"Arsenal vs Chelsea","market":"Match Result","outcomes":[{"name":"Arsenal","odds":2.1}]}}</script>`;
  assert.equal(collectOddsCandidates(extractEmbeddedJson(html)[0]).length, 1);
});

test("serializes scraper JSONB payloads with the database JSON helper", () => {
  const payload = [{ selection: "Arsenal", decimalOdds: 2.1 }];
  const db = { json: value => ({ jsonParameter: value }) };
  assert.deepEqual(jsonDatabaseValue(db, payload), { jsonParameter: payload });
});
test("keeps legacy JSON-string odds payloads readable during import", async () => {
  const calls = [];
  const db = { query: async (sql) => {
    calls.push(sql);
    if (sql.startsWith("SELECT bookmaker,odds_candidates")) {
      return { rows: [{ bookmaker: "BetPawa", odds_candidates: '[{"eventName":"Arsenal vs Chelsea","market":"Match Result","selection":"Arsenal","decimalOdds":2.1}]', fetched_at: "2026-11-04T20:00:00Z" }], rowCount: 1 };
    }
    if (sql.startsWith("SELECT id,sport")) return { rows: [{ id: "fixture-1", sport: "football", home: "Arsenal", away: "Chelsea", starts_at: "2026-11-04T20:00:00Z" }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO bookmaker_odds")) return { rows: [{ id: 1 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }};
  const { importScrapedOdds } = await import("./bookmaker-scraper.mjs");
  const result = await importScrapedOdds(db);
  assert.equal(result.runs, 1);
  assert.equal(result.oddsSaved, 1);
  assert.equal(result.unmatchedCandidates, 0);
});

test("extracts real three-way football prices from rendered bookmaker cards", () => {
  const pageText = `Upcoming
International Clubs • UEFA Europa League
05/11, 17:45
Crystal Palace
Hoffenheim
1.89
4.00
3.80
+82 Markets
International Clubs • UEFA Europa League
05/11, 20:00
Leverkusen
Marseille
1.34
6.00
8.00
+82 Markets`;
  const candidates = extractVisibleOddsCandidates(pageText, new Date("2026-11-05T00:00:00Z"));
  assert.equal(candidates.length, 6);
  assert.equal(candidates[0].homeTeam, "Crystal Palace");
  assert.equal(candidates[0].awayTeam, "Hoffenheim");
  assert.equal(candidates[0].selection, "Crystal Palace");
  assert.equal(candidates[0].decimalOdds, 1.89);
  assert.equal(candidates[1].selection, "Draw");
  assert.equal(candidates[1].decimalOdds, 4);
  assert.equal(candidates[2].selection, "Hoffenheim");
  assert.equal(candidates[2].decimalOdds, 3.8);
  assert.equal(candidates[0].startsAt, "2026-11-05T14:45:00.000Z");
});
test("visible bookmaker odds map to the matching scheduled fixture", () => {
  const [candidate] = extractVisibleOddsCandidates(`05/11, 17:45
Crystal Palace
Hoffenheim
1.89
4.00
3.80
+82 Markets`, new Date("2026-11-05T00:00:00Z"));
  const mapped = mapCandidateToFixture(candidate, {
    id: "fixture-1", sport: "football", home: "Crystal Palace", away: "Hoffenheim",
    starts_at: "2026-11-05T14:45:00.000Z"
  });
  assert.equal(mapped.outcomeName, "Crystal Palace");
  assert.equal(mapped.decimalOdds, 1.89);
});
test("extracts two-way match-winner prices without inventing a draw", () => {
  const candidates = extractVisibleOddsCandidates(`05/11, 18:00
Player A
Player B
1.75
2.10
+12 Markets`, new Date("2026-11-05T00:00:00Z"));
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].market, "Match Winner");
  assert.equal(candidates.some(candidate => candidate.selection === "Draw"), false);
});

test("coalesces overlapping bookmaker scraper invocations", async () => {
  let calls = 0;
  let release;
  const runOnce = createSingleFlight(() => {
    calls++;
    return new Promise(resolve => { release = resolve; });
  });
  const first = runOnce({ limit: 8 });
  const second = runOnce({ limit: 8 });
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  release("shared-result");
  assert.equal(await first, "shared-result");
  const next = runOnce({ limit: 8 });
  await Promise.resolve();
  assert.equal(calls, 2);
  release("next-result");
  assert.equal(await next, "next-result");
});

test("extracts flat football odds using known historical team names", () => {
  const pageText = "Soccer Betting | Football Betting Odds | Betika - Uganda " +
    "International Clubs • UEFA Europa League 05/11, 17:45 Crystal Palace Hoffenheim 1.89 4.00 3.80 Upcoming Live +82 Markets";
  const candidates = extractVisibleOddsCandidates(pageText, new Date("2026-11-05T00:00:00Z"), [], [
    "Crystal Palace FC", "TSG 1899 Hoffenheim", "AC Milan", "Bayer Leverkusen"
  ]);
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].homeTeam, "Crystal Palace FC");
  assert.equal(candidates[0].awayTeam, "TSG 1899 Hoffenheim");
  assert.equal(candidates[0].sport, "football");
  assert.equal(candidates[0].decimalOdds, 1.89);
});
test("does not create flat-text fixtures from unknown team pairs", () => {
  const pageText = "05/11, 17:45 Mystery Club Other Mystery 1.90 3.50 4.00 Upcoming Live +82 Markets";
  assert.equal(extractVisibleOddsCandidates(pageText, new Date("2026-11-05T00:00:00Z"), [], ["Known FC"]).length, 0);
});

test("BetPawa event pagination covers seven days in bounded 50-event pages", () => {
  const now = new Date("2026-11-06T00:00:00.000Z");
  const first = buildBetPawaListQuery(now, 0).queries[0];
  const second = buildBetPawaListQuery(now, 50).queries[0];
  const basketball = buildBetPawaListQuery(now, 0, "3").queries[0];
  const tennis = buildBetPawaListQuery(now, 0, "452").queries[0];
  assert.equal(first.query.startTime.gte, now.toISOString());
  assert.equal(first.query.startTime.lt, "2026-11-13T00:00:00.000Z");
  assert.equal(first.take, 50);
  assert.equal(first.skip, 0);
  assert.equal(second.skip, 50);
  assert.deepEqual(first.query.categories, ["2"]);
  assert.deepEqual(basketball.query.categories, ["3"]);
  assert.deepEqual(tennis.query.categories, ["452"]);
  assert.throws(() => buildBetPawaListQuery(now, 0, "101"), /Unsupported real-sport/);
  assert.equal(first.query.eventType, "UPCOMING");
});

test("reads BetPawa public event-list response envelopes", () => {
  const events = [{ id: 101 }, { id: 102 }];
  assert.deepEqual(extractBetPawaListEvents({ responses: [{ responses: events }] }), { status: "ok", events });
  assert.deepEqual(extractBetPawaListEvents({ responses: [{}] }), { status: "empty", events: [] });
  assert.deepEqual(extractBetPawaListEvents({ unexpected: true }), { status: "malformed", events: [] });
});
test("extracts BetPawa 1X2 prices from its public event JSON", () => {
  const game = {
    id: 101,
    startTime: "2026-11-05T14:45:00.000Z",
    competition: { name: "Premier League" },
    participants: [
      { name: "Arsenal", type: "home" },
      { name: "Chelsea", type: "away" }
    ],
    markets: [
      {
        marketType: { id: 3743, displayName: "1X2" },
        row: [{ prices: [
          { name: "1", odds: "2.10" },
          { name: "X", odds: "3.40" },
          { name: "2", odds: "3.80" }
        ] }]
      },
      {
        marketType: { id: 28000810, displayName: "1X2 1UP | Full Time" },
        row: [{ prices: [
          { name: "1", odds: "1.98" },
          { name: "X", odds: "3.45" },
          { name: "2", odds: "1.61" }
        ] }]
      },
      {
        marketType: { id: 28000850, displayName: "1X2 2UP | Full Time" },
        row: [{ prices: [
          { name: "1", odds: "3.01" },
          { name: "X", odds: "3.45" },
          { name: "2", odds: "2.10" }
        ] }]
      },
      {
        marketType: { id: 9999, displayName: "Over/Under" },
        row: [{ prices: [{ name: "Over 2.5", odds: "1.95" }] }]
      }
    ]
  };
  const candidates = extractBetPawaEventCandidates(game);
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].homeTeam, "Arsenal");
  assert.equal(candidates[0].awayTeam, "Chelsea");
  assert.equal(candidates[0].selection, "Arsenal");
  assert.equal(candidates[0].decimalOdds, 2.1);
  assert.equal(candidates[1].selection, "Draw");
  assert.equal(candidates[1].decimalOdds, 3.4);
  assert.equal(candidates[2].selection, "Chelsea");
  assert.equal(candidates[2].market, "Match Result");
  assert.equal(candidates[2].sport, "football");
});
test("rejects incomplete BetPawa event JSON rather than guessing teams", () => {
  assert.deepEqual(extractBetPawaEventCandidates({ participants: [{ name: "Arsenal" }] }), []);
  assert.deepEqual(extractBetPawaEventCandidates({
    startTime: "2026-11-05T14:45:00Z",
    participants: [{ name: "Arsenal" }, { name: "Chelsea" }],
    markets: []
  }), []);
});

test("reads Betika public match-list payloads without treating malformed data as empty", () => {
  const items = [{ parent_match_id: 101 }, { parent_match_id: 102 }];
  assert.deepEqual(extractBetikaListItems({ data: items }), { status: "ok", items });
  assert.deepEqual(extractBetikaListItems({ data: { data: items } }), { status: "ok", items });
  assert.deepEqual(extractBetikaListItems({ data: null }), { status: "malformed", items: [] });
});
test("extracts Betika football 1X2 prices and converts Uganda kickoff to UTC", () => {
  const base = {
    parent_match_id: 101, home_team: "Arsenal", away_team: "Chelsea",
    start_time: "2026-11-05 17:45:00", sport_id: 14, competition_name: "Premier League"
  };
  const detail = {
    meta: { sport_id: 14 },
    data: [{ sub_type_id: 1, name: "Fulltime Result", odds: [
      { display: "1", odd_value: "2.10" },
      { display: "X", odd_value: "3.40" },
      { display: "2", odd_value: "3.80" }
    ] }]
  };
  const candidates = extractBetikaEventCandidates(base, detail);
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].sport, "football");
  assert.equal(candidates[0].homeTeam, "Arsenal");
  assert.equal(candidates[0].selection, "Arsenal");
  assert.equal(candidates[0].decimalOdds, 2.1);
  assert.equal(candidates[0].startsAt, "2026-11-05T14:45:00.000Z");
  assert.equal(candidates[1].selection, "Draw");
  assert.equal(candidates[2].selection, "Chelsea");
});
test("extracts Betika two-way basketball match-winner prices", () => {
  const base = {
    parent_match_id: 202, home_team: "Lakers", away_team: "Celtics",
    start_time: "2026-11-05 18:00:00", sport_id: 6, competition_name: "NBA"
  };
  const detail = {
    meta: { sport_id: 6, sport_name: "Basketball" },
    data: [{ sub_type_id: 1, name: "Match Winner", odds: [
      { display: "Home", odd_value: "1.80" },
      { display: "Away", odd_value: "2.05" }
    ] }]
  };
  const candidates = extractBetikaEventCandidates(base, detail);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].sport, "basketball");
  assert.equal(candidates[0].market, "Match Winner");
  assert.equal(candidates[0].selection, "Lakers");
  assert.equal(candidates[1].selection, "Celtics");
});

test("rejects Betika Zoom Soccer even when its sport ID resembles basketball", () => {
  const base = {
    parent_match_id: 752051, home_team: "Z.Genoa", away_team: "Z.Venezia",
    start_time: "2026-11-06 04:45:00", sport_id: 139,
    sport_name: "Zoom Soccer", competition_name: "SerieA-Zoom", is_esport: false
  };
  const detail = { meta: { sport_id: 139 }, data: [{ sub_type_id: 1, name: "1X2", odds: [
    { display: "1", odd_value: "2.46" }, { display: "X", odd_value: "3.40" }, { display: "2", odd_value: "2.78" }
  ] }] };
  assert.deepEqual(extractBetikaEventCandidates(base, detail), []);
});
test("rejects explicitly flagged Betika esports and virtual matches", () => {
  const base = {
    home_team: "Alpha", away_team: "Beta", start_time: "2026-11-06 18:00:00",
    sport_id: 14, is_esport: true
  };
  const detail = { data: [{ sub_type_id: 1, name: "1X2", odds: [
    { display: "1", odd_value: "2.10" }, { display: "X", odd_value: "3.20" }, { display: "2", odd_value: "3.30" }
  ] }] };
  assert.deepEqual(extractBetikaEventCandidates(base, detail), []);
});


test("extracts BetPawa basketball and tennis match-winner prices without inventing a draw", () => {
  const base = {
    startTime: "2026-11-07T18:00:00.000Z",
    participants: [{ name: "Player or Team A" }, { name: "Player or Team B" }]
  };
  const basketball = extractBetPawaEventCandidates({
    ...base, category: { id: "3", name: "Basketball" },
    competition: { name: "NBA" },
    markets: [{ marketType: { displayName: "Match Winner" }, row: [{ prices: [
      { name: "1", odds: "1.80" }, { name: "2", odds: "2.05" }
    ] }] }]
  });
  assert.equal(basketball.length, 2);
  assert.equal(basketball[0].sport, "basketball");
  assert.equal(basketball[0].market, "Match Winner");
  assert.equal(basketball.some(x => x.selection === "Draw"), false);

  const tennis = extractBetPawaEventCandidates({
    ...base, category: { id: "452", name: "Tennis" },
    competition: { name: "ATP Challenger" },
    markets: [{ marketType: { displayName: "Match Winner" }, row: [{ prices: [
      { name: "1", odds: "1.65" }, { name: "2", odds: "2.30" }
    ] }] }]
  });
  assert.equal(tennis.length, 2);
  assert.equal(tennis[0].sport, "tennis");
  assert.equal(tennis[1].selection, "Player or Team B");
});

test("BetPawa non-football extractor rejects football 1X2 and unrelated markets", () => {
  const candidates = extractBetPawaEventCandidates({
    startTime: "2026-11-07T18:00:00.000Z",
    category: { id: "452", name: "Tennis" },
    participants: [{ name: "Player A" }, { name: "Player B" }],
    markets: [
      { marketType: { id: "3743", displayName: "1X2" }, row: [{ prices: [
        { name: "1", odds: "1.5" }, { name: "X", odds: "4.0" }, { name: "2", odds: "2.5" }
      ] }] },
      { marketType: { displayName: "Total Games" }, row: [{ prices: [{ name: "Over 22.5", odds: "1.9" }] }] }
    ]
  });
  assert.deepEqual(candidates, []);
});


test("extracts BetPawa basketball regulation-time 1X2 with a correctly labelled draw", () => {
  const candidates = extractBetPawaEventCandidates({
    startTime: "2026-11-07T18:00:00.000Z",
    category: { id: "3", name: "Basketball" },
    competition: { name: "NBA" },
    participants: [{ name: "Lakers" }, { name: "Celtics" }],
    markets: [{
      marketType: {
        id: "3743",
        name: "1X2 - FT",
        displayName: "1X2 | Full Time",
        explainer: "Result is based on regular playing time only - Overtime does not count."
      },
      row: [{ prices: [
        { name: "1", odds: "2.10" },
        { name: "X", odds: "12.00" },
        { name: "2", odds: "1.75" }
      ] }]
    }]
  });
  assert.equal(candidates.length, 3);
  assert.equal(candidates[0].sport, "basketball");
  assert.equal(candidates[0].market, "Regulation Result");
  assert.deepEqual(candidates.map(x => x.selection), ["Lakers", "Draw", "Celtics"]);
  const draw = mapCandidateToFixture(candidates[1], {
    id: "basketball-regulation-1", sport: "basketball",
    home: "Lakers", away: "Celtics"
  });
  assert.equal(draw.outcomeName, "Draw");
  assert.equal(draw.decimalOdds, 12);
});

test("does not mislabel BetPawa basketball regulation draw as an overtime match winner", () => {
  const candidates = extractBetPawaEventCandidates({
    startTime: "2026-11-07T18:00:00.000Z",
    category: { id: "3", name: "Basketball" },
    participants: [{ name: "Lakers" }, { name: "Celtics" }],
    markets: [{
      marketType: { id: "3743", name: "1X2 - FT", displayName: "1X2 | Full Time" },
      row: [{ prices: [
        { name: "1", odds: "2.10" }, { name: "X", odds: "12.00" }, { name: "2", odds: "1.75" }
      ] }]
    }]
  });
  assert.equal(candidates.some(x => x.market === "Match Winner"), false);
  assert.equal(candidates.some(x => x.market === "Regulation Result" && x.selection === "Draw"), true);
});


test("extracts Betika two-way tennis match-winner prices from verified sport ID 1", () => {
  const base = {
    parent_match_id: 303, home_team: "Player A", away_team: "Player B",
    start_time: "2026-11-06 12:30:00", sport_id: 1, competition_name: "ATP Challenger"
  };
  const detail = {
    meta: { sport_id: 1, sport_name: "Tennis" },
    data: [{ sub_type_id: 1, name: "Match Winner", odds: [
      { display: "Home", odd_value: "1.72" },
      { display: "Away", odd_value: "2.15" }
    ] }]
  };
  const candidates = extractBetikaEventCandidates(base, detail);
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].sport, "tennis");
  assert.equal(candidates[0].market, "Match Winner");
  assert.equal(candidates[0].selection, "Player A");
  assert.equal(candidates[1].selection, "Player B");
});

test("Betika tennis and basketball extraction never fabricates a draw", () => {
  for (const sportId of [1, 6]) {
    const candidates = extractBetikaEventCandidates({
      home_team: "Player A", away_team: "Player B",
      start_time: "2026-11-06 12:30:00", sport_id: sportId
    }, {
      meta: { sport_id: sportId },
      data: [{ sub_type_id: 1, name: "1X2", odds: [
        { display: "1", odd_value: "1.72" },
        { display: "X", odd_value: "4.00" },
        { display: "2", odd_value: "2.15" }
      ] }]
    });
    assert.deepEqual(candidates, []);
  }
});
