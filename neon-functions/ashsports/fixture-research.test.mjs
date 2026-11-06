import test from "node:test";
import assert from "node:assert/strict";
import {buildFixtureQueries,classifyEvidenceCategory} from "./fixture-research.mjs";
test("searches injury, lineup, suspension, manager, weather and form topics",()=>{const q=buildFixtureQueries({home:"Arsenal",away:"Chelsea",competition:"Premier League"},new Date("2026-11-04T12:00:00Z"));assert.equal(q.length,14);const s=q.join(" ").toLowerCase();for(const x of ["injury","starting xi","suspensions","press conference","weather forecast","head to head","breaking news","african football","official club"])assert.ok(s.includes(x),x);assert.ok(s.includes("after:2026-10-28"));});
test("tags multiple news coverage categories",()=>{const c=classifyEvidenceCategory("Manager press conference: striker injury doubt, probable starting XI and suspension update");for(const x of ["injury_fitness","lineups","suspensions","manager_training"])assert.ok(c.includes(x),x);});
test("generic headlines remain general news",()=>assert.deepEqual(classifyEvidenceCategory("A look ahead to the weekend"),["general_news"]));

test("searches latest updates on a short freshness window as well as weekly context",()=>{const q=buildFixtureQueries({home:"Vipers SC",away:"KCCA",competition:"Uganda Premier League"},new Date("2026-11-04T12:00:00Z"));const s=q.join(" ");assert.ok(s.includes("after:2026-11-02"));assert.ok(s.includes("after:2026-10-28"));assert.ok(s.includes('Vipers SC'));assert.ok(s.includes('KCCA'));});

import { parseRss, isFixtureRelevantResult, hasParticipantCoverage } from "./fixture-research.mjs";

test("retains RSS descriptions and source metadata for blocked article fallbacks", () => {
  const xml = `<?xml version="1.0"?><rss><channel><item>
    <title>Arsenal team news: injury update</title>
    <link>https://news.example/sports/arsenal</link>
    <description><![CDATA[Arsenal manager provided a squad fitness update ahead of the match, with further details expected before kickoff.]]></description>
    <pubDate>Wed, 04 Nov 2026 10:00:00 GMT</pubDate>
    <source url="https://news.example">News Example</source>
  </item></channel></rss>`;
  const [item] = parseRss(xml);
  assert.equal(item.title, "Arsenal team news: injury update");
  assert.match(item.description, /squad fitness update/);
  assert.equal(item.domain, "news.example");
  assert.ok(item.categories.includes("injury_fitness"));
});

test("decodes HTML entities in RSS snippets and keeps publisher domain", () => {
 const xml = "<rss><channel><item><title>Arsenal injury update</title><link>https://news.google.com/rss/articles/example</link><description>&lt;p&gt;Arsenal manager confirmed a fresh injury update and fitness test before the weekend match.&lt;/p&gt;</description><pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate><source url=\"https://www.bbc.com/sport\">BBC Sport</source></item></channel></rss>";
 const [item] = parseRss(xml);
 assert.match(item.description, /Arsenal manager confirmed a fresh injury update/);
 assert.equal(item.domain, "bbc.com");
 assert.equal(item.sourceName, "BBC Sport");
 assert.ok(item.categories.includes("injury_fitness"));
});
test("rejects unrelated news returned for a fixture search", () => {
 const fixture = { home: "Al-Kholood", away: "Al-Khaleej" };
 assert.equal(isFixtureRelevantResult({title:"Al-Fateh vs Al Riyadh prediction",description:"Saudi league match preview"},fixture),false);
 assert.equal(isFixtureRelevantResult({title:"Al-Kholood team news",description:"Squad update"},fixture),true);
 assert.equal(isFixtureRelevantResult({title:"Al-Khaleej injury update",description:"Fitness news"},fixture),true);
});


test("tennis research searches player-specific injury, withdrawal, form and tournament context", () => {
 const queries = buildFixtureQueries({sport:"tennis",home:"Jannik Sinner",away:"Alexander Zverev",competition:"ATP Finals"},new Date("2026-11-04T12:00:00Z"));
 const all = queries.join(" ").toLowerCase();
 assert.equal(queries.length,14);
 for (const term of ["tennis","withdrawal","retirement","surface","head to head","tournament draw","jannik sinner","alexander zverev"]) assert.ok(all.includes(term),term);
 assert.ok(!all.includes("starting xi"));
});
test("classifies tennis withdrawals and surface reporting separately", () => {
 const categories = classifyEvidenceCategory("Player withdrew with an ankle injury; hard court record and recent form");
 for (const category of ["injury_fitness","withdrawals_retirements","surface_conditions","form_statistics"]) assert.ok(categories.includes(category),category);
});

import { buildResearchModelOptions } from "./fixture-research.mjs";
test("Groq research assessment requests JSON mode and disables tool calls",()=>{
 const options=buildResearchModelOptions("openai/gpt-oss-20b");
 assert.equal(options.model,"openai/gpt-oss-20b");
 assert.deepEqual(options.response_format,{type:"json_object"});
 assert.equal(options.max_tokens,1500);
});

import { buildNewsSearchProviders, buildCuratedSportsFeeds } from "./fixture-research.mjs";
test("uses global English news editions for international fixture coverage",()=>{
 const providers=buildNewsSearchProviders("NK Osijek U19 HNK Rijeka U19 team news");
 assert.equal(providers.length,3);
 assert.match(providers[1].url,/hl=en-GB&gl=GB&ceid=GB:en/);
 assert.match(providers[0].url,/hl=en-US&gl=US&ceid=US:en/);
 assert.match(providers[0].url,/NK%20Osijek%20U19/);
 assert.match(providers[2].url,/format=rss/);
 assert.equal(providers[2].name,"bing_news");
});

import { normalizeResearchConfidence } from "./fixture-research.mjs";
test("normalizes numeric and labelled AI confidence consistently",()=>{
 assert.equal(normalizeResearchConfidence(82),82);
 assert.equal(normalizeResearchConfidence("73"),73);
 assert.equal(normalizeResearchConfidence({overall:"moderate",details:{injury:"low"}}),65);
 assert.equal(normalizeResearchConfidence({overall:"high"}),80);
 assert.equal(normalizeResearchConfidence({overall:"low"}),35);
 assert.equal(normalizeResearchConfidence({}),0);
});
import { buildResearchJsonParameters } from "./fixture-research.mjs";
test("uses the database JSON encoder for research arrays and objects",()=>{
 const db={json:value=>({jsonValue:value})};
 const sources=[{title:"Official team update"}],assessment={confidence:{overall:"moderate"}},coverage={rawSearchResults:3};
 assert.deepEqual(buildResearchJsonParameters(db,sources,assessment,coverage),[
  {jsonValue:sources},{jsonValue:assessment},{jsonValue:coverage}
 ]);
});

test("research AI rejects a Qwen environment override",()=>{
 assert.equal(buildResearchModelOptions("qwen/qwen3.8-27b").model,"openai/gpt-oss-20b");
});

import { buildResearchProviderRequest } from "./fixture-research.mjs";
test("uses Groq GPT-OSS as the primary online research model",()=>{
 const request=buildResearchProviderRequest("groq","test-groq-key","test prompt");
 assert.equal(request.url,"https://api.groq.com/openai/v1/chat/completions");
 assert.equal(request.body.model,"openai/gpt-oss-20b");
 assert.equal(request.body.response_format.type,"json_object");
});
test("uses OpenRouter GPT-4o-mini only as online fallback",()=>{
 const request=buildResearchProviderRequest("openrouter","test-openrouter-key","test prompt");
 assert.equal(request.url,"https://openrouter.ai/api/v1/chat/completions");
 assert.equal(request.body.model,"openai/gpt-4o-mini");
 assert.equal(request.body.response_format.type,"json_object");
});
test("refuses unsupported or local AI providers",()=>{
 assert.throws(()=>buildResearchProviderRequest("qwen","test-key","prompt"),/Unsupported online AI provider/);
 assert.throws(()=>buildResearchProviderRequest("local","test-key","prompt"),/Unsupported online AI provider/);
});

test("basketball research covers player availability, roster, fatigue and team statistics",()=>{
 const queries=buildFixtureQueries({sport:"basketball",home:"Boston Celtics",away:"Los Angeles Lakers",competition:"NBA"},new Date("2026-11-06T10:00:00Z"));
 const all=queries.join(" ").toLowerCase();
 assert.equal(queries.length,14);
 for(const term of ["injury report","questionable","probable","minutes restriction","starting five","back to back","fatigue","offensive rating","defensive rating","head to head","inactive list"])assert.ok(all.includes(term),term);
 assert.ok(!all.includes("starting xi"));
});
test("basketball news categories distinguish availability, rest and team metrics",()=>{
 const categories=classifyEvidenceCategory("Player questionable with an ankle injury, minutes restriction after a back-to-back; team offensive rating and defensive rating updated");
 for(const category of ["injury_fitness","player_availability","rest_fatigue","team_statistics"])assert.ok(categories.includes(category),category);
});

test("matches international club-name variants without accepting unrelated fixtures",()=>{
 const fixture={home:"Vipers SC",away:"KCCA FC"};
 assert.equal(isFixtureRelevantResult({title:"Vipers team news ahead of Kampala derby"},fixture),true);
 assert.equal(isFixtureRelevantResult({title:"KCCA injury update"},fixture),true);
 assert.equal(isFixtureRelevantResult({title:"Express FC vs URA preview"},fixture),false);
});
test("matches abbreviated clubs with a distinctive one-word name",()=>{
 assert.equal(isFixtureRelevantResult({title:"JS Skikda team news ahead of kickoff"}, {home:"JS Skikda",away:"NRB Teleghma"}),true);
 assert.equal(isFixtureRelevantResult({title:"NRB Teleghma injury update"}, {home:"JS Skikda",away:"NRB Teleghma"}),true);
 assert.equal(isFixtureRelevantResult({title:"KCCA confirms squad update"}, {home:"Vipers SC",away:"KCCA FC"}),true);
 assert.equal(isFixtureRelevantResult({title:"Skikda unrelated weather report"}, {home:"JS Skikda",away:"NRB Teleghma"}),true);
 assert.equal(isFixtureRelevantResult({title:"Skikdaway derby preview"}, {home:"JS Skikda",away:"NRB Teleghma"}),false);
});
test("participant coverage requires both teams to be evidenced independently",()=>{
 const fixture={home:"Al-Kholood",away:"Al-Khaleej"};
 assert.deepEqual(hasParticipantCoverage({title:"Al Kholood squad update",excerpt:"Team news ahead of kickoff"},fixture),{home:true,away:false});
 assert.deepEqual(hasParticipantCoverage({title:"Al-Khaleej vs Al-Kholood preview"},fixture),{home:true,away:true});
});

test("adds curated independent publisher feeds for football, tennis and basketball",()=>{
 const football=buildCuratedSportsFeeds("football");
 const tennis=buildCuratedSportsFeeds("tennis");
 const basketball=buildCuratedSportsFeeds("basketball");
 assert.ok(football.some(feed=>feed.name==="bbc_football"));
 assert.ok(football.some(feed=>feed.name==="sky_football"));
 assert.ok(football.some(feed=>feed.name==="athletic_football"));
 assert.ok(tennis.some(feed=>feed.name==="sky_tennis"));
 assert.ok(basketball.some(feed=>feed.name==="cbs_nba"));
 assert.ok(basketball.some(feed=>feed.name==="athletic_nba"));
 for(const feed of [...football,...tennis,...basketball])assert.match(feed.url,/^https:\/\//);
});

test("parses Atom sports feed entries and href links",()=>{
 const xml='<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Team A injury update</title><link rel="alternate" href="https://sports.example/news/team-a"/><updated>2026-11-06T10:00:00Z</updated><summary>Team A confirms a player is unavailable before the match.</summary></entry></feed>';
 const entries=parseRss(xml);
 assert.equal(entries.length,1);
 assert.equal(entries[0].title,"Team A injury update");
 assert.equal(entries[0].url,"https://sports.example/news/team-a");
 assert.equal(entries[0].publishedAt,"2026-11-06T10:00:00.000Z");
 assert.match(entries[0].description,/player is unavailable/);
});
