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

test("maps final scores onto bookmaker fixture IDs using exact participants and kickoff",()=>{
  const { mapScoreToFixture } = __test;
  const fixture={sport:"football",starts_at:"2026-11-13T18:00:00Z",
    home_or_player_one:"Atlético Madrid",away_or_player_two:"Real Madrid"};
  const same=mapScoreToFixture({sport:"football",startsAt:"2026-11-13T18:05:00Z",
    home:"Atletico Madrid",away:"Real Madrid",homeScore:2,awayScore:1},fixture);
  assert.deepEqual(same,{homeScore:2,awayScore:1,reversed:false});
  const reversed=mapScoreToFixture({sport:"football",startsAt:"2026-11-13T18:05:00Z",
    home:"Real Madrid",away:"Atletico Madrid",homeScore:1,awayScore:3},fixture);
  assert.deepEqual(reversed,{homeScore:3,awayScore:1,reversed:true});
  assert.equal(mapScoreToFixture({sport:"tennis",startsAt:"2026-11-13T18:05:00Z",
    home:"Real Madrid",away:"Atletico Madrid",homeScore:1,awayScore:3},fixture),null);
  assert.equal(mapScoreToFixture({sport:"football",startsAt:"2026-11-14T02:01:00Z",
    home:"Atletico Madrid",away:"Real Madrid",homeScore:2,awayScore:1},fixture),null);
});
