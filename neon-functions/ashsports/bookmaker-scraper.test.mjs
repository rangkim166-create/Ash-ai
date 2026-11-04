import test from "node:test";
import assert from "node:assert/strict";
import { addScraperSource, getAllowedBookmakerHosts } from "./bookmaker-scraper.mjs";

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
