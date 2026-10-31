import test from "node:test";
import assert from "node:assert/strict";
import { formatDailyPicks, selectDailyPicks } from "./daily-picks.mjs";

const now = new Date("2026-10-31T10:00:00.000Z");
const fixture = {
  id: "soccer_epl:event-1", sport: "football", competition: "Premier League",
  home: "Arsenal", away: "Leicester", starts_at: "2026-10-31T18:00:00.000Z",
};
function form(team, wins, draws = 0, losses = 10 - wins - draws) {
  return Array.from({ length: wins + draws + losses }, (_, index) => ({
    sport: "football", team, starts_at: new Date(now.getTime() - (index + 1) * 86400000).toISOString(),
    outcome: index < wins ? "W" : index < wins + draws ? "D" : "L",
  }));
}
function odds(matchId = fixture.id, books = 5, observed = now.toISOString(), homePrice = 1.65) {
  const rows = [];
  for (let i = 1; i <= books; i++) {
    const bookmaker = `book-${i}`;
    rows.push(
      { match_id: matchId, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: "Arsenal", decimal_odds: homePrice, observed_at: observed },
      { match_id: matchId, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: "Leicester", decimal_odds: 4.8, observed_at: observed },
      { match_id: matchId, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: "Draw", decimal_odds: 3.9, observed_at: observed },
    );
  }
  return rows;
}

test("selects a supported side only when recent form and bookmaker evidence pass", () => {
  const picks = selectDailyPicks([fixture], odds(), [...form("Arsenal", 8), ...form("Leicester", 3)], { now });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].selection, "Arsenal");
  assert.equal(picks[0].bookmakers, 5);
});

test("rejects a fixture with too few bookmakers", () => {
  const picks = selectDailyPicks([fixture], odds(fixture.id, 2), [...form("Arsenal", 9), ...form("Leicester", 2)], { now });
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

test("does not publish a forced pick when no selection passes", () => {
  const message = formatDailyPicks("31 Oct 2026", []);
  assert.match(message, /No selection passed/);
  assert.match(message, /No forced bets/);
});

test("formats each selected match as a copy-ready ticket item", () => {
  const picks = selectDailyPicks([fixture], odds(), [...form("Arsenal", 8), ...form("Leicester", 3)], { now });
  const message = formatDailyPicks("31 Oct 2026", picks);
  assert.match(message, /Leicester vs Arsenal/);
  assert.match(message, /Pick: Arsenal @ 1.65/);
  assert.match(message, /Best bookmaker: book-1/);
});

const tennisFixture = {
  id: "tennis_atp:event-elo", sport: "tennis", competition: "ATP",
  home: "Jannik Sinner", away: "Alexander Zverev", starts_at: "2026-10-31T18:00:00.000Z",
};
function sportOdds(match, books = 5, homePrice = 1.65, awayPrice = 2.25) {
  const rows = [];
  for (let i = 1; i <= books; i++) {
    const bookmaker = `sport-book-${i}`;
    rows.push(
      { match_id: match.id, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: match.home, decimal_odds: homePrice, observed_at: now.toISOString() },
      { match_id: match.id, bookmaker_key: bookmaker, market_key: "h2h", outcome_name: match.away, decimal_odds: awayPrice, observed_at: now.toISOString() },
    );
  }
  return rows;
}

test("supports tennis using imported Elo when recent result samples are unavailable", () => {
  const picks = selectDailyPicks([tennisFixture], sportOdds(tennisFixture), [], {
    now,
    ratings: { tennis: { "jannik sinner": 1950, "alexander zverev": 1850 } },
    ratingMatchCounts: { tennis: 361571 },
  });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].selection, "Jannik Sinner");
  assert.equal(picks[0].edge_type, "elo_rating");
  assert.equal(picks[0].rating_edge_points, 100);
  assert.equal(picks[0].historical_match_count, 361571);
  assert.match(formatDailyPicks("31 Oct 2026", picks), /Historical Elo/);
});

test("Elo-only selections still require at least four supporting bookmakers for short odds", () => {
  const picks = selectDailyPicks([tennisFixture], sportOdds(tennisFixture, 3), [], {
    now,
    ratings: { tennis: { "jannik sinner": 1950, "alexander zverev": 1850 } },
  });
  assert.equal(picks.length, 0);
});
