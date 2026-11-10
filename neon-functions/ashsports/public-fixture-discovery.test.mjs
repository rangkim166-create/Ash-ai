import test from "node:test";
import assert from "node:assert/strict";
import { buildEspnScoreboardUrl, normalizeEspnEvents } from "./public-fixture-discovery.mjs";

test("builds bounded ESPN scoreboard date URLs",()=>{
 const url=buildEspnScoreboardUrl("soccer","eng.1",new Date("2026-11-10T00:00:00Z"),new Date("2026-11-17T00:00:00Z"));
 assert.match(url,/soccer\/eng\.1\/scoreboard\?dates=20261110-20261117/);
});
test("normalizes only identifiable upcoming real events",()=>{
 const now=new Date("2026-11-10T00:00:00Z");
 const rows=normalizeEspnEvents({events:[
  {id:"abc",date:"2026-11-11T18:00:00Z",competitions:[{competitors:[
   {homeAway:"home",team:{displayName:"Chelsea"}},{homeAway:"away",team:{displayName:"Arsenal"}}
  ],status:{type:{state:"pre"}}}]},
  {id:"bad",date:"not-a-date",competitions:[{competitors:[]}]}
 ]},{sport:"football",league:"eng.1",competition:"Premier League",now});
 assert.equal(rows.length,1);
 assert.equal(rows[0].home,"Chelsea");
 assert.equal(rows[0].away,"Arsenal");
 assert.equal(rows[0].status,"scheduled");
});
