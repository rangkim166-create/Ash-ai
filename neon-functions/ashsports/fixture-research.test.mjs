import test from "node:test";
import assert from "node:assert/strict";
import {buildFixtureQueries,classifyEvidenceCategory} from "./fixture-research.mjs";
test("searches injury, lineup, suspension, manager, weather and form topics",()=>{const q=buildFixtureQueries({home:"Arsenal",away:"Chelsea",competition:"Premier League"},new Date("2026-11-04T12:00:00Z"));assert.equal(q.length,12);const s=q.join(" ").toLowerCase();for(const x of ["injury","starting xi","suspensions","press conference","weather forecast","head to head","breaking news","african football","official club"])assert.ok(s.includes(x),x);assert.ok(s.includes("after:2026-10-28"));});
test("tags multiple news coverage categories",()=>{const c=classifyEvidenceCategory("Manager press conference: striker injury doubt, probable starting XI and suspension update");for(const x of ["injury_fitness","lineups","suspensions","manager_training"])assert.ok(c.includes(x),x);});
test("generic headlines remain general news",()=>assert.deepEqual(classifyEvidenceCategory("A look ahead to the weekend"),["general_news"]));

test("searches latest updates on a short freshness window as well as weekly context",()=>{const q=buildFixtureQueries({home:"Vipers SC",away:"KCCA",competition:"Uganda Premier League"},new Date("2026-11-04T12:00:00Z"));const s=q.join(" ");assert.ok(s.includes("after:2026-11-02"));assert.ok(s.includes("after:2026-10-28"));assert.ok(s.includes('"Vipers SC"'));assert.ok(s.includes('"KCCA"'));});
