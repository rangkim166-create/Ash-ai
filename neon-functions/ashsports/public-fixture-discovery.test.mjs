import test from "node:test";
import assert from "node:assert/strict";
import {
 buildEspnScoreboardUrl,buildEspnTennisScoreboardUrl,normalizeEspnEvents,normalizeEspnTennisEvents
} from "./public-fixture-discovery.mjs";

test("builds bounded ESPN scoreboard date URLs",()=>{
 const from=new Date("2026-11-10T00:00:00Z"),to=new Date("2026-11-17T00:00:00Z");
 const url=buildEspnScoreboardUrl("soccer","eng.1",from,to);
 assert.match(url,/soccer\/eng\.1\/scoreboard\?dates=20261110-20261117/);
 assert.match(buildEspnTennisScoreboardUrl("atp",from,to),/tennis\/atp\/scoreboard\?dates=20261110-20261117/);
});
test("normalizes only identifiable upcoming real football/basketball events",()=>{
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
test("normalizes nested ATP and WTA singles matches without mislabelling doubles",()=>{
 const now=new Date("2026-11-10T00:00:00Z");
 const payload={events:[{
  id:"tournament-2026",name:"City Open",date:"2026-11-11T00:00:00Z",
  groupings:[
   {grouping:{displayName:"Men's Singles"},competitions:[
    {id:"match-1",date:"2026-11-11T14:00:00Z",round:{displayName:"Quarterfinal"},
     status:{type:{state:"pre",description:"Scheduled"}},
     competitors:[
      {order:2,athlete:{displayName:"Player B"}},
      {order:1,athlete:{displayName:"Player A"}}
     ]}
   ]},
   {grouping:{displayName:"Men's Doubles"},competitions:[
    {id:"doubles-1",date:"2026-11-11T15:00:00Z",competitors:[
     {order:1,athlete:{displayName:"Pair A"}},{order:2,athlete:{displayName:"Pair B"}}
    ]}
   ]}
  ]
 }]};
 const rows=normalizeEspnTennisEvents(payload,{tour:"ATP",now});
 assert.equal(rows.length,1);
 assert.equal(rows[0].id,"espn:tennis:atp:match-1");
 assert.equal(rows[0].sport,"tennis");
 assert.equal(rows[0].home,"Player A");
 assert.equal(rows[0].away,"Player B");
 assert.match(rows[0].competition,/City Open.*Men's Singles.*Quarterfinal/);
 assert.equal(rows[0].status,"scheduled");
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
