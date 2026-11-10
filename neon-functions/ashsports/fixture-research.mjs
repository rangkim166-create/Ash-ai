import { buildScoutResearchQueries } from "./scout-signals.mjs";
const timeout=(ms)=>AbortSignal.timeout(ms);

const OFFICIAL_SPORTS_DOMAINS = new Set(["fifa.com","uefa.com","the-afc.com","cafonline.com","premierleague.com","laliga.com","bundesliga.com","legaseriea.it","ligue1.com","nba.com","euroleaguebasketball.net","fiba.basketball","atptour.com","wtatennis.com"]);
const MAJOR_MEDIA_DOMAINS = new Set(["bbc.com","bbc.co.uk","reuters.com","apnews.com","theguardian.com","espn.com","espn.co.uk","skysports.com","theathletic.com","goal.com","cbssports.com","sports.yahoo.com","marca.com","as.com","lequipe.fr","kicker.de"]);
function publisherTier(domain){const host=String(domain||"").toLowerCase().replace(/^www\./,"");const matches=set=>[...set].some(root=>host===root||host.endsWith("."+root));if(matches(OFFICIAL_SPORTS_DOMAINS))return "official_league_or_federation";if(matches(MAJOR_MEDIA_DOMAINS))return "established_media";return "other_public_publisher";}
export function classifyEvidenceCategory(text){
 const s=String(text||"").toLowerCase(),out=[];
 if(/injur|injured|fitness|doubtful|ruled out|medical update|hamstring|ankle|knee|concussion/.test(s))out.push("injury_fitness");
 if(/questionable|probable|available|unavailable|minutes restriction|game.?time decision|player status|inactive list/.test(s))out.push("player_availability");
 if(/back.?to.?back|rest day|rested|workload|minutes limit|travel schedule|fatigue/.test(s))out.push("rest_fatigue");
 if(/pace|offensive rating|defensive rating|rebounds|assists|turnovers|shooting percentage|team statistics|team stats/.test(s))out.push("team_statistics");
 if(/starting lineup|starting five|starting five|roster update|active roster|rotation update|confirmed starters/.test(s))out.push("roster_lineups");
 if(/withdraw|withdrew|withdrawal|retired|retirement|walkover|pulled out|medical timeout/.test(s))out.push("withdrawals_retirements");
 if(/line.?up|starting xi|starting eleven|team sheet|confirmed xi|predicted xi|probable lineup|formation/.test(s))out.push("lineups");
 if(/suspend|suspension|red card ban|yellow card ban|disciplinary|banned/.test(s))out.push("suspensions");
 if(/press conference|manager said|coach said|head coach|training|squad announcement|pre.?match interview/.test(s))out.push("manager_training");
 if(/weather|rain|wind|temperature|forecast|pitch condition/.test(s))out.push("weather_venue");
 if(/surface|hard court|clay court|grass court|indoor court/.test(s))out.push("surface_conditions");
 if(/preview|prediction|odds|tipster|expert pick|match analysis/.test(s))out.push("preview_analysis");
 if(/form|head.?to.?head|last five|recent results|statistics|stats|win.?loss|record/.test(s))out.push("form_statistics");
 if(/official statement|club statement|league statement|federation|tournament statement/.test(s))out.push("official_update");
 return out.length?out:["general_news"];
}

export function buildFixtureQueries(fixture,now=new Date()){
 const h=String(fixture.home||"").trim(),a=String(fixture.away||"").trim(),c=String(fixture.competition||"").trim();
 const sport=String(fixture.sport||"football").toLowerCase();
 const recent=new Date(now.getTime()-2*86400000).toISOString().slice(0,10);
 const week=new Date(now.getTime()-7*86400000).toISOString().slice(0,10);
 const pair=h+" "+a,league=c?c:"";
 if(sport==="basketball")return [
  pair+" "+league+" basketball game preview team statistics pace offensive rating defensive rating recent form after:"+week,
  h+" basketball injury report player availability questionable probable ruled out minutes restriction after:"+recent,
  a+" basketball injury report player availability questionable probable ruled out minutes restriction after:"+recent,
  h+" NBA latest roster update active roster rotation starters player status after:"+recent,
  a+" NBA latest roster update active roster rotation starters player status after:"+recent,
  pair+" basketball confirmed starting lineup starting five player availability after:"+recent,
  pair+" basketball back to back schedule rest days travel fatigue workload after:"+week,
  h+" basketball last five games team statistics offensive rating defensive rating pace after:"+week,
  a+" basketball last five games team statistics offensive rating defensive rating pace after:"+week,
  pair+" basketball head to head recent results rebounds assists turnovers shooting statistics after:"+week,
  pair+" basketball coach press conference rotation minutes restriction injury update after:"+week,
  pair+" basketball official team injury report game status update after:"+recent,
  pair+" basketball late scratch inactive list game time decision latest news after:"+recent,
  pair+" basketball matchday news preview statistics availability update after:"+recent
 ].map(x=>x.replace(/\s+/g," ").trim());
 if(sport==="tennis")return [
  pair+" "+league+" tennis match preview analysis form head to head after:"+week,
  h+" tennis latest news injury fitness withdrawal retirement medical update after:"+recent,
  a+" tennis latest news injury fitness withdrawal retirement medical update after:"+recent,
  h+" tennis injury fitness withdrawal retirement medical update after:"+recent,
  a+" tennis injury fitness withdrawal retirement medical update after:"+recent,
  h+" latest tennis results surface record recent form after:"+week,
  a+" latest tennis results surface record recent form after:"+week,
  pair+" tennis head to head previous meetings match statistics after:"+week,
  pair+" tournament draw schedule official match update after:"+week,
  h+" tennis player profile official tournament news after:"+week,
  a+" tennis player profile official tournament news after:"+week,
  pair+" tennis hard court clay grass indoor surface performance after:"+week,
  pair+" tennis retirement withdrawal walkover latest news after:"+recent,
  pair+" tennis breaking news tournament update after:"+recent
 ].map(x=>x.replace(/\s+/g," ").trim());
 return [
  pair+" "+league+" match preview analysis expert prediction after:"+week,
  h+" "+league+" latest team news injury fitness doubtful ruled out after:"+recent,
  a+" "+league+" latest team news injury fitness doubtful ruled out after:"+recent,
  h+" latest team news injury fitness doubtful ruled out after:"+recent,
  a+" latest team news injury fitness doubtful ruled out after:"+recent,
  h+" injury medical fitness availability update after:"+week,
  a+" injury medical fitness availability update after:"+week,
  pair+" confirmed lineup predicted lineup starting XI team sheet formation after:"+week,
  pair+" suspensions bans manager coach press conference training squad update after:"+week,
  pair+" stadium weather forecast rain wind pitch conditions matchday after:"+week,
  pair+" recent form results head to head statistics last five after:"+week,
  pair+" official club league federation statement squad announcement after:"+week,
  pair+" breaking news latest updates matchday team news after:"+recent,
  pair+" Africa African football regional sports news updates after:"+week
 ].map(x=>x.replace(/\s+/g," ").trim());
}

export function buildFixtureFallbackQueries(fixture){
 const home=String(fixture?.home||"").trim(),away=String(fixture?.away||"").trim();
 const competition=String(fixture?.competition||"").trim(),sport=String(fixture?.sport||"football").toLowerCase();
 if(sport==="tennis")return [
  '"'+home+'" tennis injury fitness withdrawal retirement latest',
  '"'+away+'" tennis injury fitness withdrawal retirement latest',
  '"'+home+'" "'+away+'" '+competition+' tennis match news form surface'
 ].map(value=>value.replace(/\s+/g," ").trim());
 if(sport==="basketball")return [
  '"'+home+'" basketball injury report player availability latest',
  '"'+away+'" basketball injury report player availability latest',
  '"'+home+'" "'+away+'" '+competition+' basketball match news roster form'
 ].map(value=>value.replace(/\s+/g," ").trim());
 return [
  '"'+home+'" "'+away+'" '+competition+' football match news latest',
  '"'+home+'" football team news injury availability latest',
  '"'+away+'" football team news injury availability latest'
 ].map(value=>value.replace(/\s+/g," ").trim());
}

const decodeEntities = value => String(value || "")
 .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
 .replace(/&nbsp;|&#160;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;|&#34;/gi, '"')
 .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
 .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
 .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
const strip=(s,n=1600)=>decodeEntities(s).replace(/<(script|style|noscript|svg|iframe|nav|footer|header)\b[^>]*>[\s\S]*?<\/\1>/gi," ").replace(/<[^>]*>/g," ").replace(/\s+/g," ").trim().slice(0,n);
export function parseRss(xml){
 const source=String(xml||""),out=[];
 const decode=value=>decodeEntities(String(value||"").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,"$1"));
 const blocks=[...source.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
 for(const match of blocks){
  const block=match[2],atom=match[1].toLowerCase()==="entry";
  const value=tag=>{const m=block.match(new RegExp(String.raw`<${tag}(?:\s[^>]*)?>([\s\S]*?)</${tag}>`,"i"));return m?decode(m[1]).trim():"";};
  const title=strip(value("title"),240);
  const linkTag=block.match(/<link\b([^>]*)\/?\s*>/i);
  const href=linkTag?.[1]?.match(/href=["']([^"']+)["']/i)?.[1];
  const url=decodeEntities(href||value("link")).trim();
  const raw=value("pubDate")||value("published")||value("updated")||value("dc:date");
  const ts=raw?Date.parse(raw):NaN;
  const description=strip(value("description")||value("summary")||value("content:encoded")||value("content"),1200);
  if(!title||!(url.startsWith("https://")||url.startsWith("http://")))continue;
  let domain="unknown",sourceName="";
  try{
   const sourceTag=block.match(/<source\b[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);
   domain=new URL(decodeEntities(sourceTag?.[1]||url)).hostname.replace(/^www[.]/,"");
   sourceName=strip(sourceTag?.[2]||"",120);
  }catch{}
  out.push({title,url,description,date:raw||null,publishedAt:Number.isFinite(ts)?new Date(ts).toISOString():null,ageHours:Number.isFinite(ts)?Math.max(0,Math.round((Date.now()-ts)/3600000)):null,domain,sourceName,sourceTier:publisherTier(domain),categories:classifyEvidenceCategory(title+" "+description)});
  if(out.length>=20)break;
 }
 return out;
}
function normalizeTeamText(value){
 return String(value||"").toLowerCase()
  .normalize("NFKD").replace(/[\u0300-\u036f]/g,"")
  .replace(/&/g," and ").replace(/\b(fc|cf|sc|afc|cfc|united|city|club|basketball|bc)\b/g," ")
  .replace(/[^a-z0-9]+/g," ").replace(/\s+/g," ").trim();
}
function mentionsParticipant(text,participant){
 const raw=String(participant||"").trim();
 const target=normalizeTeamText(raw);
 if(target.length<3)return false;
 const haystack=normalizeTeamText(text);
 const words=new Set(haystack.split(" ").filter(Boolean));
 if(words.has(target))return true;
 const tokens=target.split(" ").filter(token=>token.length>=3);
 // Some publishers use standard initials (e.g. PSG) instead of the full
 // three-word club name. Only infer an acronym from three or more distinctive
 // words and require an exact whole-word match to avoid loose substring hits.
 if(tokens.length>=3){
  const initials=tokens.map(token=>token[0]).join("");
  if(initials.length>=3&&initials.length<=5&&words.has(initials))return true;
 }
 // Many international clubs are stored as an acronym plus one distinctive
 // place/name (e.g. "JS Skikda", "KCCA FC", "Vipers SC"). Accept one
 // distinctive long token, or a short acronym explicitly present in the source.
 if(tokens.length===1){
  if(tokens[0].length>=5&&words.has(tokens[0]))return true;
  const acronyms=raw.split(/[^A-Za-z0-9]+/).filter(token=>/^[A-Z0-9]{3,5}$/.test(token));
  return acronyms.some(token=>words.has(token.toLowerCase()));
 }
 if(tokens.length>=2){
  const matched=tokens.filter(token=>words.has(token));
  if(matched.length===tokens.length)return true;
  // Headlines often omit generic prefixes such as "Al" or "Hapoel".
  // Accept one missing token only when at least two whole-word tokens match.
  return matched.length>=2&&matched.length>=tokens.length-1;
 }
}
export function isFixtureRelevantResult(item,fixture){
 const text=String(item?.title||"")+" "+String(item?.description||"");
 return mentionsParticipant(text,fixture?.home)||mentionsParticipant(text,fixture?.away);
}
export function hasParticipantCoverage(item,fixture){
 const text=String(item?.title||"")+" "+String(item?.excerpt||item?.description||"");
 return {home:mentionsParticipant(text,fixture?.home),away:mentionsParticipant(text,fixture?.away)};
}

export function buildNewsSearchProviders(query){
 // Let the downstream freshness filter enforce the seven-day window. Search
 // engines frequently return empty feeds for long queries containing multiple
 // after: operators, even when matching reporting exists.
 const normalized=String(query||"").replace(/\bafter:\d{4}-\d{2}-\d{2}\b/gi,"").replace(/\s+/g," ").trim();
 const words=normalized.split(" ").filter(Boolean);
 const compact=words.length>9?words.slice(0,9).join(" "):normalized;
 const encoded=encodeURIComponent(compact);
 return [
  {name:"google_news_us",url:"https://news.google.com/rss/search?q="+encoded+"&hl=en-US&gl=US&ceid=US:en"},
  {name:"google_news_uk",url:"https://news.google.com/rss/search?q="+encoded+"&hl=en-GB&gl=GB&ceid=GB:en"},
  {name:"bing_news",url:"https://www.bing.com/news/search?q="+encoded+"&format=rss"}
 ];
}
export function buildCuratedSportsFeeds(sport="football"){
 const common=[{name:"bbc_sport",url:"https://feeds.bbci.co.uk/sport/rss.xml"}];
 const normalized=String(sport||"football").toLowerCase();
 if(normalized==="basketball")return [...common,
  {name:"athletic_nba",url:"https://www.nytimes.com/athletic/rss/nba/"},
  {name:"cbs_nba",url:"https://www.cbssports.com/rss/headlines/nba/"}
 ];
 if(normalized==="tennis")return [...common,
  {name:"sky_tennis",url:"https://www.skysports.com/rss/12110"}
 ];
 return [...common,
  {name:"bbc_football",url:"https://feeds.bbci.co.uk/sport/football/rss.xml"},
  {name:"sky_football",url:"https://www.skysports.com/rss/11095"},
  {name:"athletic_football",url:"https://www.nytimes.com/athletic/rss/football/"}
 ];
}
async function fetchFeed(feed){
 let lastError=null;
 for(let attempt=0;attempt<2;attempt++){
  try{
   const response=await fetch(feed.url,{signal:timeout(12000),headers:{"user-agent":"Mozilla/5.0 (compatible; AshSportsResearch/5.0)","accept":"application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8"}});
   const body=await response.text();
   const items=parseRss(body).map(item=>({...item,searchProvider:feed.name}));
   const contentType=response.headers.get("content-type")||"unknown";
   const diagnostic={provider:feed.name,status:response.status,contentType,bodyBytes:new TextEncoder().encode(body).length,parsedItems:items.length,bodyLooksHtml:/<html[\s>]/i.test(body.slice(0,1000)),attempt:attempt+1};
   if(response.ok&&items.length)return {items,diagnostic};
   lastError=Error(JSON.stringify(diagnostic));
   if(response.status<500&&response.status!==429)break;
  }catch(error){lastError=error;}
  if(attempt===0)await new Promise(resolve=>setTimeout(resolve,350));
 }
 throw lastError||new Error("feed_fetch_failed");
}
async function searchCuratedSportsFeeds(sport){
 const feeds=buildCuratedSportsFeeds(sport);
 const results=await Promise.allSettled(feeds.map(feed=>fetchFeed(feed)));
 const items=[],errors=[],diagnostics=[];
 for(let index=0;index<results.length;index++){
  const result=results[index];
  if(result.status==="fulfilled"){items.push(...result.value.items);diagnostics.push(result.value.diagnostic);}
  else errors.push(feeds[index].name+": "+String(result.reason?.message||result.reason).slice(0,240));
 }
 return {items,errors,diagnostics};
}
export function collectNewsProviderFailures(diagnostics=[]){return (diagnostics||[]).filter(item=>!!item?.error);}
export function collectResearchProviderFailures(searchFailures=[],curatedErrors=[]){
 const failures=collectNewsProviderFailures(searchFailures).map(item=>({
  provider:String(item.provider||"unknown"),
  error:String(item.error||"provider_failed").slice(0,240)
 }));
 for(const item of curatedErrors||[]){
  const value=String(item||"");
  const separator=value.indexOf(":");
  failures.push({
   provider:separator>0?value.slice(0,separator):"curated_feed",
   error:(separator>0?value.slice(separator+1).trim():value).slice(0,240)
  });
 }
 return failures;
}
async function search(query){
 const providers=buildNewsSearchProviders(query);
 const results=await Promise.allSettled(providers.map(provider=>fetchFeed(provider)));
 const items=[],diagnostics=[];
 for(let index=0;index<results.length;index++){
  const result=results[index];
  if(result.status==="fulfilled"){items.push(...result.value.items);diagnostics.push(result.value.diagnostic);}
  else diagnostics.push({provider:providers[index].name,error:String(result.reason?.message||result.reason).slice(0,240)});
 }
 const failures=collectNewsProviderFailures(diagnostics);
 if(!items.length)throw Error("News discovery returned no parseable feed items: "+JSON.stringify(diagnostics).slice(0,900));
 return {items,diagnostics:failures};
}
async function readArticle(item){
 let article=null;
 try{
  const r=await fetch(item.url,{redirect:"follow",headers:{"user-agent":"Mozilla/5.0 (compatible; AshSportsResearch/4.0)"},signal:timeout(10000)});
  if(r.ok){
   const type=r.headers.get("content-type")||"";
   if(type.includes("text/html")||type.includes("text/plain")){
    const raw=await r.text(),excerpt=strip(raw.slice(0,1_500_000),2600);
    const finalHost=new URL(r.url||item.url).hostname.replace(/^www\./,"");
    const publisherHost=String(item.domain||"").replace(/^www\./,"");
    const googleHost=finalHost==="news.google.com"||finalHost.endsWith(".google.com");
    if(excerpt.length>400&&!googleHost&&(publisherHost==="unknown"||finalHost===publisherHost||finalHost.endsWith("."+publisherHost)))article={...item,url:r.url||item.url,domain:finalHost,excerpt:excerpt.slice(0,2200),contentLevel:"full_article",categories:classifyEvidenceCategory(item.title+" "+excerpt),fetchedAt:new Date().toISOString()};
   }
  }
 }catch{}
 if(article)return article;
 const snippet=strip(item.description||"",900);
 const meaningful=snippet.length>=120&&snippet.toLowerCase()!==String(item.title||"").toLowerCase();
 return meaningful?{...item,excerpt:snippet,contentLevel:"rss_snippet",categories:classifyEvidenceCategory(item.title+" "+snippet),fetchedAt:new Date().toISOString()}:null;
}
export function buildResearchJsonParameters(db,sources,assessment,coverage){
 if(typeof db?.json!=="function")throw Error("Database JSON encoder is required for research persistence");
 return [db.json(sources),db.json(assessment||{}),db.json(coverage)];
}
export function normalizeResearchConfidence(value){
 const numeric=v=>typeof v==="number"&&Number.isFinite(v)?Math.max(0,Math.min(100,v)):typeof v==="string"&&v.trim()!==""&&Number.isFinite(Number(v))?Math.max(0,Math.min(100,Number(v))):null;
 const direct=numeric(value);
 if(direct!==null)return direct;
 const label=typeof value==="string"?value:
  value&&typeof value==="object"?(value.overall??value.level??value.rating??value.confidence??value.score):null;
 const number=numeric(label);
 if(number!==null)return number;
 const text=String(label||"").toLowerCase();
 if(text.includes("very high")||text.includes("excellent"))return 90;
 if(text.includes("high"))return 80;
 if(text.includes("moderate")||text.includes("medium"))return 65;
 if(text.includes("low"))return 35;
 return 0;
}
export function buildRuleBasedAssessment(fixture,pages=[]){
 const rows=(Array.isArray(pages)?pages:[]).map(page=>{
  const text=String(page.title||"")+" "+String(page.excerpt||page.description||"");
  return {
   title:String(page.title||"Untitled source"),
   domain:String(page.domain||"unknown"),
   sourceTier:String(page.sourceTier||"other_public_publisher"),
   publishedAt:page.publishedAt||page.date||null,
   contentLevel:page.contentLevel||"unknown",
   categories:Array.isArray(page.categories)?page.categories:classifyEvidenceCategory(text),
   excerpt:String(page.excerpt||page.description||"").slice(0,700),
   text
  };
 });
 const byCategory=(...categories)=>rows.filter(row=>categories.some(category=>row.categories.includes(category)));
 const compact=items=>items.map(({title,domain,sourceTier,publishedAt,excerpt})=>({title,domain,sourceTier,publishedAt,excerpt}));
 const injuries=byCategory("injury_fitness","player_availability");
 const withdrawals=byCategory("withdrawals_retirements");
 const lineups=byCategory("lineups","roster_lineups");
 const suspensions=byCategory("suspensions");
 const management=byCategory("manager_training");
 const weather=byCategory("weather_venue");
 const surface=byCategory("surface_conditions");
 const form=byCategory("form_statistics","preview_analysis","team_statistics");
 const official=rows.filter(row=>row.sourceTier==="official_league_or_federation");
 const rumors=rows.filter(row=>/rumou?r|unconfirmed|speculat|reportedly|could miss|doubtful|may miss|expected to miss/i.test(row.text));
 const contradictionPairs=[];
 for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
  const a=rows[i],b=rows[j];
  const overlap=a.categories.some(category=>b.categories.includes(category));
  const aOut=/ruled out|will miss|unavailable|withdrawn|pulled out|out injured/i.test(a.text);
  const aIn=/available|fit to play|passed fit|ready to play|back in the squad/i.test(a.text);
  const bOut=/ruled out|will miss|unavailable|withdrawn|pulled out|out injured/i.test(b.text);
  const bIn=/available|fit to play|passed fit|ready to play|back in the squad/i.test(b.text);
  if(overlap&&((aOut&&bIn)||(aIn&&bOut)))contradictionPairs.push({topic:"conflicting availability reports",sources:[a.domain,b.domain],titles:[a.title,b.title]});
 }
 const sport=String(fixture?.sport||"football").toLowerCase();
 const required=sport==="tennis"?[injuries.length+withdrawals.length>0,form.length>0]:sport==="basketball"?[injuries.length>0,lineups.length>0,form.length>0]:[injuries.length>0,lineups.length>0];
 const fullArticles=rows.filter(row=>row.contentLevel==="full_article");
 const domains=new Set(fullArticles.map(row=>row.domain).filter(domain=>domain!=="unknown"));
 const coveragePoints=Math.min(15,fullArticles.length*5)+Math.min(15,domains.size*5)+(required.every(Boolean)?15:0);
 const confidence=Math.max(0,Math.min(75,35+coveragePoints));
 const participantText=rows.map(row=>row.text).join(" ");
 const homeMention=mentionsParticipant(participantText,fixture?.home);
 const awayMention=mentionsParticipant(participantText,fixture?.away);
 const contradictions=contradictionPairs;
 const evidenceSummary=[
  fullArticles.length+" full article(s) reviewed",
  domains.size+" independent publisher domain(s)",
  homeMention?"home participant mentioned":"home participant coverage missing",
  awayMention?"away participant mentioned":"away participant coverage missing",
  required.every(Boolean)?"sport-specific evidence categories present":"sport-specific evidence categories incomplete"
 ].join("; ");
 return {
  method:"deterministic_evidence_rules",
  confidence,
  confidenceType:"evidence_coverage_score_not_win_probability",
  summary:"Rule-based evidence review for "+String(fixture?.home||"")+" vs "+String(fixture?.away||"")+". "+evidenceSummary+". This is not an AI-generated prediction.",
  injuryUpdates:compact(injuries),
  withdrawalUpdates:compact(withdrawals),
  lineupUpdates:compact(lineups),
  suspensions:compact(suspensions),
  managerAndTrainingNews:compact(management),
  weatherAndVenue:compact(weather),
  surfaceAndCourtContext:compact(surface),
  formAndStatistics:compact(form),
  confirmedFacts:compact(official.filter(row=>/\b(confirm(?:ed)?|announce(?:d)?|official statement|ruled out|will miss|withdrawn)\b/i.test(row.text))),
  officialSourceReports:compact(official),
  rumours:compact(rumors),
  contradictions,
  unknowns:[
   ...(homeMention?[]:["No reliable participant-specific coverage found for "+String(fixture?.home||"the first participant")]),
   ...(awayMention?[]:["No reliable participant-specific coverage found for "+String(fixture?.away||"the second participant")]),
   ...(!required.every(Boolean)?["Required sport-specific evidence is incomplete"]:[]),
   ...(!fullArticles.length?["No full article text was available"]:[])
  ],
  sourceQuality:{fullArticleCount:fullArticles.length,independentDomains:domains.size,officialSourceCount:official.length},
  evidenceCoverage:{home:homeMention,away:awayMention,sportRequirementsMet:required.every(Boolean)},
  note:"Evidence coverage score is not a probability of winning. Headlines and snippets are leads, not confirmation. No selection should be made from this assessment alone."
 };
}
export async function ensureFixtureResearchTables(db){
 await db.query(`CREATE TABLE IF NOT EXISTS ash_fixture_research_queue(
  match_id text PRIMARY KEY REFERENCES sports_matches(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',attempts integer NOT NULL DEFAULT 0,
  due_at timestamptz NOT NULL DEFAULT now(),last_error text,created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),completed_at timestamptz
 )`);
 await db.query("CREATE INDEX IF NOT EXISTS ash_fixture_research_due_idx ON ash_fixture_research_queue(status,due_at)");
 await db.query(`CREATE TABLE IF NOT EXISTS ash_fixture_research(
  match_id text PRIMARY KEY REFERENCES sports_matches(id) ON DELETE CASCADE,
  researched_at timestamptz NOT NULL,source_count integer NOT NULL DEFAULT 0,
  independent_domains integer NOT NULL DEFAULT 0,sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  assessment jsonb NOT NULL DEFAULT '{}'::jsonb,coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  freshness_hours integer NOT NULL DEFAULT 168,updated_at timestamptz NOT NULL DEFAULT now()
 )`);
 // Older writes encoded JSON text as JSONB string scalars; unwrap them for JSON operators.
 await db.query("UPDATE ash_fixture_research SET sources=(sources #>> '{}')::jsonb WHERE jsonb_typeof(sources)='string'");
 await db.query("UPDATE ash_fixture_research SET assessment=(assessment #>> '{}')::jsonb WHERE jsonb_typeof(assessment)='string'");
 await db.query("UPDATE ash_fixture_research SET coverage=(coverage #>> '{}')::jsonb WHERE jsonb_typeof(coverage)='string'");
}
export async function enqueueFixtureResearch(db){
 await ensureFixtureResearchTables(db);
 const r=await db.query(`INSERT INTO ash_fixture_research_queue(match_id,status,due_at)
  SELECT m.id,'pending',now() FROM sports_matches m
  WHERE m.starts_at>now()-interval '12 hours' AND m.starts_at<now()+interval '14 days' AND m.status NOT IN ('completed','cancelled','postponed')
  ON CONFLICT(match_id) DO UPDATE SET status='pending',due_at=now(),updated_at=now(),last_error=NULL
  WHERE (ash_fixture_research_queue.status='failed' AND ash_fixture_research_queue.due_at<=now())
    OR (ash_fixture_research_queue.status='completed' AND NOT EXISTS(
      SELECT 1 FROM ash_fixture_research x WHERE x.match_id=EXCLUDED.match_id AND x.researched_at>now()-CASE WHEN (SELECT starts_at FROM sports_matches WHERE id=EXCLUDED.match_id)<=now()+interval '3 hours' THEN interval '20 minutes' ELSE interval '6 hours' END))
  RETURNING match_id`);
 return {queued:r.rowCount};
}
export async function processFixtureResearch(db,{limit=5,groqKey=null,openrouterKey=null}={}){
 await ensureFixtureResearchTables(db);
 const claimed=await db.query(`WITH due AS(
  SELECT q.match_id FROM ash_fixture_research_queue q JOIN sports_matches m ON m.id=q.match_id
  WHERE q.due_at<=now() AND m.starts_at>now()-interval '12 hours' AND m.starts_at<now()+interval '14 days' AND m.status NOT IN ('completed','cancelled','postponed') AND (q.status='pending' OR (q.status='researching' AND q.updated_at<now()-interval '15 minutes'))
  ORDER BY CASE WHEN m.starts_at<=now()+interval '3 hours' THEN 0 ELSE 1 END,q.due_at ASC LIMIT $1 FOR UPDATE OF q SKIP LOCKED
 ) UPDATE ash_fixture_research_queue q SET status='researching',attempts=q.attempts+1,updated_at=now()
 FROM due WHERE q.match_id=due.match_id RETURNING q.match_id`,[Math.max(1,Math.min(20,limit))]);
 const reports=[];
 for(const row of claimed.rows){
  const fixtureResult=await db.query("SELECT id,sport,competition,home_or_player_one AS home,away_or_player_two AS away,starts_at,status FROM sports_matches WHERE id=$1",[row.match_id]);
  if(!fixtureResult.rowCount){await db.query("DELETE FROM ash_fixture_research_queue WHERE match_id=$1",[row.match_id]);continue;}
  const f=fixtureResult.rows[0],home=f.home,away=f.away,competition=f.competition;
  // Attach team-only scouting notes once a fixture feed later discovers the matching event.
  await db.query("UPDATE ash_user_scout_signals SET match_id=$1,updated_at=now() WHERE match_id IS NULL AND sport=$2 AND (LOWER(team)=LOWER($3) OR LOWER(team)=LOWER($4))",[f.id,f.sport,home,away]).catch(()=>{});
  const queries=buildFixtureQueries(f);
  // User scouting opinions are stored as first-class research signals. They add targeted searches;
  // they never force a selection or override the evidence/market checks.
  const scoutSignals=await db.query("SELECT team,opinion,reason,sport FROM ash_user_scout_signals WHERE match_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 8",[f.id]).catch(()=>({rows:[]}));
  for(const signal of scoutSignals.rows){
   const opponent=String(signal.team||"").toLowerCase()===String(f.home||"").toLowerCase()?f.away:f.home;
   queries.push(...buildScoutResearchQueries(signal,opponent,f.competition));
  }
  const uniqueQueries=[...new Set(queries)].slice(0,22);
  const found=[],errors=[],searchProviderFailures=[],curatedFeedFailures=[];
  const curatedPromise=searchCuratedSportsFeeds(f.sport).catch(error=>({items:[],errors:[String(error?.message||error).slice(0,120)]}));
  // Keep outbound traffic bounded: 14 queries × 3 providers at once was
  // causing transient fetch failures and starving fixture-specific discovery.
  const searchResults=[];
  for(let offset=0;offset<uniqueQueries.length;offset+=3){
   const batch=await Promise.allSettled(uniqueQueries.slice(offset,offset+3).map(q=>search(q)));
   searchResults.push(...batch);
  }
  const curatedResults=await curatedPromise;
  found.push(...(curatedResults.items||curatedResults));
  for(const error of curatedResults.errors||[]){curatedFeedFailures.push(error);errors.push("curated_feed: "+error);}
  if(curatedResults.diagnostics?.length)errors.push("curated_feed_diagnostics: "+JSON.stringify(curatedResults.diagnostics).slice(0,900));
  for(const result of searchResults){
    if(result.status==='fulfilled'){
     found.push(...result.value.items);
     if(result.value.diagnostics?.length){searchProviderFailures.push(...result.value.diagnostics);errors.push("news_provider_failures: "+JSON.stringify(result.value.diagnostics.slice(0,6)).slice(0,700));}
    }else errors.push(String(result.reason?.message||result.reason).slice(0,240));
   }
  // Retry with short participant-first searches when the main query set finds too little match-specific reporting.
  const preliminaryRelevant=found.filter(item=>(item.ageHours==null||item.ageHours<=24*7)&&isFixtureRelevantResult(item,f));
  const preliminaryHome=preliminaryRelevant.some(item=>hasParticipantCoverage(item,f).home);
  const preliminaryAway=preliminaryRelevant.some(item=>hasParticipantCoverage(item,f).away);
  if(preliminaryRelevant.length<2||!preliminaryHome||!preliminaryAway){
   const fallbackResults=await Promise.allSettled(buildFixtureFallbackQueries(f).map(query=>search(query)));
   for(const result of fallbackResults){
    if(result.status==="fulfilled"){
     found.push(...result.value.items);
     if(result.value.diagnostics?.length){searchProviderFailures.push(...result.value.diagnostics);errors.push("fallback_news_provider_failures: "+JSON.stringify(result.value.diagnostics.slice(0,6)).slice(0,700));}
    }else errors.push("fallback_search: "+String(result.reason?.message||result.reason).slice(0,240));
   }
  }
  const providerFailures=collectResearchProviderFailures(searchProviderFailures,curatedFeedFailures);
  const rawSearchResultCount=found.length;
  const freshFound=found.filter(x=>x.ageHours==null||x.ageHours<=24*7);
  const relevantFound=freshFound.filter(x=>isFixtureRelevantResult(x,f));
  const unique=[...new Map(relevantFound.map(x=>[x.url,x])).values()]
   .sort((a,b)=>(a.ageHours??999999)-(b.ageHours??999999) || (a.sourceTier==="official_league_or_federation"?-1:0)).slice(0,24);
  const pageResults=await Promise.allSettled(unique.slice(0,12).map(item=>readArticle(item)));
  const pages=pageResults.filter(result=>result.status==='fulfilled'&&result.value).map(result=>result.value);
  const participantCoverage=pages.map(page=>hasParticipantCoverage(page,f));
const homePages=pages.filter((page,index)=>participantCoverage[index].home);
  const awayPages=pages.filter((page,index)=>participantCoverage[index].away);
  const domains=[...new Set(pages.map(p=>p.domain))];
  const fullPages=pages.filter(p=>p.contentLevel!=="rss_snippet");
  const fullArticleCount=fullPages.length;
  const categoryCounts=Object.fromEntries(["injury_fitness","player_availability","rest_fatigue","team_statistics","roster_lineups","withdrawals_retirements","lineups","suspensions","manager_training","weather_venue","surface_conditions","preview_analysis","form_statistics","official_update"].map(c=>[c,fullPages.filter(p=>(p.categories||[]).includes(c)).length]));
  const assessment=buildRuleBasedAssessment(f,pages);
  const coverage={home:homePages.length>0,away:awayPages.length>0,independentDomains:domains.length,matchSources:pages.length,fullArticleCount,rssSnippetCount:pages.length-fullArticleCount,sourceSearchResults:unique.length,rawSearchResults:rawSearchResultCount,freshSearchResults:freshFound.length,relevantSearchResults:relevantFound.length,rawProviderCounts:Object.fromEntries(["google_news_us","google_news_uk","bing_news","bbc_sport","bbc_football","sky_football","sky_tennis","athletic_football","athletic_nba","cbs_nba","unknown"].map(provider=>[provider,found.filter(item=>(item.searchProvider||"unknown")===provider).length])),categoryCounts,officialSources:pages.filter(p=>p.sourceTier==="official_league_or_federation").length,injuryReportingFound:categoryCounts.injury_fitness>0,withdrawalReportingFound:categoryCounts.withdrawals_retirements>0,lineupReportingFound:categoryCounts.lineups>0,surfaceReportingFound:categoryCounts.surface_conditions>0,suspensionReportingFound:categoryCounts.suspensions>0,managerOrTrainingReportingFound:categoryCounts.manager_training>0,weatherReportingFound:categoryCounts.weather_venue>0,assessmentAvailable:!assessment?.error&&!!assessment,assessmentConfidence:normalizeResearchConfidence(assessment?.confidence),providerFailures,failedProviderCount:providerFailures.length,searchProviderCounts:Object.fromEntries(["google_news_us","google_news_uk","bing_news","bbc_sport","bbc_football","sky_football","sky_tennis","athletic_football","athletic_nba","cbs_nba","unknown"].map(provider=>[provider,pages.filter(page=>(page.searchProvider||"unknown")===provider).length])),errors,note:"Coverage means related reporting was found, not that a claim is confirmed."};
  const payload=pages.map(({title,url,date,publishedAt,ageHours,domain,sourceTier,categories,excerpt,searchProvider})=>({title,url,date,publishedAt,ageHours,domain,sourceTier,categories,excerpt,searchProvider:searchProvider||"unknown"}));
  await db.query(`INSERT INTO ash_fixture_research(match_id,researched_at,source_count,independent_domains,sources,assessment,coverage)
   VALUES($1,now(),$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
   ON CONFLICT(match_id) DO UPDATE SET researched_at=now(),source_count=EXCLUDED.source_count,
   independent_domains=EXCLUDED.independent_domains,sources=EXCLUDED.sources,assessment=EXCLUDED.assessment,
   coverage=EXCLUDED.coverage,updated_at=now()`,
   [f.id,payload.length,domains.length,...buildResearchJsonParameters(db,payload,assessment,coverage)]);
  const tennis=f.sport==="tennis";
  const basketball=f.sport==="basketball";
   const sportCoverage=tennis?(categoryCounts.injury_fitness>0||categoryCounts.withdrawals_retirements>0)&&(categoryCounts.form_statistics>0||categoryCounts.preview_analysis>0):basketball?(categoryCounts.injury_fitness>0||categoryCounts.player_availability>0)&&(categoryCounts.lineups>0||categoryCounts.roster_lineups>0)&&(categoryCounts.team_statistics>0||categoryCounts.form_statistics>0):categoryCounts.injury_fitness>0&&categoryCounts.lineups>0;
  const enoughEvidence=fullArticleCount>=2&&domains.length>=2&&homePages.length>0&&awayPages.length>0&&!assessment?.error&&sportCoverage&&normalizeResearchConfidence(assessment?.confidence)>=60&&!(Array.isArray(assessment?.contradictions)&&assessment.contradictions.length>0);
  if(!enoughEvidence){
   const reason="Insufficient verified coverage: require two full article pages, two independent domains, both participants, sport-appropriate availability and form coverage from full articles, and a usable non-conflicting evidence assessment";
   await db.query("UPDATE ash_fixture_research_queue SET status='failed',due_at=now()+interval '6 hours',updated_at=now(),last_error=$2 WHERE match_id=$1",[f.id,reason]);
   reports.push({matchId:f.id,sources:payload.length,domains:domains.length,coverage,status:"insufficient_evidence",assessmentStatus:assessment?.error?"unavailable":"saved"});
   continue;
  }
  await db.query("UPDATE ash_fixture_research_queue SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL WHERE match_id=$1",[f.id]);
  reports.push({matchId:f.id,sources:payload.length,domains:domains.length,coverage,status:"researched",assessmentStatus:assessment?.error?"unavailable":"saved"});
 }
 return {claimed:claimed.rowCount,processed:reports.length,completed:reports.filter(report=>report.status==='researched').length,insufficientEvidence:reports.filter(report=>report.status==='insufficient_evidence').length,reports};
}
