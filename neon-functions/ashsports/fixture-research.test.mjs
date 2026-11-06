import test from "node:test";
import assert from "node:assert/strict";
import {buildFixtureQueries,classifyEvidenceCategory} from "./fixture-research.mjs";
test("searches injury, lineup, suspension, manager, weather and form topics",()=>{const q=buildFixtureQueries({home:"Arsenal",away:"Chelsea",competition:"Premier League"},new Date("2026-11-04T12:00:00Z"));assert.equal(q.length,14);const s=q.join(" ").toLowerCase();for(const x of ["injury","starting xi","suspensions","press conference","weather forecast","head to head","breaking news","african football","official club"])assert.ok(s.includes(x),x);assert.ok(s.includes("after:2026-10-28"));});
test("tags multiple news coverage categories",()=>{const c=classifyEvidenceCategory("Manager press conference: striker injury doubt, probable starting XI and suspension update");for(const x of ["injury_fitness","lineups","suspensions","manager_training"])assert.ok(c.includes(x),x);});
test("generic headlines remain general news",()=>assert.deepEqual(classifyEvidenceCategory("A look ahead to the weekend"),["general_news"]));

test("searches latest updates on a short freshness window as well as weekly context",()=>{const q=buildFixtureQueries({home:"Vipers SC",away:"KCCA",competition:"Uganda Premier League"},new Date("2026-11-04T12:00:00Z"));const s=q.join(" ");assert.ok(s.includes("after:2026-11-02"));assert.ok(s.includes("after:2026-10-28"));assert.ok(s.includes('Vipers SC'));assert.ok(s.includes('KCCA'));});

import { parseRss, isFixtureRelevantResult } from "./fixture-research.mjs";

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

import { buildNewsSearchProviders } from "./fixture-research.mjs";
test("uses global English news editions for international fixture coverage",()=>{
 const providers=buildNewsSearchProviders("NK Osijek U19 HNK Rijeka U19 team news");
 assert.equal(providers.length,2);
 assert.match(providers[0].url,/hl=en-US&gl=US&ceid=US:en/);
 assert.match(providers[0].url,/NK%20Osijek%20U19/);
 assert.match(providers[1].url,/format=rss/);
});
