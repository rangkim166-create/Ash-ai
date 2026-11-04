import test from "node:test";
import assert from "node:assert/strict";
import { addScraperSource, getAllowedBookmakerHosts, collectOddsCandidates, mapCandidateToFixture, fixtureFromCandidate } from "./bookmaker-scraper.mjs";

test("only approved bookmaker host families are enabled", () => {
  assert.deepEqual(getAllowedBookmakerHosts(), [
    "betpawa.com", "betika.com", "sportybet.com", "bet365.com", "1xbet.com"
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
    addScraperSource(db, { bookmaker: "BetPawa", url: "https://user:pass@betpawa.com/" }),
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
