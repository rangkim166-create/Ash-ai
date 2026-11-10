import test from "node:test";
import assert from "node:assert/strict";
import { assessExpertConsensus } from "./expert-consensus.mjs";

const recent = new Date().toISOString();
const pick = {selection:"Arsenal",home_team:"Arsenal",away_team:"Chelsea"};

test("requires two independent recent sources to support an exact team selection",()=>{
 const pages=[
  {domain:"bbc.com",date:recent,title:"Arsenal vs Chelsea prediction",excerpt:"Pundit backs Arsenal to win this match."},
  {domain:"espn.com",date:recent,title:"Arsenal expected to win",excerpt:"Our prediction is Arsenal victory."}
 ];
 const result=assessExpertConsensus(pick,pages);
 assert.equal(result.decision,"SUPPORT");
 assert.equal(result.confidence,70);
 assert.equal(result.supportingSources.length,2);
});

test("duplicate publisher pages do not count as independent support",()=>{
 const pages=[
  {domain:"bbc.com",date:recent,title:"Arsenal prediction",excerpt:"Back Arsenal to win."},
  {domain:"www.bbc.com",date:recent,title:"Arsenal match tip",excerpt:"Arsenal are tipped to win."}
 ];
 assert.equal(assessExpertConsensus(pick,pages).decision,"INSUFFICIENT");
});

test("opposing expert language blocks a selection",()=>{
 const pages=[
  {domain:"bbc.com",date:recent,title:"Arsenal vs Chelsea prediction",excerpt:"Back Arsenal to win."},
  {domain:"espn.com",date:recent,title:"Chelsea to beat Arsenal",excerpt:"Our prediction backs Chelsea to win."}
 ];
 assert.notEqual(assessExpertConsensus(pick,pages).decision,"SUPPORT");
});

test("stale and undated sources cannot support a selection",()=>{
 const pages=[
  {domain:"bbc.com",date:"2020-01-01",title:"Arsenal prediction",excerpt:"Arsenal will win."},
  {domain:"espn.com",title:"Arsenal prediction",excerpt:"Arsenal will win."}
 ];
 assert.equal(assessExpertConsensus(pick,pages).decision,"INSUFFICIENT");
});

test("draws and non-team markets are not incorrectly assessed",()=>{
 assert.equal(assessExpertConsensus({...pick,selection:"Draw"},[]).decision,"INSUFFICIENT");
});
