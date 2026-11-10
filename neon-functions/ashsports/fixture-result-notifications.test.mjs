import test from "node:test";
import assert from "node:assert/strict";
import { __test } from "./fixture-result-notifications.mjs";

test("standard scoreboard only emits scored live or completed fixtures",()=>{
  const payload={events:[
    {id:"1",date:"2026-11-10T18:00:00Z",competitions:[{status:{type:{state:"post",description:"Final"}},competitors:[
      {homeAway:"home",team:{displayName:"Home FC"},score:"2"},
      {homeAway:"away",team:{displayName:"Away FC"},score:"1"}
    ]}]},
    {id:"2",competitions:[{status:{type:{state:"in"}},competitors:[
      {homeAway:"home",team:{displayName:"A"},score:"0"},
      {homeAway:"away",team:{displayName:"B"},score:"0"}
    ]}]},
    {id:"3",competitions:[{status:{type:{state:"post"}},competitors:[
      {homeAway:"home",team:{displayName:"C"},score:""},
      {homeAway:"away",team:{displayName:"D"},score:""}
    ]}]}
  ]};
  const rows=__test.rowsFromStandard(payload,"eng.1","football","Premier League");
  assert.equal(rows.length,2);
  assert.equal(rows[0].status,"completed");
  assert.equal(rows[0].homeScore,2);
  assert.equal(rows[1].status,"in_progress");
});
test("tennis parser keeps singles and records final score",()=>{
  const payload={events:[{name:"Tournament",groupings:[
    {grouping:{displayName:"Men's Singles"},competitions:[{id:"m1",date:"2026-11-10",round:{displayName:"Final"},
      status:{type:{state:"post",description:"Final"}},competitors:[
        {order:1,athlete:{displayName:"Player A"},score:"2"},
        {order:2,athlete:{displayName:"Player B"},score:"1"}
      ]}]},
    {grouping:{displayName:"Men's Doubles"},competitions:[{id:"m2",competitors:[]}]}
  ]}]};
  const rows=__test.rowsFromTennis(payload,"ATP");
  assert.equal(rows.length,1);
  assert.equal(rows[0].id,"espn:tennis:atp:m1");
  assert.equal(rows[0].homeScore,2);
});
