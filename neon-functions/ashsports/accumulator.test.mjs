import test from "node:test";
import assert from "node:assert/strict";
import { buildAccumulator, formatAccumulator } from "./accumulator.mjs";

const pick=(id,price,prob=65)=>({id,price,estimated_probability_pct:prob,value_edge_pct:2,
 evidence_index:70,research_gate:"approved",availability_research_gate:"approved",
 home_team:"Home "+id,away_team:"Away "+id,selection:"Home "+id,best_bookmaker:"book",
 bookmakers:3});
test("builds a near-2 accumulator from distinct approved fixtures",()=>{
 const result=buildAccumulator([pick("a",1.4),pick("b",1.45),pick("c",1.8)]);
 assert.equal(result.status,"QUALIFIED");
 assert.ok(result.combined_odds>=1.8&&result.combined_odds<=2.2);
 assert.equal(new Set(result.legs.map(x=>x.id)).size,result.legs.length);
});
test("does not force a bet when no research-qualified combination exists",()=>{
 const result=buildAccumulator([pick("a",1.2),{...pick("b",1.2),research_gate:"held_no_bet"}]);
 assert.equal(result.status,"NO_BET");
});
test("formats a clear no-bet result",()=>{
 assert.match(formatAccumulator("26 Nov 2026",{status:"NO_BET",reason:"No evidence"}),/NO BET/);
});
