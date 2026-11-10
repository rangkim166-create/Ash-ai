import test from "node:test";
import assert from "node:assert/strict";
import {buildFixtureQueries,classifyEvidenceCategory,buildRuleBasedAssessment,buildCuratedSportsFeeds,collectNewsProviderFailures,collectResearchProviderFailures} from "./fixture-research.mjs";
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


test("matches international clubs when headlines omit one generic name token",()=>{
 const fixture={home:"Al-Kholood",away:"Hapoel Bnei Musmus"};
 assert.equal(isFixtureRelevantResult({title:"Kholood confirm squad update"},fixture),true);
 assert.equal(isFixtureRelevantResult({title:"Bnei Musmus injury update"},fixture),true);
 assert.equal(isFixtureRelevantResult({title:"Hapoel training news"},fixture),false);
 assert.equal(isFixtureRelevantResult({title:"Bnei unrelated derby"},fixture),false);
});
test("near-match participant coverage still requires distinct whole-word evidence",()=>{
 const fixture={home:"Hapoel Bnei Musmus",away:"Al-Khaleej"};
 assert.deepEqual(hasParticipantCoverage({title:"Bnei Musmus squad update",excerpt:"Fitness update"},fixture),{home:true,away:false});
 assert.deepEqual(hasParticipantCoverage({title:"Al-Khaleej vs Hapoel Bnei Musmus preview"},fixture),{home:true,away:true});
});


test("recognizes exact three-letter initials used by publishers for clubs",()=>{
 assert.equal(isFixtureRelevantResult({title:"PSG injury update ahead of European match"}, {home:"Paris Saint-Germain",away:"Chelsea"}),true);
 assert.equal(isFixtureRelevantResult({title:"PSG injury update"}, {home:"Paris Saint-Germain",away:"Chelsea"}),true);
 assert.equal(isFixtureRelevantResult({title:"PSG are not the subject of this article"}, {home:"Paris Saint-Germain",away:"Chelsea"}),true);
 assert.equal(isFixtureRelevantResult({title:"PSGx unrelated report"}, {home:"Paris Saint-Germain",away:"Chelsea"}),false);
});


test("retains failed Google and Bing providers when another news feed succeeds",()=>{
 const diagnostics=[
  {provider:"google_news_us",status:200,parsedItems:4},
  {provider:"google_news_uk",error:"HTTP 503"},
  {provider:"bing_news",error:"HTTP 429"}
 ];
 assert.deepEqual(collectNewsProviderFailures(diagnostics),[
  {provider:"google_news_uk",error:"HTTP 503"},
  {provider:"bing_news",error:"HTTP 429"}
 ]);
});


test("exposes structured search and curated feed failures in research coverage",()=>{
 const failures=collectResearchProviderFailures([
  {provider:"google_news_uk",error:"HTTP 503"},
  {provider:"bing_news",error:"HTTP 429"}
 ],["bbc_football: HTTP 503","sky_football: no parseable RSS entries"]);
 assert.deepEqual(failures,[
  {provider:"google_news_uk",error:"HTTP 503"},
  {provider:"bing_news",error:"HTTP 429"},
  {provider:"bbc_football",error:"HTTP 503"},
  {provider:"sky_football",error:"no parseable RSS entries"}
 ]);
});

import { buildFixtureFallbackQueries } from "./fixture-research.mjs";
test("builds compact participant-first fallback searches for every real sport",()=>{
 const football=buildFixtureFallbackQueries({sport:"football",home:"Vipers SC",away:"KCCA FC",competition:"Uganda Premier League"});
 const tennis=buildFixtureFallbackQueries({sport:"tennis",home:"Jannik Sinner",away:"Alexander Zverev",competition:"ATP Finals"});
 const basketball=buildFixtureFallbackQueries({sport:"basketball",home:"Boston Celtics",away:"Los Angeles Lakers",competition:"NBA"});
 assert.equal(football.length,3);
 assert.ok(football[0].includes('"Vipers SC"')&&football[0].includes('"KCCA FC"'));
 assert.ok(football[1].includes("injury availability"));
 assert.ok(tennis.every(query=>query.includes("tennis")));
 assert.ok(tennis.some(query=>query.includes("withdrawal retirement")));
 assert.ok(basketball.every(query=>query.includes("basketball")));
 assert.ok(basketball.some(query=>query.includes("injury report")));
});

test("builds a transparent football evidence assessment without an AI provider",()=>{
 const fixture={sport:"football",home:"Arsenal",away:"Chelsea"};
 const pages=[
  {title:"Arsenal injury update",domain:"bbc.com",sourceTier:"established_media",publishedAt:"2026-11-10T10:00:00Z",contentLevel:"full_article",categories:["injury_fitness"],excerpt:"Arsenal report an injury concern before the match."},
  {title:"Chelsea confirmed lineup news",domain:"premierleague.com",sourceTier:"official_league_or_federation",publishedAt:"2026-11-10T11:00:00Z",contentLevel:"full_article",categories:["lineups","official_update"],excerpt:"Chelsea squad and lineup update ahead of Arsenal match."}
 ];
 const assessment=buildRuleBasedAssessment(fixture,pages);
 assert.equal(assessment.method,"deterministic_evidence_rules");
 assert.equal(assessment.confidenceType,"evidence_coverage_score_not_win_probability");
 assert.equal(assessment.confidence,70);
 assert.equal(assessment.injuryUpdates.length,1);
 assert.equal(assessment.lineupUpdates.length,1);
 assert.equal(assessment.evidenceCoverage.home,true);
 assert.equal(assessment.evidenceCoverage.away,true);
 assert.match(assessment.note,/not a probability of winning/);
});
test("tennis evidence rules require fitness or withdrawal plus form context",()=>{
 const assessment=buildRuleBasedAssessment({sport:"tennis",home:"Player One",away:"Player Two"},[
  {title:"Player One fitness update",domain:"atptour.com",sourceTier:"official_league_or_federation",contentLevel:"full_article",categories:["injury_fitness"],excerpt:"Player One passed a fitness test."},
  {title:"Player Two recent form",domain:"bbc.com",sourceTier:"established_media",contentLevel:"full_article",categories:["form_statistics"],excerpt:"Player Two has strong recent form."}
 ]);
 assert.equal(assessment.evidenceCoverage.sportRequirementsMet,true);
 assert.equal(assessment.surfaceAndCourtContext.length,0);
 assert.equal(assessment.formAndStatistics.length,1);
});
test("basketball evidence assessment reports missing categories instead of inventing them",()=>{
 const assessment=buildRuleBasedAssessment({sport:"basketball",home:"Boston Celtics",away:"LA Lakers"},[
  {title:"Boston Celtics injury report",domain:"nba.com",sourceTier:"official_league_or_federation",contentLevel:"full_article",categories:["injury_fitness"],excerpt:"Boston Celtics list one player as questionable."}
 ]);
 assert.equal(assessment.evidenceCoverage.sportRequirementsMet,false);
 assert.ok(assessment.unknowns.some(item=>item.includes("sport-specific evidence")));
 assert.equal(assessment.lineupUpdates.length,0);
});
