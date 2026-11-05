import test from "node:test";
import assert from "node:assert/strict";
import { addScraperSource, getAllowedBookmakerHosts, collectOddsCandidates, extractEmbeddedJson, mapCandidateToFixture, fixtureFromCandidate, discoverBookmakerLinks, jsonDatabaseValue, extractVisibleOddsCandidates, createSingleFlight, extractBetPawaListEvents, extractBetPawaEventCandidates } from "./bookmaker-scraper.mjs";

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
