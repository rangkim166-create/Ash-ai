import test from "node:test";
import assert from "node:assert/strict";
import {
 buildEspnScoreboardUrl,buildEspnTennisScoreboardUrl,normalizeEspnEvents,normalizeEspnTennisEvents,discoverPublicFixtures
} from "./public-fixture-discovery.mjs";

test("builds ESPN scoreboard URLs for exactly one calendar day",()=>{
 const day="20261110";
 assert.equal(buildEspnScoreboardUrl("soccer","eng.1",day),"https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=20261110");
 assert.equal(buildEspnTennisScoreboardUrl("atp",day),"https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard?dates=20261110");
 assert.throws(()=>buildEspnScoreboardUrl("soccer","eng.1","20261110-20261117"),/YYYYMMDD/);
});
test("normalizes only identifiable upcoming real football/basketball events",()=>{
 const now=new Date("2026-11-10T00:00:00Z");
 const rows=normalizeEspnEvents({events:[
  {id:"abc",date:"2026-11-11T18:00:00Z",competitions:[{competitors:[
   {homeAway:"home",team:{displayName:"Chelsea"}},{homeAway:"away",team:{displayName:"Arsenal"}}
  ],status:{type:{state:"pre"}}}]},
  {id:"bad",date:"not-a-date",competitions:[{competitors:[]}]}
 ]},{sport:"football",league:"eng.1",competition:"Premier League",now});
 assert.equal(rows.length,1);assert.equal(rows[0].home,"Chelsea");assert.equal(rows[0].away,"Arsenal");
 assert.equal(rows[0].status,"scheduled");
});
test("normalizes nested ATP and WTA singles matches without mislabelling doubles",()=>{
 const now=new Date("2026-11-10T00:00:00Z");
 const payload={events:[{id:"tournament-2026",name:"City Open",date:"2026-11-11T00:00:00Z",groupings:[
  {grouping:{displayName:"Men's Singles"},competitions:[
   {id:"match-1",date:"2026-11-11T14:00:00Z",round:{displayName:"Quarterfinal"},status:{type:{state:"pre",description:"Scheduled"}},
    competitors:[{order:2,athlete:{displayName:"Player B"}},{order:1,athlete:{displayName:"Player A"}}]}]},
  {grouping:{displayName:"Men's Doubles"},competitions:[{id:"doubles-1",date:"2026-11-11T15:00:00Z",competitors:[
   {order:1,athlete:{displayName:"Pair A"}},{order:2,athlete:{displayName:"Pair B"}}]}]}
 ]}]};
 const rows=normalizeEspnTennisEvents(payload,{tour:"ATP",now});
 assert.equal(rows.length,1);assert.equal(rows[0].id,"espn:tennis:atp:match-1");
 assert.equal(rows[0].sport,"tennis");assert.equal(rows[0].home,"Player A");assert.equal(rows[0].away,"Player B");
 assert.match(rows[0].competition,/City Open.*Men's Singles.*Quarterfinal/);assert.equal(rows[0].status,"scheduled");
});
test("rejects tennis matches without two players, valid times or stable ids",()=>{
 const now=new Date("2026-11-10T00:00:00Z");
 const rows=normalizeEspnTennisEvents({events:[{name:"Open",groupings:[{grouping:{displayName:"Women's Singles"},competitions:[
  {id:"missing-player",date:"2026-11-11T10:00:00Z",competitors:[{athlete:{displayName:"Only One"}}]},
  {id:"bad-time",date:"bad",competitors:[{order:1,athlete:{displayName:"A"}},{order:2,athlete:{displayName:"B"}}]},
  {id:"missing-time",competitors:[{order:1,athlete:{displayName:"A"}},{order:2,athlete:{displayName:"B"}}]},
  {date:"2026-11-11T10:00:00Z",competitors:[{order:1,athlete:{displayName:"A"}},{order:2,athlete:{displayName:"B"}}]}
 ]}]}]},{tour:"WTA",now});
 assert.equal(rows.length,0);
});
test("discovery requests one day per scoreboard, deduplicates events and upserts fixtures",async()=>{
 const now=new Date("2026-11-10T00:00:00Z"),urls=[],saved=[];
 const fetchImpl=async url=>{
  urls.push(url);
  assert.match(new URL(url).searchParams.get("dates"),/^\\d{8}$/,"no multi-day ESPN ranges");
  const date=new URL(url).searchParams.get("dates");
  return {ok:true,status:200,text:async()=>JSON.stringify({events:date==="20261111"?[
   {id:"same-event",date:"2026-11-11T18:00:00Z",competitions:[{competitors:[
    {homeAway:"home",team:{displayName:"Chelsea"}},{homeAway:"away",team:{displayName:"Arsenal"}}]}]}
  ]:[]})};
 };
 const db={query:async(_sql,values)=>{saved.push(values);return{rowCount:1,rows:[{id:values[0]}]};}};
 const result=await discoverPublicFixtures(db,{now,fetchImpl,leagues:[["soccer","eng.1","Premier League"]],tennisTours:[],concurrency:1});
 assert.ok(urls.length>=14);assert.equal(new Set(urls.map(x=>new URL(x).searchParams.get("dates"))).size,urls.length);
 assert.equal(result.eventsFound,1);assert.equal(result.fixturesUpserted,1);assert.equal(saved.length,1);
 assert.equal(result.errors.length,0);
});
