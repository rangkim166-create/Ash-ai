import { discoverPublicFixtures } from "./public-fixture-discovery.mjs";
import { validateScoutSignal } from "./scout-signals.mjs";
import postgres from "postgres";
import { formatDailyPicks, formatDailyScreeningSummary, formatDailyFixtureSlateMessages, selectDailyPicks, isAvailabilityResearchSufficient, shouldSkipSentDailyPublication } from "./daily-picks.mjs";
import { parseFinalScore, settleHeadToHead, orientScoreToTip } from "./results-tracker.mjs";
import { createTelegramAssistant } from "./telegram-assistant.mjs";
import { enqueueFixtureResearch, processFixtureResearch, ensureFixtureResearchTables } from "./fixture-research.mjs";
import { addScraperSource, getScraperStatus, runBookmakerScrapers, createSingleFlight } from "./bookmaker-scraper.mjs";
import { runFixtureResultNotifications } from "./fixture-result-notifications.mjs";
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
const sql=postgres(process.env.DATABASE_URL,{max:5,idle_timeout:20,connect_timeout:10});
const db={query:async(text,values=[])=>{const rows=await sql.unsafe(text,values);return {rows,rowCount:rows.length};},json:value=>sql.json(value)};
const runBookmakerScrapersOnce = createSingleFlight((options={}) => runBookmakerScrapers(db, options));
const masterKey=Buffer.from(process.env.ASH_CREDENTIALS_KEY||"","base64");
const appToken=process.env.ASH_APP_TOKEN||"";
const cors={"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"authorization,content-type,x-ash-device-id","content-type":"application/json"};
const reply=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:cors});
const RATING_SOURCE="https://raw.githubusercontent.com/rangkim166-create/Ash-ai/main/data/history/ratings.json";
const normalizeTeamName=(value)=>String(value??"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g," ").trim();
async function ensureHistoricalRatingsTables(){
 await db.query(`CREATE TABLE IF NOT EXISTS historical_team_ratings(
  sport text NOT NULL,team_name text NOT NULL,normalized_name text NOT NULL,rating double precision NOT NULL,
  source_generated_at timestamptz NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(sport,normalized_name)
 )`);
 await db.query(`CREATE TABLE IF NOT EXISTS historical_ratings_meta(
  source text PRIMARY KEY,generated_at timestamptz NOT NULL,imported_at timestamptz NOT NULL DEFAULT now(),
  team_count integer NOT NULL,match_counts jsonb NOT NULL DEFAULT '{}'::jsonb
 )`);
}
async function importHistoricalRatings(){
 await ensureHistoricalRatingsTables();
 const prior=await db.query("SELECT generated_at,imported_at,team_count FROM historical_ratings_meta WHERE source='ash_elo_baseline'");
 if(prior.rowCount&&Date.now()-new Date(prior.rows[0].imported_at).getTime()<24*60*60*1000){
  return{skipped:true,teamCount:Number(prior.rows[0].team_count),generatedAt:prior.rows[0].generated_at};
 }
 const response=await fetch(RATING_SOURCE,{signal:AbortSignal.timeout(30000)});
 if(!response.ok)throw Error("Historical Elo archive HTTP "+response.status);
 const payload=await response.json();
 const generatedAt=payload.generated_at_utc;
 if(!generatedAt||!payload.ratings||typeof payload.ratings!=="object")throw Error("Historical Elo archive has an invalid format");
 if(prior.rowCount&&new Date(prior.rows[0].generated_at).getTime()>=new Date(generatedAt).getTime()){
  await db.query("UPDATE historical_ratings_meta SET imported_at=now() WHERE source='ash_elo_baseline'");
  return{skipped:true,teamCount:Number(prior.rows[0].team_count),generatedAt};
 }
 const unique=new Map();
 for(const [sport,teams] of Object.entries(payload.ratings)){
  for(const [team,rawRating] of Object.entries(teams||{})){
   const normalizedName=normalizeTeamName(team),rating=Number(rawRating);
   if(!normalizedName||!Number.isFinite(rating))continue;
   const key=sport+"|"+normalizedName,existing=unique.get(key);
   if(!existing||String(team).length>existing.team_name.length)unique.set(key,{sport,team_name:team,normalized_name:normalizedName,rating});
  }
 }
 const rows=[...unique.values()];
 for(let start=0;start<rows.length;start+=1500){
  const batch=rows.slice(start,start+1500),values=[];
  const tuples=batch.map((row,index)=>{
   const offset=index*4;
   values.push(row.sport,row.team_name,row.normalized_name,row.rating);
   return `($${offset+1},$${offset+2},$${offset+3},$${offset+4},$${batch.length*4+1}::timestamptz)`;
  });
  values.push(generatedAt);
  await db.query(`INSERT INTO historical_team_ratings(sport,team_name,normalized_name,rating,source_generated_at)
   VALUES ${tuples.join(",")}
   ON CONFLICT(sport,normalized_name) DO UPDATE SET team_name=EXCLUDED.team_name,rating=EXCLUDED.rating,
    source_generated_at=EXCLUDED.source_generated_at,imported_at=now()`,values);
 }
 await db.query(`INSERT INTO historical_ratings_meta(source,generated_at,imported_at,team_count,match_counts)
  VALUES('ash_elo_baseline',$1::timestamptz,now(),$2,$3::jsonb)
  ON CONFLICT(source) DO UPDATE SET generated_at=EXCLUDED.generated_at,imported_at=now(),
   team_count=EXCLUDED.team_count,match_counts=EXCLUDED.match_counts`,
  [generatedAt,rows.length,JSON.stringify(payload.match_counts||{})]);
 return{imported:true,teamCount:rows.length,matchCounts:payload.match_counts||{},generatedAt};
}
function encrypt(v){if(masterKey.length!==32)throw Error("ASH_CREDENTIALS_KEY must be base64 for 32 random bytes");const iv=randomBytes(12),c=createCipheriv("aes-256-gcm",masterKey,iv),d=Buffer.concat([c.update(JSON.stringify(v),"utf8"),c.final()]);return{encrypted_value:d.toString("base64"),iv:iv.toString("base64"),auth_tag:c.getAuthTag().toString("base64")};}
function decrypt(r){const d=createDecipheriv("aes-256-gcm",masterKey,Buffer.from(r.iv,"base64"));d.setAuthTag(Buffer.from(r.auth_tag,"base64"));return JSON.parse(Buffer.concat([d.update(Buffer.from(r.encrypted_value,"base64")),d.final()]).toString("utf8"));}
async function save(p,v){const e=encrypt(v);await db.query("INSERT INTO provider_credentials(provider,encrypted_value,iv,auth_tag) VALUES($1,$2,$3,$4) ON CONFLICT(provider) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,updated_at=now()",[p,e.encrypted_value,e.iv,e.auth_tag]);}
async function read(p){const env={the_odds_api:process.env.THE_ODDS_API_KEY,openrouter:process.env.OPENROUTER_API_KEY,groq:process.env.GROQ_API_KEY};if(p==="telegram_bot"&&process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID)return{botToken:process.env.TELEGRAM_BOT_TOKEN,chatId:process.env.TELEGRAM_CHAT_ID};if(env[p])return env[p];const r=await db.query("SELECT encrypted_value,iv,auth_tag FROM provider_credentials WHERE provider=$1",[p]);return r.rowCount?decrypt(r.rows[0]):null;}
async function test(p,k){let u,h={};if(p==="the_odds_api")u="https://api.the-odds-api.com/v4/sports?apiKey="+encodeURIComponent(k);else if(p==="openrouter"){u="https://openrouter.ai/api/v1/models";h.authorization="Bearer "+k;}else{u="https://api.groq.com/openai/v1/models";h.authorization="Bearer "+k;}const r=await fetch(u,{headers:h,signal:AbortSignal.timeout(12000)}),t=await r.text();if(!r.ok)throw Error("HTTP "+r.status+": "+t.slice(0,180));let j={};try{j=JSON.parse(t)}catch{}return{ok:true,available:Array.isArray(j)?j.length:(j.data?.length||0)};}
async function telegram(message){const c=await read("telegram_bot");if(!c?.botToken||!c?.chatId)throw Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Render environment variables; Telegram requires both to send messages");const r=await fetch("https://api.telegram.org/bot"+c.botToken+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:c.chatId,text:message,disable_web_page_preview:true}),signal:AbortSignal.timeout(15000)}),j=await r.json();if(!r.ok||!j.ok)throw Error(j.description||"Telegram failed");await db.query("INSERT INTO telegram_delivery_log(chat_id,message_preview,status,provider_message_id,sent_at) VALUES($1,$2,'sent',$3,now())",[c.chatId,message.slice(0,240),String(j.result?.message_id||"")]);return{sent:true,messageId:j.result?.message_id};}
const telegramAssistant=createTelegramAssistant({db,read,telegram});


async function collectOdds(maxSports=8){
 const key=await read("the_odds_api");
 if(!key)throw Error("The Odds API is not configured");
 // Check persisted scout state BEFORE touching the provider. A quota-exhausted
 // account must not burn requests on every scheduler tick or publisher retry.
 const priorRun=await db.query("SELECT id,started_at,status,error_summary FROM daily_scout_runs ORDER BY started_at DESC LIMIT 1");
 if(priorRun.rowCount){
  const prior=priorRun.rows[0],age=Date.now()-new Date(prior.started_at).getTime();
  const quotaBlocked=String(prior.error_summary||"").includes("OUT_OF_USAGE_CREDITS");
  const cooldown=quotaBlocked?24*60*60*1000:prior.status==="failed"?60*1000:prior.status==="partial"?5*60*1000:prior.status==="running"?5*60*1000:60*60*1000;
  if(Number.isFinite(age)&&age>=0&&age<cooldown)return{skipped:true,reason:quotaBlocked?"provider_quota_exhausted":"recent_scout_run",lastStatus:prior.status,lastStartedAt:prior.started_at,retryAfterSeconds:Math.ceil((cooldown-age)/1000)};
 }
 const sr=await fetch("https://api.the-odds-api.com/v4/sports?apiKey="+encodeURIComponent(key),{signal:AbortSignal.timeout(15000)});
 const st=await sr.text(); if(!sr.ok)throw Error("Odds sports list HTTP "+sr.status+": "+st.slice(0,160));
 const sports=JSON.parse(st).filter(s=>s.active&&/^(soccer_|basketball_|tennis_)/.test(s.key||"")&&!/(championship_winner|outright|winner$)/i.test(s.key||""));
 const priority=["saudi","egypt","morocco","qatar","uae","tunisia","algeria","soccer_epl","championship","bundesliga","la_liga","serie_a","ligue_one","basketball_nba","euroleague","tennis_atp","tennis_wta"];
 sports.sort((a,b)=>{const rank=x=>{const i=priority.findIndex(p=>x.key.includes(p));return i<0?99:i;};return rank(a)-rank(b);});
 const limit=Math.min(12,Math.max(1,maxSports));const arab=sports.filter(s=>["saudi","egypt","morocco","qatar","uae","tunisia","algeria"].some(x=>s.key.includes(x)));const football=sports.filter(s=>s.key.startsWith("soccer_")&&!arab.includes(s));const basketball=sports.filter(s=>s.key.startsWith("basketball_"));const tennis=sports.filter(s=>s.key.startsWith("tennis_"));const selected=[...arab.slice(0,2),...football.slice(0,3),...basketball.slice(0,2),...tennis.slice(0,1)];for(const s of sports){if(selected.length>=limit)break;if(!selected.includes(s))selected.push(s);}
 const last=await db.query("SELECT id,started_at,status FROM daily_scout_runs ORDER BY started_at DESC LIMIT 1");
 if(last.rowCount){
  const prior=last.rows[0],age=Date.now()-new Date(prior.started_at).getTime();
  // Recover a stale in-flight run after a process restart.
  if(prior.status==="running"&&Number.isFinite(age)&&age>=5*60*1000){
   await db.query("UPDATE daily_scout_runs SET status='failed',finished_at=now(),error_summary='Recovered stale run after process restart' WHERE id=$1 AND status='running'",[prior.id]);
  }
 }
 const run=await db.query("INSERT INTO daily_scout_runs(status) VALUES('running') RETURNING id");
 const runId=run.rows[0].id, observedAt=new Date().toISOString();
 let fixtures=0, saved=0, quotaExhausted=false; const errors=[], results=[];
 for(const sport of selected){
  const kind=sport.key.startsWith("soccer_")?"football":sport.key.startsWith("basketball_")?"basketball":"tennis";
  const markets=kind==="basketball"?"h2h,spreads,totals":kind==="tennis"?"h2h":"h2h,totals";
  try{
   const u="https://api.the-odds-api.com/v4/sports/"+encodeURIComponent(sport.key)+"/odds?regions=uk,eu&markets="+markets+"&oddsFormat=decimal&apiKey="+encodeURIComponent(key);
   const r=await fetch(u,{signal:AbortSignal.timeout(18000)}),t=await r.text();
   if(!r.ok)throw Error("HTTP "+r.status+": "+t.slice(0,160));
   const events=JSON.parse(t);let n=0,o=0;
   for(const e of events){
    if(!e.id||!e.home_team||!e.away_team)continue;
    const id=sport.key+":"+e.id;
    await db.query("INSERT INTO sports_matches(id,sport,competition,home_or_player_one,away_or_player_two,starts_at,status,source,source_updated_at,updated_at) VALUES($1,$2,$3,$4,$5,$6::timestamptz,'scheduled','the_odds_api',$7::timestamptz,now()) ON CONFLICT(id) DO UPDATE SET competition=EXCLUDED.competition,home_or_player_one=EXCLUDED.home_or_player_one,away_or_player_two=EXCLUDED.away_or_player_two,starts_at=EXCLUDED.starts_at,source_updated_at=EXCLUDED.source_updated_at,updated_at=now()",
    [id,kind,sport.title||sport.key,e.home_team,e.away_team,e.commence_time||null,observedAt]);
    fixtures++;n++;
    for(const b of(e.bookmakers||[])){const bookUpdated=Date.parse(b.last_update||"");const bookAgeMinutes=(Date.now()-bookUpdated)/60000;if(!Number.isFinite(bookUpdated)||bookAgeMinutes<0||bookAgeMinutes>15)continue;for(const m of(b.markets||[]))for(const v of(m.outcomes||[])){
     const price=Number(v.price);if(!v.name||!Number.isFinite(price)||price<=1)continue;
     const point=v.point==null?null:Number(v.point);
     const inserted=await db.query("INSERT INTO bookmaker_odds(match_id,bookmaker_key,market_key,outcome_name,decimal_odds,line,observed_at,source) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,'the_odds_api') ON CONFLICT DO NOTHING RETURNING id",
     [id,b.key||b.title||"unknown",m.key||"unknown",v.name,price,Number.isFinite(point)?point:null,observedAt]);
     saved+=inserted.rowCount;o+=inserted.rowCount;
    }}
   }
   results.push({sport:sport.key,fixtures:n,odds:o});
  }catch(e){
   const detail=String(e.message||e).slice(0,180);
   errors.push({sport:sport.key,error:detail});results.push({sport:sport.key,error:detail});
   if(/OUT_OF_USAGE_CREDITS|usage quota has been reached/i.test(detail)){
    quotaExhausted=true;
    console.error("[ash-scout] provider quota exhausted; stopping remaining sports to prevent wasted requests");
    break;
   }
  }
 }
 const status=errors.length?(fixtures?"partial":"failed"):"success";
 await db.query("UPDATE daily_scout_runs SET finished_at=now(),status=$1,fixtures_seen=$2,odds_snapshots_saved=$3,error_summary=$4 WHERE id=$5",
 [status,fixtures,saved,errors.length?JSON.stringify(errors).slice(0,2500):null,runId]);
 const researchQueue=await enqueueFixtureResearch(db).catch(e=>({error:String(e.message||e).slice(0,160)}));
 return{runId,status,sportsAttempted:results.length,fixturesSeen:fixtures,oddsSnapshotsSaved:saved,observedAt,results,errors,quotaExhausted,researchQueue};
}



async function ensureTipResultsTables(){
 await db.query(`CREATE TABLE IF NOT EXISTS ash_tip_results(
  tip_id text PRIMARY KEY,local_date date NOT NULL,match_id text NOT NULL,source_event_id text NOT NULL,
  sport_key text NOT NULL,sport text NOT NULL,competition text NOT NULL,home_team text NOT NULL,away_team text NOT NULL,
  commence_time timestamptz NOT NULL,selection text NOT NULL,market_key text NOT NULL DEFAULT 'h2h',
  decimal_odds double precision NOT NULL,bookmakers integer NOT NULL DEFAULT 0,reason text,
  status text NOT NULL DEFAULT 'pending',home_score integer,away_score integer,profit_units double precision,
  result_source text,settled_at timestamptz,notification_status text NOT NULL DEFAULT 'pending',
  notification_updated_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
 )`);
 await db.query("CREATE INDEX IF NOT EXISTS ash_tip_results_pending_idx ON ash_tip_results(status,commence_time)");
 await db.query("CREATE INDEX IF NOT EXISTS ash_tip_results_settled_idx ON ash_tip_results(settled_at,status)");
 await db.query(`CREATE TABLE IF NOT EXISTS ash_tip_result_summaries(
  local_date date PRIMARY KEY,status text NOT NULL DEFAULT 'pending',message_text text,
  sent_at timestamptz,created_at timestamptz NOT NULL DEFAULT now()
 )`);
}
async function savePublishedTips(localDay,picks){
 await ensureTipResultsTables();
 for(const pick of picks||[]){
  const matchId=String(pick.id||"");
  const separator=matchId.indexOf(":");
  if(separator<1)continue;
  const sportKey=matchId.slice(0,separator),eventId=matchId.slice(separator+1);
  const tipId=localDay+"|"+matchId+"|h2h|"+String(pick.selection||"");
  await db.query(`INSERT INTO ash_tip_results(
   tip_id,local_date,match_id,source_event_id,sport_key,sport,competition,home_team,away_team,
   commence_time,selection,market_key,decimal_odds,bookmakers,reason
  ) VALUES($1,$2::date,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,'h2h',$12,$13,$14)
  ON CONFLICT(tip_id) DO NOTHING`,[
   tipId,localDay,matchId,eventId,sportKey,pick.sport||"unknown",pick.competition||"",
   pick.home_team||"",pick.away_team||"",pick.commence_time,pick.selection,
   Number(pick.price),Number(pick.bookmakers||0),pick.reason||""
  ]);
  const probability = Number(pick.estimated_probability_pct);
  if (Number.isFinite(probability) && probability > 0 && probability < 100) {
   const evidence = {
    edgeType: pick.edge_type || null,
    marketProbabilityPct: pick.market_probability_pct ?? null,
    impliedProbabilityPct: pick.implied_probability_pct ?? null,
    valueEdgePct: pick.value_edge_pct ?? null,
    expectedValuePct: pick.expected_value_pct ?? null,
    evidenceIndex: pick.evidence_index ?? null,
    bookmakerNames: pick.bookmaker_names || null,
    bestBookmaker: pick.best_bookmaker || null,
    historicalMatchCount: pick.historical_match_count ?? null,
    researchQuality: pick.web_research?.quality || null,
    researchSources: (pick.web_research?.pages || []).slice(0, 5).map(page => ({
     title: page.title || null, url: page.url || null, domain: page.domain || null, date: page.date || null
    })),
    availabilityResearch: pick.availability_research || null
   };
   await db.query(
    "INSERT INTO ash_predictions(match_id,model_version,market_key,selection,offered_odds,estimated_probability,confidence_score,evidence,reasoning,status) " +
    "SELECT $1,$2,'h2h',$3,$4,$5,$6,$7::jsonb,$8,'pending' " +
    "WHERE NOT EXISTS (SELECT 1 FROM ash_predictions WHERE match_id=$1 AND model_version=$2 AND market_key='h2h' AND selection=$3)",
    [matchId, "ash-hybrid-v1", pick.selection, Number(pick.price), probability / 100,
     Number(pick.evidence_index || 0), JSON.stringify(evidence), String(pick.reason || "")]
   );
  }
 }
}
async function backfillPublishedTips(){
 await ensureTipResultsTables();
 const days=await db.query("SELECT local_date,picks_json FROM ash_daily_publications WHERE picks_count>0 AND local_date>=((now() AT TIME ZONE 'Africa/Kampala')::date-7) ORDER BY local_date");
 let imported=0;
 for(const row of days.rows){
  const picks=Array.isArray(row.picks_json)?row.picks_json:[];
  await savePublishedTips(String(row.local_date).slice(0,10),picks);
  imported+=picks.length;
 }
 return{days:days.rowCount,picks:imported};
}
async function deliverPendingResultNotifications(){
 const rows=await db.query("SELECT tip_id,home_team,away_team,selection,decimal_odds,home_score,away_score,status,profit_units FROM ash_tip_results WHERE status IN ('won','lost','void') AND notification_status IN ('pending','failed','sending') AND (notification_updated_at IS NULL OR notification_updated_at<now()-interval '10 minutes') ORDER BY settled_at ASC LIMIT 20");
 let sent=0,failed=0;
 for(const row of rows.rows){
  const claimed=await db.query("UPDATE ash_tip_results SET notification_status='sending',notification_updated_at=now() WHERE tip_id=$1 AND notification_status IN ('pending','failed','sending') AND (notification_updated_at IS NULL OR notification_updated_at<now()-interval '10 minutes') RETURNING tip_id",[row.tip_id]);
  if(!claimed.rowCount)continue;
  const profit=Number(row.profit_units||0);
  const message="ASH • PICK RESULT\n"+row.home_team+" "+row.home_score+" - "+row.away_score+" "+row.away_team+
   "\nPick: "+row.selection+" @ "+Number(row.decimal_odds).toFixed(2)+
   "\nResult: "+row.status.toUpperCase()+"\nP/L: "+(profit>0?"+":"")+profit.toFixed(2)+" units"+
   "\nFinal score source: The Odds API";
  try{
   await telegram(message);
   await db.query("UPDATE ash_tip_results SET notification_status='sent',notification_updated_at=now() WHERE tip_id=$1",[row.tip_id]);
   sent++;
  }catch(error){
   await db.query("UPDATE ash_tip_results SET notification_status='failed',notification_updated_at=now() WHERE tip_id=$1",[row.tip_id]);
   failed++;
   console.error("[ash-results] Telegram result notification failed",row.tip_id,String(error?.message||error).slice(0,160));
  }
 }
 return{sent,failed};
}
async function runTipResultsTracker(){
 await ensureTipResultsTables();
 // Keep the live fixture feed clean without inventing scores or declaring a result.
 const overdueFixtures=await db.query(`UPDATE sports_matches SET status='awaiting_result',updated_at=now()
  WHERE status='scheduled' AND home_score IS NULL AND away_score IS NULL
   AND starts_at < now() - CASE
    WHEN LOWER(sport)='football' THEN interval '3 hours'
    WHEN LOWER(sport)='basketball' THEN interval '4 hours'
    WHEN LOWER(sport)='tennis' THEN interval '10 hours'
    ELSE interval '6 hours' END
  RETURNING sport`);
 const overdueBySport=overdueFixtures.rows.reduce((counts,row)=>{const key=String(row.sport||"other");counts[key]=(counts[key]||0)+1;return counts;},{});

 const backfill=await backfillPublishedTips();
 // ESPN's final-score worker updates sports_matches by exact ESPN IDs or a strict
 // participant+kickoff match. Scraped bookmaker IDs are not The Odds API event IDs,
 // so settle those saved tips from the verified scoreboard row they now point to.
 const scoreboard=await db.query(`SELECT t.tip_id,t.match_id,t.selection,t.decimal_odds,t.home_team,t.away_team,
   m.home_or_player_one AS fixture_home,m.away_or_player_two AS fixture_away,m.home_score,m.away_score
   FROM ash_tip_results t JOIN sports_matches m ON m.id=t.match_id
   WHERE t.status='pending' AND m.status='completed' AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL
    AND t.commence_time<=now()+interval '15 minutes' AND t.commence_time>=now()-interval '4 days'
   ORDER BY t.commence_time ASC LIMIT 250`);
 let scoreboardSettled=0;
 for(const tip of scoreboard.rows){
  const score=orientScoreToTip(tip.home_team,tip.away_team,tip.fixture_home,tip.fixture_away,tip.home_score,tip.away_score);
  if(!score)continue;
  const outcome=settleHeadToHead(tip.selection,tip.home_team,tip.away_team,score.homeScore,score.awayScore);
  if(!outcome)continue;
  const profit=outcome==="won"?Number(tip.decimal_odds)-1:-1;
  const saved=await db.query(`UPDATE ash_tip_results SET status=$2,home_score=$3,away_score=$4,
    profit_units=$5,result_source='espn_scoreboard',settled_at=now(),updated_at=now()
    WHERE tip_id=$1 AND status='pending' RETURNING tip_id`,
   [tip.tip_id,outcome,score.homeScore,score.awayScore,profit]);
  if(!saved.rowCount)continue;
  await db.query("UPDATE ash_predictions SET status=$3,settled_at=now() WHERE match_id=$1 AND selection=$2 AND market_key='h2h' AND status='pending'",
   [tip.match_id,tip.selection,outcome]);
  scoreboardSettled++;
 }
 // Keep old unresolved tips visible as unverified; never turn missing data into a loss or void.
 await db.query("UPDATE ash_tip_results SET status='unverified',updated_at=now() WHERE status='pending' AND commence_time<now()-interval '4 days'");
 await db.query("UPDATE ash_predictions p SET status='stale',settled_at=now() WHERE p.status='pending' AND EXISTS (SELECT 1 FROM ash_tip_results t WHERE t.match_id=p.match_id AND t.selection=p.selection AND t.status='unverified')");
 const apiKey=await read("the_odds_api");
 if(!apiKey){
  const notifications=await deliverPendingResultNotifications(),summary=await maybeSendDailyResultsSummary();
  return{checked:0,settled:scoreboardSettled,scoreboardSettled,backfill,overdueFixtures:overdueFixtures.rowCount,overdueBySport,notifications,summary,reason:"odds_api_not_configured"};
 }
 const pending=await db.query("SELECT * FROM ash_tip_results WHERE status='pending' AND commence_time<=now()+interval '15 minutes' AND commence_time>=now()-interval '4 days' ORDER BY commence_time ASC LIMIT 250");
 if(!pending.rowCount){const notifications=await deliverPendingResultNotifications();const summary=await maybeSendDailyResultsSummary();return{checked:0,settled:scoreboardSettled,scoreboardSettled,backfill,overdueFixtures:overdueFixtures.rowCount,overdueBySport,notifications,summary,reason:"no_due_tips"};}
 const groups=new Map();
 for(const tip of pending.rows){if(!groups.has(tip.sport_key))groups.set(tip.sport_key,[]);groups.get(tip.sport_key).push(tip);}
 let checked=0,settled=0;const errors=[];
 for(const [sportKey,tips] of groups){
  // Only The Odds API sport keys are valid for its scores endpoint.
  if(!/^(soccer_|basketball_|tennis_)/.test(sportKey))continue;
  for(let offset=0;offset<tips.length;offset+=25){
   const batch=tips.slice(offset,offset+25);
   const eventIds=[...new Set(batch.map(x=>x.source_event_id).filter(x=>/^[A-Za-z0-9_-]{20,80}$/.test(x)))];
   if(!eventIds.length)continue;
   try{
    const url="https://api.the-odds-api.com/v4/sports/"+encodeURIComponent(sportKey)+"/scores?daysFrom=3&eventIds="+encodeURIComponent(eventIds.join(","))+"&apiKey="+encodeURIComponent(apiKey);
    const response=await fetch(url,{signal:AbortSignal.timeout(18000)});
    const body=await response.text();
    if(!response.ok)throw Error("Scores HTTP "+response.status+": "+body.slice(0,160));
    const events=JSON.parse(body);checked+=batch.length;
    const byId=new Map((Array.isArray(events)?events:[]).map(event=>[String(event.id),event]));
    for(const tip of batch){
     const event=byId.get(String(tip.source_event_id));
     const score=parseFinalScore(event,tip.home_team,tip.away_team);
     if(!score)continue;
     const outcome=settleHeadToHead(tip.selection,tip.home_team,tip.away_team,score.homeScore,score.awayScore);
     if(!outcome)continue;
     const profit=outcome==="won"?Number(tip.decimal_odds)-1:-1;
     const saved=await db.query(`UPDATE ash_tip_results SET status=$2,home_score=$3,away_score=$4,
       profit_units=$5,result_source='the_odds_api_scores',settled_at=now(),updated_at=now()
       WHERE tip_id=$1 AND status='pending' RETURNING tip_id,home_team,away_team,selection,decimal_odds,home_score,away_score,profit_units`,
      [tip.tip_id,outcome,score.homeScore,score.awayScore,profit]);
     if(!saved.rowCount)continue;
     await db.query("UPDATE ash_predictions SET status=$3,settled_at=now() WHERE match_id=$1 AND selection=$2 AND market_key='h2h' AND status='pending'",
      [tip.match_id,tip.selection,outcome]);
     settled++;
     const row=saved.rows[0];
     // Delivery is handled by the retryable notification outbox after all scores are saved.
    }
   }catch(error){errors.push({sport:sportKey,error:String(error?.message||error).slice(0,180)});}
  }
 }
 const notifications=await deliverPendingResultNotifications();
 const summary=await maybeSendDailyResultsSummary();
 return{checked,settled:settled+scoreboardSettled,oddsApiSettled:settled,scoreboardSettled,backfill,overdueFixtures:overdueFixtures.rowCount,overdueBySport,notifications,errors,summary};
}
async function maybeSendDailyResultsSummary(){
 const localNow=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Kampala",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date());
 if(localNow<"23:00")return{sent:false,reason:"not_summary_time"};
 const localDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Kampala",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const prior=await db.query("SELECT status FROM ash_tip_result_summaries WHERE local_date=$1::date",[localDay]);
 if(prior.rowCount&&prior.rows[0].status==="sent")return{sent:false,reason:"already_sent_today"};
 const stats=await db.query(`SELECT
  COUNT(*) FILTER(WHERE status='won' AND (settled_at AT TIME ZONE 'Africa/Kampala')::date=$1::date)::int AS won,
  COUNT(*) FILTER(WHERE status='lost' AND (settled_at AT TIME ZONE 'Africa/Kampala')::date=$1::date)::int AS lost,
  COUNT(*) FILTER(WHERE status='void' AND (settled_at AT TIME ZONE 'Africa/Kampala')::date=$1::date)::int AS void,
  COUNT(*) FILTER(WHERE status IN ('pending','unverified'))::int AS pending,
  COALESCE(SUM(profit_units) FILTER(WHERE status IN ('won','lost') AND (settled_at AT TIME ZONE 'Africa/Kampala')::date=$1::date),0)::float8 AS profit
  FROM ash_tip_results`,[localDay]);
 const row=stats.rows[0],settled=Number(row.won)+Number(row.lost);
 const hitRate=settled?((Number(row.won)/settled)*100).toFixed(1):"n/a";
 const profit=Number(row.profit||0);
 const message="ASH • DAILY RESULTS — "+localDay+
  "\nWon: "+row.won+" | Lost: "+row.lost+" | Void: "+row.void+
  "\nStill pending/unverified: "+row.pending+
  "\nHit rate: "+hitRate+"%"+
  "\nNet: "+(profit>0?"+":"")+profit.toFixed(2)+" units"+
  "\nOne unit stake per pick; results only where final scores were verified.";
 await db.query("INSERT INTO ash_tip_result_summaries(local_date,status,message_text) VALUES($1::date,'sending',$2) ON CONFLICT(local_date) DO UPDATE SET status='sending',message_text=EXCLUDED.message_text",[localDay,message]);
 try{
  await telegram(message);
  await db.query("UPDATE ash_tip_result_summaries SET status='sent',sent_at=now() WHERE local_date=$1::date",[localDay]);
  return{sent:true,localDate:localDay,settled};
 }catch(error){
  await db.query("UPDATE ash_tip_result_summaries SET status='failed' WHERE local_date=$1::date",[localDay]);
  return{sent:false,error:String(error?.message||error).slice(0,180)};
 }
}

async function runScheduledDailyPublisher(){
  const independentFixtures=await discoverPublicFixtures(db).catch(error=>({error:String(error.message||error).slice(0,180)}));
 const localDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Kampala",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 await db.query(`CREATE TABLE IF NOT EXISTS ash_daily_publications(
  local_date date PRIMARY KEY,
  status text NOT NULL,
  picks_count integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  message_preview text,
  message_text text,
  picks_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
 )`);
 await db.query("ALTER TABLE ash_daily_publications ADD COLUMN IF NOT EXISTS message_text text, ADD COLUMN IF NOT EXISTS picks_json jsonb NOT NULL DEFAULT '[]'::jsonb");
 const prior=await db.query("SELECT status,started_at,picks_count,message_text FROM ash_daily_publications WHERE local_date=$1::date",[localDay]);
 if(prior.rowCount&&shouldSkipSentDailyPublication(prior.rows[0]))return{sent:false,skipped:true,reason:Number(prior.rows[0].picks_count||0)>0?"already_sent_today":"zero_pick_retry_cooldown",localDate:localDay};
 if(prior.rowCount&&prior.rows[0].status==="sending"&&Date.now()-new Date(prior.rows[0].started_at).getTime()<20*60*1000)return{sent:false,skipped:true,reason:"publish_already_running",localDate:localDay};
 await db.query("INSERT INTO ash_daily_publications(local_date,status,attempts,started_at) VALUES($1::date,'sending',1,now()) ON CONFLICT(local_date) DO UPDATE SET status='sending',attempts=ash_daily_publications.attempts+1,started_at=now(),error_summary=NULL",[localDay]);
 try{
   let scraper;
   try{scraper=await runBookmakerScrapersOnce({limit:8});}
   catch(error){scraper={status:"failed",error:String(error?.message||error).slice(0,180)};console.error("[ash-daily] scraper failed; using stored fixtures",scraper.error);}
   const collection={source:'public_scrape',providerOddsApiUsed:false,scraper,independentFixtures};
  const fixturesResult=await db.query("SELECT id,sport,competition,home_or_player_one AS home,away_or_player_two AS away,starts_at FROM sports_matches WHERE status='scheduled' AND starts_at>now()+interval '30 minutes' AND starts_at<=now()+interval '36 hours' ORDER BY starts_at ASC");
  const fixtures=fixturesResult.rows;
  // Continue to a Telegram slate even when the collection window has no fixtures.
  const ids=fixtures.map(row=>row.id);
  const oddsResult=await db.query("SELECT DISTINCT ON(match_id,bookmaker_key,market_key,outcome_name) match_id,bookmaker_key,market_key,outcome_name,decimal_odds,observed_at FROM bookmaker_odds WHERE match_id=ANY($1::text[]) AND market_key='h2h' AND source='public_scrape' AND observed_at>now()-interval '15 minutes' ORDER BY match_id,bookmaker_key,market_key,outcome_name,observed_at DESC",[ids]);
  // Missing fresh odds block betting picks, but must not suppress the fixture list.
  const formResult=await db.query(`WITH upcoming AS(
    SELECT id,sport,home_or_player_one,away_or_player_two FROM sports_matches WHERE id=ANY($1::text[])
   ), teams AS(
    SELECT sport,home_or_player_one AS team FROM upcoming
    UNION
    SELECT sport,away_or_player_two AS team FROM upcoming
   )
   SELECT t.sport,t.team,r.starts_at,
    CASE WHEN LOWER(r.home_or_player_one)=LOWER(t.team) THEN
      CASE WHEN r.home_score>r.away_score THEN 'W' WHEN r.home_score<r.away_score THEN 'L' ELSE 'D' END
     ELSE CASE WHEN r.away_score>r.home_score THEN 'W' WHEN r.away_score<r.home_score THEN 'L' ELSE 'D' END END AS outcome
   FROM teams t
   CROSS JOIN LATERAL(
    SELECT m.starts_at,m.home_or_player_one,m.away_or_player_two,m.home_score,m.away_score
    FROM sports_matches m
    WHERE m.sport=t.sport AND m.status='completed' AND m.source IS DISTINCT FROM 'the_odds_api'
      AND m.starts_at<now() AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL
      AND (LOWER(m.home_or_player_one)=LOWER(t.team) OR LOWER(m.away_or_player_two)=LOWER(t.team))
    ORDER BY m.starts_at DESC LIMIT 10
   ) r`,[ids]);
  await ensureHistoricalRatingsTables();
  const teamNames=[...new Set(fixtures.flatMap(row=>[normalizeTeamName(row.home),normalizeTeamName(row.away)]).filter(Boolean))];
  const sports=[...new Set(fixtures.map(row=>String(row.sport||"").toLowerCase()).filter(Boolean))];
  const ratingRows=await db.query("SELECT sport,normalized_name,rating FROM historical_team_ratings WHERE sport=ANY($1::text[]) AND normalized_name=ANY($2::text[])",[sports,teamNames]);
  const ratings={};
  for(const row of ratingRows.rows){if(!ratings[row.sport])ratings[row.sport]={};ratings[row.sport][row.normalized_name]=Number(row.rating);}
  const ratingMetaResult=await db.query("SELECT match_counts,generated_at FROM historical_ratings_meta WHERE source='ash_elo_baseline'");
  const ratingMatchCounts=ratingMetaResult.rowCount?(ratingMetaResult.rows[0].match_counts||{}):{};
  const picks=selectDailyPicks(fixtures,oddsResult.rows,formResult.rows,{now:new Date(),maxPicks:3,ratings,ratingMatchCounts});
  const screenedCandidateCount=picks.length;
  await ensureFixtureResearchTables(db);
  const availabilityRows=picks.length?await db.query("SELECT match_id,researched_at,source_count,independent_domains,sources,assessment,coverage FROM ash_fixture_research WHERE match_id=ANY($1::text[]) AND researched_at>now()-interval '24 hours'",[picks.map(p=>String(p.id))]):{rows:[]};
  const availabilityByMatch=new Map(availabilityRows.rows.map(row=>[String(row.match_id),row]));
  for(const pick of picks){const report=availabilityByMatch.get(String(pick.id));pick.availability_research=report?{researchedAt:report.researched_at,sourceCount:Number(report.source_count||0),independentDomains:Number(report.independent_domains||0),sources:report.sources||[],assessment:report.assessment||{},coverage:report.coverage||{}}:{status:"not_yet_researched",sourceCount:0,assessment:{unknowns:["No recent injury/lineup/news research is available for this fixture."]}};}
  // The Odds API finds candidate fixtures; independent web reporting adds match context.
  const availabilityQualified=picks.filter(pick=>isAvailabilityResearchSufficient(pick.availability_research,{fixtureStart:pick.commence_time,sport:pick.sport,now:new Date()}));
  const availabilityQualifiedIds=new Set(availabilityQualified.map(pick=>String(pick.id)));
  let webResearch=[];
  if(availabilityQualified.length){
   try{webResearch=await telegramAssistant.researchDailyPicks(availabilityQualified);}
   catch(error){console.error("[ash-daily-research] web research failed; picks remain held",String(error?.message||error).slice(0,180));}
  }
  const researchByMatch=new Map(webResearch.map(item=>[String(item.matchId),item]));
  const researchedPicks=[];
  for(const pick of picks){
   const availabilityApproved=availabilityQualifiedIds.has(String(pick.id));
   pick.availability_research_gate=availabilityApproved?"approved":"held_no_bet";
   const research=availabilityApproved?researchByMatch.get(String(pick.id)):null;
   pick.web_research=research||{status:"research_unavailable",pages:[],quality:{homeCoverage:false,awayCoverage:false,expertCoverage:false,independentDomains:0}};
   const quality=pick.web_research.quality||{};
   const analysis=pick.web_research.analysis||{};
   const approved=availabilityApproved&&quality.homeCoverage===true&&quality.awayCoverage===true&&quality.expertCoverage===true&&Number(quality.independentDomains)>=3&&Number(quality.independentExpertDomains)>=2&&analysis.decision==="SUPPORT"&&Number(analysis.confidence)>=70;
   pick.research_gate=approved?"approved":"held_no_bet";
   if(approved)researchedPicks.push(pick);
   else console.log("[ash-daily-pick-held]",JSON.stringify({match:pick.home_team+" vs "+pick.away_team,reason:availabilityApproved?"strict_web_evidence_gate":"availability_injury_lineup_evidence_missing_or_stale",availabilityGate:pick.availability_research_gate,quality,decision:analysis.decision||"missing",confidence:analysis.confidence||0}));
  }
  const screeningSummary=formatDailyScreeningSummary({
   candidateCount:screenedCandidateCount,
   availabilityBlocked:screenedCandidateCount-availabilityQualified.length,
   expertBlocked:availabilityQualified.length-researchedPicks.length,
   qualifiedCount:researchedPicks.length
  });
  picks.splice(0,picks.length,...researchedPicks);
  const dayLabel=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Kampala",day:"2-digit",month:"short",year:"numeric"}).format(new Date());
  const sportOrder=["football","basketball","tennis"];
  const sportLabels={football:"⚽ FOOTBALL",soccer:"⚽ FOOTBALL",basketball:"🏀 BASKETBALL",tennis:"🎾 TENNIS"};
  const groups=new Map();
  for(const pick of picks){const key=String(pick.sport||"other").toLowerCase();if(!groups.has(key))groups.set(key,[]);groups.get(key).push(pick);}
  const orderedKeys=[...sportOrder.filter(key=>groups.has(key)),...([...groups.keys()].filter(key=>!sportOrder.includes(key)).sort())];
  const messages=orderedKeys.map(key=>{
   const label=sportLabels[key]||("🏆 "+key.toUpperCase());
   return label+"\\n"+screeningSummary+"\\n\\n"+formatDailyPicks(dayLabel,groups.get(key));
  });
  const message=messages.length?messages.join("\\n\\n━━━━━━━━━━━━━━━━━━\\n\\n"):"ASH • ODDS OF THE DAY — "+dayLabel+"\\n\\n"+screeningSummary+"\\n\\nNo selection passed all checks. NO BET.";
  // Always send the fixture inventory separately from the strict, evidence-qualified picks.
  // This lets Ash deliver the daily games for human review without forcing a prediction.
  const slateMessages=formatDailyFixtureSlateMessages(dayLabel,fixtures,oddsResult.rows);
  const deliveryMessages=[...(messages.length?messages:[message]),...slateMessages];
  const fullMessage=deliveryMessages.join("\\n\\n━━━━━━━━━━━━━━━━━━\\n\\n");
  // Persist the complete grouped publication before delivery.
  await db.query("UPDATE ash_daily_publications SET picks_count=$2,message_preview=$3,message_text=$4,picks_json=$5::jsonb WHERE local_date=$1::date",[localDay,picks.length,fullMessage.slice(0,500),fullMessage,JSON.stringify(picks)]);
  await savePublishedTips(localDay,picks);
  const bot=await read("telegram_bot");
  if(!bot?.botToken||!bot?.chatId){
   await db.query("UPDATE ash_daily_publications SET status='waiting_for_telegram_config',error_summary=$2 WHERE local_date=$1::date",[localDay,"Telegram bot token and chat ID are not configured."]);
   return{sent:false,reason:"telegram_not_configured",picks:picks.length,fixtures:fixtures.length,localDate:localDay};
  }
  const deliveries=[];
  for(const outgoing of deliveryMessages){deliveries.push(await telegram(outgoing));}
  await db.query("UPDATE ash_daily_publications SET status='sent',error_summary=NULL,sent_at=now() WHERE local_date=$1::date",[localDay]);
  return{sent:true,picks:picks.length,fixtures:fixtures.length,fixtureMessages:slateMessages.length,sports:orderedKeys,localDate:localDay,deliveries,collection};
 }catch(error){
  const detail=String(error?.message||error).slice(0,300);
  await db.query("UPDATE ash_daily_publications SET status='failed',error_summary=$2 WHERE local_date=$1::date",[localDay,detail]).catch(()=>{});
  throw error;
 }
}

export default {async configureTelegramWebhook(){return await telegramAssistant.configureWebhook();},async runScheduledScraping(){const scraper=await runBookmakerScrapersOnce({limit:8});const fixtures=await discoverPublicFixtures(db).catch(e=>({error:String(e.message||e).slice(0,160)}));return{scraper,independentFixtures:fixtures};},async runScheduledCollection(){const independentFixtures=await discoverPublicFixtures(db).catch(e=>({error:String(e.message||e).slice(0,160)}));let collection=null;try{collection=await collectOdds(8);}catch(e){console.error("[ash-research-queue] collection",String(e.message||e).slice(0,160));}const queued=await enqueueFixtureResearch(db).catch(e=>({error:String(e.message||e).slice(0,160)}));const research=await processFixtureResearch(db,{limit:8,groqKey:await read("groq"),openrouterKey:await read("openrouter")}).catch(e=>({error:String(e.message||e).slice(0,160)}));return{independentFixtures,collection,queued,research};},async runScheduledFixtureResearch(){const independentFixtures=await discoverPublicFixtures(db).catch(e=>({error:String(e.message||e).slice(0,160)}));const queued=await enqueueFixtureResearch(db);const research=await processFixtureResearch(db,{limit:4,groqKey:await read("groq"),openrouterKey:await read("openrouter")});return{independentFixtures,queued,research};},async runHistoricalRatingsImport(){return await importHistoricalRatings();},async runScheduledDailyPublisher(){return await runScheduledDailyPublisher();},async runTipResultsTracker(){return await runTipResultsTracker();},async runFixtureResultNotifications(){return await runFixtureResultNotifications(db,telegram);},async fetch(req){if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});const p=new URL(req.url).pathname;if(p==="/v1/telegram/webhook"&&req.method==="POST"){try{const secret=req.headers.get("x-telegram-bot-api-secret-token")||"";if(!(await telegramAssistant.verifySecret(secret)))return reply({error:"unauthorized"},401);const update=await req.json();void telegramAssistant.handleUpdate(update).catch(e=>console.error("[ash-telegram-webhook]",String(e.message||e)));return reply({ok:true});}catch(e){console.error("[ash-telegram-webhook]",e);return reply({error:"invalid_update"},400);}}if(p==="/health"&&req.method==="GET"){try{await db.query("SELECT 1");return reply({ok:true,service:"ash-sports-api",database:"connected"});}catch{return reply({ok:false,error:"database_unavailable"},503);}}
if(p.startsWith("/v1/public/")){
try{
if(p==="/v1/public/scout/signals"&&(req.method==="GET"||req.method==="POST")){
 const deviceId=String(req.headers.get("x-ash-device-id")||"").trim();
 if(deviceId.length<16||deviceId.length>100||!/^[A-Za-z0-9-]+$/.test(deviceId))return reply({error:"device_identity_required"},400);
 const ownerKey=createHash("sha256").update(deviceId).digest("hex");
 await db.query(`CREATE TABLE IF NOT EXISTS ash_user_scout_signals(
  id bigserial PRIMARY KEY,match_id text REFERENCES sports_matches(id) ON DELETE SET NULL,
  sport text NOT NULL,team text NOT NULL,normalized_team text NOT NULL,opinion text NOT NULL,
  reason text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'active',owner_key text NOT NULL DEFAULT 'legacy',
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
 )`);
 await db.query("ALTER TABLE ash_user_scout_signals ADD COLUMN IF NOT EXISTS owner_key text NOT NULL DEFAULT 'legacy'");
 await db.query("CREATE INDEX IF NOT EXISTS ash_user_scout_signals_owner_idx ON ash_user_scout_signals(owner_key,created_at DESC)");
 if(req.method==="GET"){
  const rows=await db.query(`SELECT s.id,s.sport,s.team,s.opinion,s.reason,s.status,s.created_at,
   m.id AS fixture_id,m.competition,m.home_or_player_one AS home,m.away_or_player_two AS away,m.starts_at
   FROM ash_user_scout_signals s LEFT JOIN sports_matches m ON m.id=s.match_id
   WHERE s.owner_key=$1 ORDER BY s.created_at DESC LIMIT 50`,[ownerKey]);
  return reply({signals:rows.rows});
 }
 const body=await req.json().catch(()=>({}));
 let signal;
 try{signal=validateScoutSignal(body);}catch(error){return reply({error:String(error.message||error)},400);}
 const recent=await db.query("SELECT COUNT(*)::int AS total FROM ash_user_scout_signals WHERE owner_key=$1 AND created_at>now()-interval '24 hours'",[ownerKey]);
 if(Number(recent.rows[0]?.total||0)>=30)return reply({error:"daily_scout_limit_reached",limit:30},429);
 let fixtures;
 if(body.match_id){
  fixtures=await db.query("SELECT id,sport,competition,home_or_player_one AS home,away_or_player_two AS away,starts_at FROM sports_matches WHERE id=$1 AND sport=$2 AND starts_at>now()-interval '12 hours' AND starts_at<now()+interval '14 days' AND status NOT IN ('completed','cancelled','postponed')",[String(body.match_id),signal.sport]);
 }else{
  fixtures=await db.query("SELECT id,sport,competition,home_or_player_one AS home,away_or_player_two AS away,starts_at FROM sports_matches WHERE sport=$1 AND starts_at>now()-interval '12 hours' AND starts_at<now()+interval '14 days' AND status NOT IN ('completed','cancelled','postponed') AND (LOWER(home_or_player_one) LIKE LOWER($2) OR LOWER(away_or_player_two) LIKE LOWER($2)) ORDER BY starts_at ASC LIMIT 10",[signal.sport,"%"+signal.team+"%"]);
 }
 const targets=fixtures.rows.length?fixtures.rows:[null],saved=[];
 for(const fixture of targets){
  const result=await db.query("INSERT INTO ash_user_scout_signals(match_id,sport,team,normalized_team,opinion,reason,owner_key) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id,match_id,sport,team,opinion,reason,created_at",
   [fixture?.id||null,signal.sport,signal.team,signal.normalizedTeam,signal.opinion,signal.reason,ownerKey]);
  saved.push(result.rows[0]);
  if(fixture){
   await ensureFixtureResearchTables(db);
   await db.query("INSERT INTO ash_fixture_research_queue(match_id,status,due_at) VALUES($1,'pending',now()) ON CONFLICT(match_id) DO UPDATE SET status='pending',due_at=now(),updated_at=now(),last_error=NULL",[fixture.id]);
  }
 }
 return reply({saved:saved.length,matchedFixtures:fixtures.rows,signals:saved,note:fixtures.rows.length?"Signal attached to upcoming fixture research. It informs searches but does not force a pick.":"Signal saved for this device. It will attach when an upcoming fixture is discovered."},201);
}
if(p==="/v1/public/odds/sports"&&req.method==="GET"){
const r=await db.query("SELECT id,competition,sport FROM sports_matches WHERE status='scheduled' AND starts_at>now()-interval '1 day' ORDER BY starts_at DESC LIMIT 500");
const seen=new Set(),data=[];
for(const row of r.rows){const key=String(row.id).split(":")[0];if(seen.has(key))continue;seen.add(key);data.push({key,title:row.competition,group:row.sport,active:true});}
return reply({data});
}
if(p==="/v1/public/odds/events"&&req.method==="GET"){
const matches=await db.query("SELECT id,sport,competition,home_or_player_one,away_or_player_two,starts_at,status,source_updated_at FROM sports_matches WHERE status='scheduled' AND starts_at>now()-interval '1 day' ORDER BY starts_at ASC LIMIT 400");
const ids=matches.rows.map(x=>x.id);
if(!ids.length)return reply({data:[],observedAt:new Date().toISOString()});
const odds=await db.query("SELECT DISTINCT ON (match_id,bookmaker_key,market_key,outcome_name,COALESCE(line,0)) match_id,bookmaker_key,market_key,outcome_name,decimal_odds,line,observed_at FROM bookmaker_odds WHERE match_id=ANY($1::text[]) ORDER BY match_id,bookmaker_key,market_key,outcome_name,COALESCE(line,0),observed_at DESC", [ids]);
const byMatch=new Map();
for(const row of odds.rows){
let event=byMatch.get(row.match_id);if(!event){event=new Map();byMatch.set(row.match_id,event);}
let book=event.get(row.bookmaker_key);if(!book){book={key:row.bookmaker_key,title:row.bookmaker_key,markets:new Map()};event.set(row.bookmaker_key,book);}
let market=book.markets.get(row.market_key);if(!market){market={key:row.market_key,outcomes:[]};book.markets.set(row.market_key,market);}
market.outcomes.push({name:row.outcome_name,price:Number(row.decimal_odds),...(row.line==null?{}:{point:Number(row.line)})});
}
const data=matches.rows.map(row=>{
const books=byMatch.get(row.id);
return {id:row.id,sport_key:String(row.id).split(":")[0],sport_title:row.competition,home_team:row.home_or_player_one,away_team:row.away_or_player_two,commence_time:row.starts_at,bookmakers:books?[...books.values()].map(b=>({key:b.key,title:b.title,markets:[...b.markets.values()]})):[]};
});
return reply({data,observedAt:new Date().toISOString()});
}

if(p==="/v1/public/results/tips"&&req.method==="GET"){
 await ensureTipResultsTables();
 const url=new URL(req.url),limit=Math.min(200,Math.max(1,Number(url.searchParams.get("limit")||50)));
 const rows=await db.query("SELECT tip_id,local_date,sport,competition,home_team,away_team,commence_time,selection,decimal_odds,bookmakers,status,home_score,away_score,profit_units,settled_at,result_source FROM ash_tip_results ORDER BY created_at DESC LIMIT $1",[limit]);
 return reply({tips:rows.rows});
}
if(p==="/v1/public/results/summary"&&req.method==="GET"){
 await ensureTipResultsTables();
 const totals=await db.query("SELECT COUNT(*) FILTER(WHERE status='won')::int AS won,COUNT(*) FILTER(WHERE status='lost')::int AS lost,COUNT(*) FILTER(WHERE status='void')::int AS void,COUNT(*) FILTER(WHERE status='pending')::int AS pending,COUNT(*) FILTER(WHERE status='unverified')::int AS unverified,COALESCE(SUM(profit_units) FILTER(WHERE status IN ('won','lost')),0)::float8 AS profit FROM ash_tip_results");
 const recent=await db.query("SELECT (settled_at AT TIME ZONE 'Africa/Kampala')::date AS local_date,COUNT(*) FILTER(WHERE status='won')::int AS won,COUNT(*) FILTER(WHERE status='lost')::int AS lost,COALESCE(SUM(profit_units) FILTER(WHERE status IN ('won','lost')),0)::float8 AS profit FROM ash_tip_results WHERE settled_at>=now()-interval '30 days' GROUP BY 1 ORDER BY 1 DESC");
 const r=totals.rows[0],settled=Number(r.won)+Number(r.lost);
 return reply({totals:{...r,settled,hit_rate_pct:settled?Number((Number(r.won)/settled*100).toFixed(1)):null,yield_pct:settled?Number((Number(r.profit)/settled*100).toFixed(1)):null},daily:recent.rows});
}

if(p==="/v1/public/predictions/metrics"&&req.method==="GET"){
 const models=await db.query(`SELECT model_version,
  COUNT(*) FILTER(WHERE status IN ('won','lost'))::int AS settled,
  COUNT(*) FILTER(WHERE status='won')::int AS won,
  COUNT(*) FILTER(WHERE status='lost')::int AS lost,
  ROUND(AVG(estimated_probability)::numeric,4) AS average_estimated_probability,
  ROUND(AVG(CASE WHEN status='won' THEN 1.0 ELSE 0.0 END)::numeric,4) AS observed_win_rate,
  ROUND(AVG(POWER(estimated_probability-CASE WHEN status='won' THEN 1.0 ELSE 0.0 END,2))::numeric,5) AS brier_score,
  ROUND(AVG(CASE WHEN status='won' THEN offered_odds-1 ELSE -1 END)::numeric,4) AS roi_per_unit
  FROM ash_predictions WHERE status IN ('won','lost') AND estimated_probability IS NOT NULL
  GROUP BY model_version ORDER BY model_version`);
 return reply({models:models.rows,minimum_sample_for_interpretation:100,note:"Small samples are noisy. Compare calibration and return over a large settled sample; no prediction is guaranteed."});
}
if(p==="/v1/public/research/summary"&&req.method==="GET"){const totals=await db.query("SELECT COUNT(*)::int AS fixtures,COUNT(*) FILTER(WHERE q.status='pending')::int AS pending,COUNT(*) FILTER(WHERE q.status='researching')::int AS researching,COUNT(*) FILTER(WHERE q.status='completed')::int AS completed,COUNT(*) FILTER(WHERE q.status='failed')::int AS failed FROM ash_fixture_research_queue q");const recent=await db.query("SELECT m.id,m.sport,m.competition,m.home_or_player_one AS home,m.away_or_player_two AS away,m.starts_at,r.researched_at,r.source_count,r.independent_domains,r.coverage,r.assessment FROM ash_fixture_research r JOIN sports_matches m ON m.id=r.match_id ORDER BY r.researched_at DESC LIMIT 30");return reply({totals:totals.rows[0],recent:recent.rows});}
if(p==="/v1/public/research/fixture"&&req.method==="GET"){const url=new URL(req.url),id=(url.searchParams.get("id")||"").trim();if(!id||id.length>180)return reply({error:"fixture_id_required"},400);const r=await db.query("SELECT m.id,m.sport,m.competition,m.home_or_player_one AS home,m.away_or_player_two AS away,m.starts_at,x.researched_at,x.source_count,x.independent_domains,x.sources,x.assessment,x.coverage FROM sports_matches m LEFT JOIN ash_fixture_research x ON x.match_id=m.id WHERE m.id=$1",[id]);return reply({fixture:r.rows[0]||null});}
if(p==="/v1/public/odds/daily"&&req.method==="GET"){
const daily=await db.query("SELECT local_date,status,picks_count,picks_json,message_text,sent_at,started_at FROM ash_daily_publications WHERE local_date=(now() AT TIME ZONE 'Africa/Kampala')::date LIMIT 1");
return reply({daily:daily.rows[0]||null});
}

if(p==="/v1/public/history/summary"&&req.method==="GET"){
const totals=await db.query("SELECT COUNT(*) AS results,COUNT(DISTINCT competition) AS competitions,MIN(starts_at) AS earliest,MAX(starts_at) AS latest FROM sports_matches WHERE source IN ('openfootball','openfootball_world') AND status='completed'");
const sources=await db.query("SELECT source,COUNT(*) AS results FROM sports_matches WHERE source IN ('openfootball','openfootball_world') AND status='completed' GROUP BY source ORDER BY source");
const leagues=await db.query("SELECT competition,COUNT(*) AS results,MIN(starts_at) AS earliest,MAX(starts_at) AS latest FROM sports_matches WHERE source IN ('openfootball','openfootball_world') AND status='completed' GROUP BY competition ORDER BY results DESC LIMIT 40");
return reply({totals:totals.rows[0],sources:sources.rows,competitions:leagues.rows});
}
if(p==="/v1/public/history/team"&&req.method==="GET"){
const url=new URL(req.url),team=(url.searchParams.get("team")||"").trim(),sport=(url.searchParams.get("sport")||"football").trim();
if(team.length<2||team.length>90||!["football","basketball","tennis"].includes(sport))return reply({error:"team_and_valid_sport_required"},400);
const rows=await db.query("SELECT competition,home_or_player_one AS home,away_or_player_two AS away,starts_at,home_score,away_score,CASE WHEN LOWER(home_or_player_one) LIKE LOWER($1) THEN home_or_player_one ELSE away_or_player_two END AS matched_team,CASE WHEN LOWER(home_or_player_one) LIKE LOWER($1) THEN CASE WHEN home_score>away_score THEN 'W' WHEN home_score<away_score THEN 'L' ELSE 'D' END ELSE CASE WHEN away_score>home_score THEN 'W' WHEN away_score<home_score THEN 'L' ELSE 'D' END END AS team_result FROM sports_matches WHERE source IN ('openfootball','openfootball_world') AND status='completed' AND sport=$2 AND (LOWER(home_or_player_one) LIKE LOWER($1) OR LOWER(away_or_player_two) LIKE LOWER($1)) ORDER BY starts_at DESC LIMIT 20",["%"+team+"%",sport]);
return reply({team,sport,matches:rows.rows});
}
if(p==="/v1/public/history/h2h"&&req.method==="GET"){
const url=new URL(req.url),a=(url.searchParams.get("team_a")||"").trim(),b=(url.searchParams.get("team_b")||"").trim();
if(a.length<2||a.length>90||b.length<2||b.length>90||a.toLowerCase()===b.toLowerCase())return reply({error:"two_distinct_teams_required"},400);
const rows=await db.query("SELECT competition,home_or_player_one AS home,away_or_player_two AS away,starts_at,home_score,away_score FROM sports_matches WHERE source IN ('openfootball','openfootball_world') AND status='completed' AND sport='football' AND ((LOWER(home_or_player_one) LIKE LOWER($1) AND LOWER(away_or_player_two) LIKE LOWER($2)) OR (LOWER(home_or_player_one) LIKE LOWER($2) AND LOWER(away_or_player_two) LIKE LOWER($1))) ORDER BY starts_at DESC LIMIT 20",["%"+a+"%","%"+b+"%"]);
return reply({team_a:a,team_b:b,meetings:rows.rows});
}
}catch(e){console.error("[ash-sports-public]",e);return reply({error:"public_feed_unavailable"},500);}
}
const auth=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(!appToken||auth.length!==appToken.length||!timingSafeEqual(Buffer.from(auth),Buffer.from(appToken)))return reply({error:"unauthorized"},401);
if(p==="/v1/scout/signals"&&req.method==="GET"){
 await db.query(`CREATE TABLE IF NOT EXISTS ash_user_scout_signals(
  id bigserial PRIMARY KEY,match_id text REFERENCES sports_matches(id) ON DELETE SET NULL,
  sport text NOT NULL,team text NOT NULL,normalized_team text NOT NULL,opinion text NOT NULL,
  reason text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
 )`);
 const rows=await db.query(`SELECT s.id,s.sport,s.team,s.opinion,s.reason,s.status,s.created_at,
  m.id AS fixture_id,m.competition,m.home_or_player_one AS home,m.away_or_player_two AS away,m.starts_at
  FROM ash_user_scout_signals s LEFT JOIN sports_matches m ON m.id=s.match_id
  ORDER BY s.created_at DESC LIMIT 50`);
 return reply({signals:rows.rows});
}
if(p==="/v1/scout/signals"&&req.method==="POST"){
 const body=await req.json().catch(()=>({}));
 let signal;
 try{signal=validateScoutSignal(body);}catch(error){return reply({error:String(error.message||error)},400);}
 await db.query(`CREATE TABLE IF NOT EXISTS ash_user_scout_signals(
  id bigserial PRIMARY KEY,match_id text REFERENCES sports_matches(id) ON DELETE SET NULL,
  sport text NOT NULL,team text NOT NULL,normalized_team text NOT NULL,opinion text NOT NULL,
  reason text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now()
 )`);
 await db.query("CREATE INDEX IF NOT EXISTS ash_user_scout_signals_match_idx ON ash_user_scout_signals(match_id,status,created_at DESC)");
 let fixtures;
 if(body.match_id){
  fixtures=await db.query("SELECT id,sport,competition,home_or_player_one AS home,away_or_player_two AS away,starts_at FROM sports_matches WHERE id=$1 AND sport=$2 AND starts_at>now()-interval '12 hours' AND starts_at<now()+interval '14 days' AND status NOT IN ('completed','cancelled','postponed')",[String(body.match_id),signal.sport]);
 }else{
  fixtures=await db.query("SELECT id,sport,competition,home_or_player_one AS home,away_or_player_two AS away,starts_at FROM sports_matches WHERE sport=$1 AND starts_at>now()-interval '12 hours' AND starts_at<now()+interval '14 days' AND status NOT IN ('completed','cancelled','postponed') AND (LOWER(home_or_player_one) LIKE LOWER($2) OR LOWER(away_or_player_two) LIKE LOWER($2)) ORDER BY starts_at ASC LIMIT 10",[signal.sport,"%"+signal.team+"%"]);
 }
 const targets=fixtures.rows.length?fixtures.rows:[null],saved=[];
 for(const fixture of targets){
  const result=await db.query("INSERT INTO ash_user_scout_signals(match_id,sport,team,normalized_team,opinion,reason) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,match_id,sport,team,opinion,reason,created_at",
   [fixture?.id||null,signal.sport,signal.team,signal.normalizedTeam,signal.opinion,signal.reason]);
  saved.push(result.rows[0]);
  if(fixture){
   await ensureFixtureResearchTables(db);
   await db.query("INSERT INTO ash_fixture_research_queue(match_id,status,due_at) VALUES($1,'pending',now()) ON CONFLICT(match_id) DO UPDATE SET status='pending',due_at=now(),updated_at=now(),last_error=NULL",[fixture.id]);
  }
 }
 return reply({saved:saved.length,matchedFixtures:fixtures.rows,signals:saved,note:fixtures.rows.length?"Signal attached to upcoming fixture research. It informs searches but does not force a pick.":"Signal saved for the team. It will attach when an upcoming fixture is discovered."},201);
}
if(p==="/v1/scraper/status"&&req.method==="GET")return reply(await getScraperStatus(db));
if(p==="/v1/scraper/sources"&&req.method==="POST"){
 const body=await req.json().catch(()=>({}));
 try{return reply({source:await addScraperSource(db,{bookmaker:body.bookmaker,url:body.url})},201);}
 catch(error){return reply({error:String(error.message||error).slice(0,220)},400);}
}
if(p==="/v1/scraper/run"&&req.method==="POST"){
 const body=await req.json().catch(()=>({}));
 const limit=Number(body.limit||8);
 if(!Number.isInteger(limit)||limit<1||limit>20)return reply({error:"limit_must_be_1_to_20"},400);
 return reply(await runBookmakerScrapersOnce({limit}));
}

try{
if(p==="/v1/odds/collect"&&req.method==="POST"){const b=await req.json().catch(()=>({}));const n=Number(b.maxSports||6);if(!Number.isInteger(n)||n<1||n>12)return reply({error:"maxSports must be 1 to 12"},400);return reply(await collectOdds(n));}
if(p==="/v1/odds/summary"&&req.method==="GET"){const r=await db.query("SELECT (SELECT COUNT(*) FROM sports_matches) AS matches,(SELECT COUNT(*) FROM bookmaker_odds) AS odds_snapshots,(SELECT COUNT(DISTINCT bookmaker_key) FROM bookmaker_odds) AS bookmakers,(SELECT MIN(observed_at) FROM bookmaker_odds) AS first_snapshot,(SELECT MAX(observed_at) FROM bookmaker_odds) AS latest_snapshot");const runs=await db.query("SELECT id,started_at,finished_at,status,fixtures_seen,odds_snapshots_saved,error_summary FROM daily_scout_runs ORDER BY started_at DESC LIMIT 10");return reply({totals:r.rows[0],recentRuns:r.rows});}
if(p==="/v1/providers/status"&&req.method==="GET"){const r=await db.query("SELECT provider,updated_at FROM provider_credentials");return reply({providers:["the_odds_api","openrouter","groq","telegram_bot"].map(x=>({provider:x,configured:(x==="the_odds_api"?!!process.env.THE_ODDS_API_KEY:x==="openrouter"?!!process.env.OPENROUTER_API_KEY:x==="groq"?!!process.env.GROQ_API_KEY:x==="telegram_bot"?!!(process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_CHAT_ID):false)||r.rows.some(y=>y.provider===x),updatedAt:r.rows.find(y=>y.provider===x)?.updated_at||null}))});}
const m=p.match(/^\/v1\/providers\/(the_odds_api|openrouter|groq)$/);if(m&&req.method==="POST"){const k=String((await req.json()).apiKey||"").trim();if(k.length<12||k.length>500)return reply({error:"invalid_api_key"},400);await save(m[1],k);try{return reply({saved:true,test:await test(m[1],k)});}catch(e){return reply({saved:true,test:{ok:false,error:String(e.message).slice(0,250)}});}}
if(p==="/v1/telegram/configure"&&req.method==="POST"){const b=await req.json(),botToken=String(b.botToken||process.env.TELEGRAM_BOT_TOKEN||"").trim(),chatId=String(b.chatId||process.env.TELEGRAM_CHAT_ID||"").trim();if(botToken.length<20||!chatId)return reply({error:"bot_token_and_chat_id_required"},400);await save("telegram_bot",{botToken,chatId});return reply({saved:true});}
if(p==="/v1/telegram/test"&&req.method==="POST")return reply(await telegram("Ash Sports: Telegram connection test successful."));
if(p==="/v1/telegram/send"&&req.method==="POST"){const msg=String((await req.json()).message||"").trim();if(!msg||msg.length>3900)return reply({error:"invalid_message"},400);return reply(await telegram(msg));}
if(p==="/v1/odds/sports"&&req.method==="GET"){const k=await read("the_odds_api");if(!k)return reply({error:"odds_api_not_configured"},409);const r=await fetch("https://api.the-odds-api.com/v4/sports?apiKey="+encodeURIComponent(k),{signal:AbortSignal.timeout(12000)}),t=await r.text();if(!r.ok)return reply({error:"odds_provider_error",detail:t.slice(0,250)},r.status);return new Response(t,{headers:{...cors,"cache-control":"no-store"}});}
if(p==="/v1/ai/test"&&req.method==="POST"){const x=(await req.json()).provider;if(!["openrouter","groq"].includes(x))return reply({error:"invalid_provider"},400);const k=await read(x);if(!k)return reply({error:"not_configured"},409);return reply(await test(x,k));}
return reply({error:"not_found"},404);
}catch(e){console.error("[ash-sports-api]",e);return reply({error:String(e.message||"failed").slice(0,300)},500);}}};