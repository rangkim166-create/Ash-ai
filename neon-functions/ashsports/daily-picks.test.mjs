import test from "node:test";
import assert from "node:assert/strict";
import { formatDailyPicks, selectDailyPicks, isAvailabilityResearchSufficient } from "./daily-picks.mjs";

const now = new Date("2026-10-31T10:00:00.000Z");
const fixture = {
  id: "soccer_epl:event-1", sport: "football", competition: "Premier League",
  home: "Arsenal", away: "Leicester", starts_at: "2026-10-31T18:00:00.000Z"
};
function form(team, wins, draws = 0, losses = 10 - wins - draws) {
  return Array.from({ length: wins + draws + losses }, (_, index) => ({
    sport: "football", team,
    starts_at: new Date(now.getTime() - (index + 1) * 86400000).toISOString(),
    outcome: index < wins ? "W" : index < wins + draws ? "D" : "L"
  }));
}
function odds(matchId = fixture.id, books = 5, observed = now.toISOString(), homePrice = 1.65) {
  const rows = [];
  for (let i = 1; i <= books; i++) {
    const bookmaker = `book-${i}`;
    rows.push(
      { match_id: matchId, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: "Arsenal", decimal_odds: homePrice, observed_at: observed },
      { match_id: matchId, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: "Leicester", decimal_odds: 4.8, observed_at: observed },
      { match_id: matchId, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: "Draw", decimal_odds: 3.9, observed_at: observed }
    );
  }
  return rows;
}

test("selects a supported side only when form, complete market and value checks pass", () => {
  const picks = selectDailyPicks([fixture], odds(), [...form("Arsenal", 8), ...form("Leicester", 3)], { now });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].selection, "Arsenal");
  assert.equal(picks[0].bookmakers, 5);
  assert.ok(picks[0].value_edge_pct >= 1.5);
  assert.ok(picks[0].estimated_probability_pct > picks[0].implied_probability_pct);
});

test("rejects a fixture with only one independent bookmaker", () => {
  const picks = selectDailyPicks([fixture], odds(fixture.id, 1), [...form("Arsenal", 9), ...form("Leicester", 2)], { now });
  assert.equal(picks.length, 0);
});

test("rejects stale bookmaker snapshots", () => {
  const stale = new Date(now.getTime() - 7 * 60 * 60 * 1000).toISOString();
  const picks = selectDailyPicks([fixture], odds(fixture.id, 5, stale), [...form("Arsenal", 9), ...form("Leicester", 2)], { now });
  assert.equal(picks.length, 0);
});

test("rejects missing historical samples instead of guessing", () => {
  const picks = selectDailyPicks([fixture], odds(), [...form("Arsenal", 8), ...form("Leicester", 3).slice(0, 3)], { now });
  assert.equal(picks.length, 0);
});

test("rejects a price with no positive estimated value even when recent form is strong", () => {
  const picks = selectDailyPicks([fixture], odds(fixture.id, 5, now.toISOString(), 1.25),
    [...form("Arsenal", 9), ...form("Leicester", 2)], { now });
  assert.equal(picks.length, 0);
});

test("requires a complete three-way football market including the draw", () => {
  const incomplete = odds().filter(row => row.outcome_name !== "Draw");
  const picks = selectDailyPicks([fixture], incomplete,
    [...form("Arsenal", 9), ...form("Leicester", 2)], { now });
  assert.equal(picks.length, 0);
});

test("does not publish a forced pick when no selection passes", () => {
  const message = formatDailyPicks("31 Oct 2026", []);
  assert.match(message, /No selection passed/);
  assert.match(message, /NO BET/);
});

test("formats selected match with model estimate, value and best bookmaker", () => {
  const picks = selectDailyPicks([fixture], odds(), [...form("Arsenal", 8), ...form("Leicester", 3)], { now });
  const message = formatDailyPicks("31 Oct 2026", picks);
  assert.match(message, /Leicester vs Arsenal/);
  assert.match(message, /Pick: Arsenal @ 1.65/);
  assert.match(message, /Best bookmaker: book-1/);
  assert.match(message, /Ash estimate:/);
  assert.match(message, /Value edge:/);
});

const tennisFixture = {
  id: "tennis_atp:event-elo", sport: "tennis", competition: "ATP",
  home: "Jannik Sinner", away: "Alexander Zverev", starts_at: "2026-10-31T18:00:00.000Z"
};
function sportOdds(match, books = 5, homePrice = 1.8, awayPrice = 2.25) {
  const rows = [];
  for (let i = 1; i <= books; i++) {
    const bookmaker = `sport-book-${i}`;
    rows.push(
      { match_id: match.id, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: match.home, decimal_odds: homePrice, observed_at: now.toISOString() },
      { match_id: match.id, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: match.away, decimal_odds: awayPrice, observed_at: now.toISOString() }
    );
  }
  return rows;
}

test("supports tennis using imported Elo when recent result samples are unavailable", () => {
  const picks = selectDailyPicks([tennisFixture], sportOdds(tennisFixture), [], {
    now,
    ratings: { tennis: { "jannik sinner": 1950, "alexander zverev": 1850 } },
    ratingMatchCounts: { tennis: 361571 }
  });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].selection, "Jannik Sinner");
  assert.equal(picks[0].edge_type, "elo_rating");
  assert.equal(picks[0].rating_edge_points, 100);
  assert.equal(picks[0].historical_match_count, 361571);
  assert.ok(picks[0].value_edge_pct >= 1.5);
  assert.match(formatDailyPicks("31 Oct 2026", picks), /Historical Elo/);
});

test("Elo-only selections still require at least two supporting bookmakers for short odds", () => {
  const picks = selectDailyPicks([tennisFixture], sportOdds(tennisFixture, 1), [], {
    now,
    ratings: { tennis: { "jannik sinner": 1950, "alexander zverev": 1850 } },
    ratingMatchCounts: { tennis: 361571 }
  });
  assert.equal(picks.length, 0);
});

test("Elo-only football can qualify without recent form when the full three-way market and value pass", () => {
  const picks = selectDailyPicks([fixture], odds(fixture.id, 5, now.toISOString(), 1.8), [], {
    now,
    ratings: { football: { arsenal: 1900, leicester: 1800 } },
    ratingMatchCounts: { football: 1395581 }
  });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].edge_type, "elo_rating");
  assert.equal(picks[0].historical_match_count, 1395581);
});

test("rejects a rating signal when the imported archive is too small", () => {
  const picks = selectDailyPicks([tennisFixture], sportOdds(tennisFixture), [], {
    now,
    ratings: { tennis: { "jannik sinner": 1950, "alexander zverev": 1850 } },
    ratingMatchCounts: { tennis: 20 }
  });
  assert.equal(picks.length, 0);
});

test("availability research gate requires fresh multi-source injury and lineup coverage", () => {
  const report = {
    researchedAt: "2026-10-31T09:50:00.000Z", sourceCount: 3, independentDomains: 3,
    coverage: { home: true, away: true, injuryReportingFound: true, lineupReportingFound: true },
    assessment: { confidence: 78, contradictions: [] }
  };
  assert.equal(isAvailabilityResearchSufficient(report, { fixtureStart: "2026-10-31T18:00:00.000Z", now }), true);
  assert.equal(isAvailabilityResearchSufficient({ ...report, sourceCount: 1 }, { fixtureStart: fixture.starts_at, now }), false);
  assert.equal(isAvailabilityResearchSufficient({ ...report, coverage: { ...report.coverage, injuryReportingFound: false } }, { fixtureStart: fixture.starts_at, now }), false);
  assert.equal(isAvailabilityResearchSufficient({ ...report, assessment: { ...report.assessment, confidence: 45 } }, { fixtureStart: fixture.starts_at, now }), false);
});
test("near-kickoff availability research must be refreshed within 20 minutes", () => {
  const report = { researchedAt: "2026-10-31T09:30:00.000Z", sourceCount: 3, independentDomains: 3,
    coverage: { home: true, away: true, injuryReportingFound: true, lineupReportingFound: true },
    assessment: { confidence: 80, contradictions: [] } };
  assert.equal(isAvailabilityResearchSufficient(report, { fixtureStart: "2026-10-31T10:30:00.000Z", now }), false);
});


test("basketball regulation-result markets include the draw in no-vig probabilities", () => {
  const fixture = { id: "basketball:test-regulation", sport: "basketball", competition: "Test League", home: "Home Hoops", away: "Away Hoops", starts_at: "2026-10-31T18:00:00.000Z" };
  const rows = [];
  for (let i = 1; i <= 5; i++) {
    const bookmaker_key = "basket-book-" + i;
    rows.push(
      { match_id: fixture.id, bookmaker_key, market_key: "h2h", outcome_name: fixture.home, decimal_odds: 2.0, observed_at: now.toISOString() },
      { match_id: fixture.id, bookmaker_key, market_key: "h2h", outcome_name: fixture.away, decimal_odds: 4.0, observed_at: now.toISOString() },
      { match_id: fixture.id, bookmaker_key, market_key: "h2h", outcome_name: "Draw", decimal_odds: 3.5, observed_at: now.toISOString() }
    );
  }
  const picks = selectDailyPicks([fixture], rows, [], {
    now,
    ratings: { basketball: { "home hoops": 1700, "away hoops": 1500 } },
    ratingMatchCounts: { basketball: 100000 }
  });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].selection, fixture.home);
  // 1/2.0 divided by (1/2.0 + 1/4.0 + 1/3.5) = 48.3%.
  assert.equal(picks[0].market_probability_pct, 48.3);
});


test("tennis availability gate uses player withdrawal and form evidence instead of team lineups", () => {
 const report = {
  researchedAt: "2026-10-31T09:50:00.000Z", sourceCount: 3, independentDomains: 3,
  coverage: { home: true, away: true, injuryReportingFound: false, withdrawalReportingFound: true,
   categoryCounts: { form_statistics: 2 }, lineupReportingFound: false },
  assessment: { confidence: 78, contradictions: [] }
 };
 assert.equal(isAvailabilityResearchSufficient(report, { fixtureStart: "2026-10-31T18:00:00.000Z", sport: "tennis", now }), true);
 assert.equal(isAvailabilityResearchSufficient({ ...report, coverage: { ...report.coverage, withdrawalReportingFound: false } }, { fixtureStart: "2026-10-31T18:00:00.000Z", sport: "tennis", now }), false);
 assert.equal(isAvailabilityResearchSufficient(report, { fixtureStart: "2026-10-31T18:00:00.000Z", sport: "football", now }), false);
});


test("allows two-book consensus for short odds but keeps long odds at three books", () => {
  const shortOdds = selectDailyPicks([tennisFixture], sportOdds(tennisFixture, 2), [], {
    now,
    ratings: { tennis: { "jannik sinner": 1950, "alexander zverev": 1850 } },
    ratingMatchCounts: { tennis: 361571 }
  });
  assert.equal(shortOdds.length, 1);
  const longRows = odds(fixture.id, 2, now.toISOString(), 4.0);
  const longOdds = selectDailyPicks([fixture], longRows, [...form("Arsenal", 9), ...form("Leicester", 2)], { now });
  assert.equal(longOdds.length, 0);
});


test("does not permanently lock a day after publishing NO BET", async () => {
  const { shouldSkipSentDailyPublication } = await import("./daily-picks.mjs");
  const prior = { status: "sent", picks_count: 0, started_at: "2026-10-31T08:00:00.000Z" };
  assert.equal(shouldSkipSentDailyPublication(prior, "2026-10-31T09:00:00.000Z"), true);
  assert.equal(shouldSkipSentDailyPublication(prior, "2026-10-31T10:01:00.000Z"), false);
  assert.equal(shouldSkipSentDailyPublication({ ...prior, picks_count: 2 }, "2026-10-31T12:00:00.000Z"), true);
  assert.equal(shouldSkipSentDailyPublication({ ...prior, status: "failed" }, "2026-10-31T12:00:00.000Z"), false);
});
