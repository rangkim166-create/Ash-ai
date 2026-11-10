import test from "node:test";
import assert from "node:assert/strict";
import { buildScoutResearchQueries, normalizeScoutTeam, validateScoutSignal } from "./scout-signals.mjs";

test("normalizes club names consistently", () => {
  assert.equal(normalizeScoutTeam("Chelsea FC"), "chelsea");
});
test("validates and bounds user scouting signals", () => {
  assert.deepEqual(validateScoutSignal({team:"Chelsea",sport:"football",opinion:"not_win",reason:"I think they lose"}), {
    sport:"football",team:"Chelsea",normalizedTeam:"chelsea",opinion:"not_win",reason:"I think they lose"
  });
  assert.throws(() => validateScoutSignal({team:"x",opinion:"maybe"}), /team_or_player_required/);
});
test("turns a not-win opinion into explicit draw and upset research", () => {
  const queries = buildScoutResearchQueries({team:"Chelsea",sport:"football",opinion:"not_win",reason:""});
  assert.ok(queries.some(q => q.includes("failure to win upset draw loss")));
  assert.ok(queries.some(q => q.includes("contrary predictions upset risk")));
  const reasoned = buildScoutResearchQueries({team:"Chelsea",sport:"football",opinion:"not_win",reason:"poor away form and missing striker"});
  assert.ok(reasoned.some(q => q.includes("poor away form and missing striker")));
});
