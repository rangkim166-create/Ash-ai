const timeout=(ms)=>AbortSignal.timeout(ms);
const strip=(s,n=1600)=>String(s||"").replace(/<script[\\s\\S]*?<\\/script>/gi," ").replace(/<style[\\s\\S]*?<\\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\\s+/g," ").trim().slice(0,n);
const esc=s=>String(s||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
function parseRss(xml){
 const out=[];
 for(const block of xml.split("<item>").slice(1).map(x=>x.split("</item>")[0])){
  const value=tag=>{const m=block.match(new RegExp("<"+tag+"[^>]*>([\\s\\S]*?)</"+tag+">","i"));return m?m[1].trim():"";};
  const title=strip(value("title"),240),url=value("link"),raw=value("pubDate"),ts=raw?Date.parse(raw):NaN;
  if(!title||!/^https?:\\/\\//.test(url))continue;
  let domain="unknown";
  try{const m=block.match(/<source[^>]*url="([^"]+)"/i);domain=new URL(m?.[1]||url).hostname.replace(/^www\\./,"");}catch{}
  out.push({title,url,date:raw||null,publishedAt:Number.isFinite(ts)?new Date(ts).toISOString():null,ageHours:Number.isFinite(ts)?Math.max(0,Math.round((Date.now()-ts)/3600000)):null,domain});
  if(out.length>=10)break;
 }
 return out;
}
async function search(query){
 const url="https://news.google.com/rss/search?q="+encodeURIComponent(query)+"&hl=en-US&gl=US&ceid=US:en";
 const r=await fetch(url,{signal:timeout(12000),headers:{"user-agent":"AshSportsResearch/4.0"}});
 if(!r.ok)throw Error("News search HTTP "+r.status);
 return parseRss(await r.text());
}
async function readArticle(item){
 try{
  const r=await fetch(item.url,{redirect:"follow",headers:{"user-agent":"Mozilla/5.0 (compatible; AshSportsResearch/4.0)"},signal:timeout(10000)});
  if(!r.ok)return null;
  const type=r.headers.get("content-type")||"";
  if(!/text\\/(html|plain)/i.test(type))return null;
  const excerpt=strip(await r.text(),3500);
  return excerpt.length>180?{...item,excerpt:excerpt.slice(0,1800)}:null;
 }catch{return null;}
}
async function summarizeEvidence(fixture,pages,apiKey){
 if(!apiKey||!pages.length)return null;
 const evidence=pages.map(p=>({title:p.title,domain:p.domain,publishedAt:p.publishedAt,excerpt:p.excerpt.slice(0,650)}));
 const prompt="Analyse this sports fixture using ONLY the evidence. Do not invent facts, injuries, lineups or predictions. Separate verified reporting, opinions, missing information and contradictions. If sources do not establish a fact, say unknown. Return JSON {summary,formSignals,teamNews,expertViews,contradictions,unknowns,confidence} with concise strings and confidence 0-100. Fixture: "+JSON.stringify(fixture)+" Evidence: "+JSON.stringify(evidence).slice(0,10000);
 try{
  const r=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+apiKey},body:JSON.stringify({model:process.env.ASH_GROQ_MODEL||"openai/gpt-oss-120b",messages:[{role:"system",content:"You are Ash, a cautious sports research analyst. Output valid JSON only."},{role:"user",content:prompt}],temperature:0.1,max_tokens:650}),signal:timeout(40000)});
  if(!r.ok)throw Error("Groq HTTP "+r.status);
  const body=await r.json(),text=body.choices?.[0]?.message?.content||"",json=text.slice(text.indexOf("{"),text.lastIndexOf("}")+1);
  return JSON.parse(json);
 }catch(e){return {error:String(e.message||e).slice(0,160),status:"ai_summary_unavailable"};}
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
}
export async function enqueueFixtureResearch(db){
 await ensureFixtureResearchTables(db);
 const r=await db.query(`INSERT INTO ash_fixture_research_queue(match_id,status,due_at)
  SELECT m.id,'pending',now() FROM sports_matches m
  WHERE m.source='the_odds_api' AND m.starts_at>now()-interval '12 hours'
  ON CONFLICT(match_id) DO UPDATE SET status='pending',due_at=now(),updated_at=now(),last_error=NULL
  WHERE ash_fixture_research_queue.status IN ('failed','completed')
    AND (ash_fixture_research_queue.status='failed' OR NOT EXISTS(
      SELECT 1 FROM ash_fixture_research x WHERE x.match_id=EXCLUDED.match_id AND x.researched_at>now()-interval '6 hours'))
  RETURNING match_id`);
 return {queued:r.rowCount};
}
export async function processFixtureResearch(db,{limit=5,groqKey=null}={}){
 await ensureFixtureResearchTables(db);
 const claimed=await db.query(`WITH due AS(
  SELECT q.match_id FROM ash_fixture_research_queue q
  WHERE q.due_at<=now() AND (q.status='pending' OR (q.status='researching' AND q.updated_at<now()-interval '15 minutes'))
  ORDER BY q.due_at ASC LIMIT $1 FOR UPDATE SKIP LOCKED
 ) UPDATE ash_fixture_research_queue q SET status='researching',attempts=q.attempts+1,updated_at=now()
 FROM due WHERE q.match_id=due.match_id RETURNING q.match_id`,[Math.max(1,Math.min(20,limit))]);
 const reports=[];
 for(const row of claimed.rows){
  const fixtureResult=await db.query("SELECT id,sport,competition,home_or_player_one AS home,away_or_player_two AS away,starts_at,status FROM sports_matches WHERE id=$1",[row.match_id]);
  if(!fixtureResult.rowCount){await db.query("DELETE FROM ash_fixture_research_queue WHERE match_id=$1",[row.match_id]);continue;}
  const f=fixtureResult.rows[0],home=f.home,away=f.away,competition=f.competition;
  const date=new Date(Date.now()-7*86400000).toISOString().slice(0,10);
  const queries=[
   '"'+home+'" "'+away+'" "'+competition+'" match preview OR expert prediction OR tipster after:'+date,
   '"'+home+'" '+competition+' team news injuries suspensions manager comments after:'+date,
   '"'+away+'" '+competition+' team news injuries suspensions manager comments after:'+date,
   '"'+home+'" "'+away+'" recent results form head to head statistics'
  ];
  const found=[],errors=[];
  for(const q of queries){try{found.push(...await search(q));}catch(e){errors.push(String(e.message||e).slice(0,120));}}
  const unique=[...new Map(found.filter(x=>x.ageHours==null||x.ageHours<=24*7).map(x=>[x.url,x])).values()]
   .sort((a,b)=>(a.ageHours??999999)-(b.ageHours??999999)).slice(0,12);
  const pages=[];
  for(const item of unique.slice(0,8)){const page=await readArticle(item);if(page)pages.push(page);}
  const homePages=pages.filter(p=>p.title.toLowerCase().includes(home.toLowerCase())||p.excerpt.toLowerCase().includes(home.toLowerCase()));
  const awayPages=pages.filter(p=>p.title.toLowerCase().includes(away.toLowerCase())||p.excerpt.toLowerCase().includes(away.toLowerCase()));
  const domains=[...new Set(pages.map(p=>p.domain))];
  const assessment=await summarizeEvidence(f,pages,groqKey);
  const coverage={home:homePages.length>0,away:awayPages.length>0,independentDomains:domains.length,matchSources:pages.length,sourceSearchResults:unique.length,errors};
  const payload=pages.map(({title,url,date,publishedAt,ageHours,domain,excerpt})=>({title,url,date,publishedAt,ageHours,domain,excerpt}));
  await db.query(`INSERT INTO ash_fixture_research(match_id,researched_at,source_count,independent_domains,sources,assessment,coverage)
   VALUES($1,now(),$2,$3,$4::jsonb,$5::jsonb,$6::jsonb)
   ON CONFLICT(match_id) DO UPDATE SET researched_at=now(),source_count=EXCLUDED.source_count,
   independent_domains=EXCLUDED.independent_domains,sources=EXCLUDED.sources,assessment=EXCLUDED.assessment,
   coverage=EXCLUDED.coverage,updated_at=now()`,
   [f.id,payload.length,domains.length,JSON.stringify(payload),JSON.stringify(assessment||{}),JSON.stringify(coverage)]);
  await db.query("UPDATE ash_fixture_research_queue SET status='completed',completed_at=now(),updated_at=now(),last_error=NULL WHERE match_id=$1",[f.id]);
  reports.push({matchId:f.id,sources:payload.length,domains:domains.length,coverage,assessmentStatus:assessment?.error?"unavailable":"saved"});
 }
 return {claimed:claimed.rowCount,completed:reports.length,reports};
}
