import test from "node:test";
import assert from "node:assert/strict";
import { parseFinalScore, settleHeadToHead } from "./results-tracker.mjs";

test("only accepts explicitly completed fixtures with both named scores",()=>{
 const final={completed:true,scores:[{name:"Home FC",score:"2"},{name:"Away FC",score:"1"}]};
 assert.deepEqual(parseFinalScore(final,"Home FC","Away FC"),{homeScore:2,awayScore:1});
 assert.equal(parseFinalScore({...final,completed:false},"Home FC","Away FC"),null);
 assert.equal(parseFinalScore(final,"Other","Away FC"),null);
 assert.equal(parseFinalScore({completed:true,scores:null},"Home FC","Away FC"),null);
});
test("settles home and away h2h selections and treats a draw as a losing team pick",()=>{
 assert.equal(settleHeadToHead("Home FC","Home FC","Away FC",2,1),"won");
 assert.equal(settleHeadToHead("Away FC","Home FC","Away FC",2,1),"lost");
 assert.equal(settleHeadToHead("Home FC","Home FC","Away FC",1,1),"lost");
 assert.equal(settleHeadToHead("Draw","Home FC","Away FC",1,1),null);
});
test("normalizes accents and punctuation when matching participants",()=>{
 assert.equal(settleHeadToHead("Atletico-Madrid","Atlético Madrid","Real Madrid",3,0),"won");
});
