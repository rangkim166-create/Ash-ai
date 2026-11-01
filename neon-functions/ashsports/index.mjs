import postgres from "postgres";
import { formatDailyPicks, selectDailyPicks } from "./daily-picks.mjs";
import { parseFinalScore, settleHeadToHead } from "./results-tracker.mjs";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
const sql=postgres(process.env.DATABASE_URL,{max:5,idle_timeout:20,connect_timeout:10});
const db={query:async(text,values=[])=>{const rows=await sql.unsafe(text,values);return {rows,rowCount:rows.length};}};
const masterKey=Buffer.from(process.env.ASH_CREDENTIALS_KEY||"","base64");
const appToken=process.env.ASH_APP_TOKEN||"";
const cors={"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"authorization,content-type","content-type":"application/json"};
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

async function collectOdds(maxSports=8){
 const key=await read("the_odds_api");
 if(!key)throw Error("The Odds API is not configured");
 const sr=await fetch("https://api.the-odds-api.com/v4/sports?apiKey="+encodeURIComponent(key),{signal:AbortSignal.timeout(15000)});
 const st=await sr.text(); if(!sr.ok)throw Error("Odds sports list HTTP "+sr.status+": "+st.slice(0,160));
 const sports=JSON.parse(st).filter(s=>s.active&&/^(soccer_|basketball_|tennis_)/.test(s.key||"")&&!/(championship_winner|outright|winner$)/i.test(s.key||""));
 const priority=["saudi","egypt","morocco","qatar","uae","tunisia","algeria","soccer_epl","championship","bundesliga","la_liga","serie_a","ligue_one","basketball_nba","euroleague","tennis_atp","tennis_wta"];
 sports.sort((a,b)=>{const rank=x=>{const i=priority.findIndex(p=>x.key.includes(p));return i<0?99:i;};return rank(a)-rank(b);});
 const limit=Math.min(12,Math.max(1,maxSports));const arab=sports.filter(s=>["saudi","egypt","morocco","qatar","uae","tunisia","algeria"].some(x=>s.key.includes(x)));const football=sports.filter(s=>s.key.startsWith("soccer_")&&!arab.includes(s));const basketball=sports.filter(s=>s.key.startsWith("basketball_"));const tennis=sports.filter(s=>s.key.startsWith("tennis_"));const selected=[...arab.slice(0,2),...football.slice(0,1),...basketball.slice(0,2),...tennis.slice(0,1)];for(const s of sports){if(selected.length>=limit)break;if(!selected.includes(s))selected.push(s);}
 const last=await db.query("SELECT id,started_at,status FROM daily_scout_runs ORDER BY started_at DESC LIMIT 1");
 if(last.rowCount){
  const prior=last.rows[0];
  const age=Date.now()-new Date(prior.started_at).getTime();
  const cooldown=prior.status==="failed"?60*1000:prior.status==="partial"?5*60*1000:prior.status==="running"?5*60*1000:3*60*60*1000;
  if(Number.isFinite(age)&&age<cooldown)return{skipped:true,reason:"recent_scout_run",lastStatus:prior.status,lastStartedAt:prior.started_at};
  // A process can restart while a provider request is in flight. Recover stale
  // "running" rows after the maximum expected collection window so scouting resumes.
  if(prior.status==="running"&&Number.isFinite(age)&&age>=cooldown){
   await db.query("UPDATE daily_scout_runs SET status='failed',finished_at=now(),error_summary='Recovered stale run after process restart' WHERE id=$1 AND status='running'",[prior.id]);
  }
 }
 const run=await db.query("INSERT INTO daily_scout_runs(status) VALUES('running') RETURNING id");
 const runId=run.rows[0].id, observedAt=new Date().toISOString();
 let fixtures=0, saved=0; const errors=[], results=[];
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
    for(const b of(e.bookmakers||[]))for(const m of(b.markets||[]))for(const v of(m.outcomes||[])){
     const price=Number(v.price);if(!v.name||!Number.isFinite(price)||price<=1)continue;
     const point=v.point==null?null:Number(v.point);
     const inserted=await db.query("INSERT INTO bookmaker_odds(match_id,bookmaker_key,market_key,outcome_name,decimal_odds,line,observed_at,source) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz,'the_odds_api') ON CONFLICT DO NOTHING RETURNING id",
     [id,b.key||b.title||"unknown",m.key||"unknown",v.name,price,Number.isFinite(point)?point:null,observedAt]);
     saved+=inserted.rowCount;o+=inserted.rowCount;
    }
   }
   results.push({sport:sport.key,fixtures:n,odds:o});
  }catch(e){errors.push({sport:sport.key,error:String(e.message||e).slice(0,180)});results.push({sport:sport.key,error:String(e.message||e).slice(0,180)});}
 }
 const status=errors.length?(fixtures?"partial":"failed"):"success";
 await db.query("UPDATE daily_scout_runs SET finished_at=now(),status=$1,fixtures_seen=$2,odds_snapshots_saved=$3,error_summary=$4 WHERE id=$5",
 [status,fixtures,saved,errors.length?JSON.stringify(errors).slice(0,2500):null,runId]);
 return{runId,status,sportsAttempted:selected.length,fixturesSeen:fixtures,oddsSnapshotsSaved:saved,observedAt,results,errors};
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
 }
}
async function runTipResultsTracker(){
 await ensureTipResultsTables();
 const apiKey=await read("the_odds_api");
 if(!apiKey)return{checked:0,settled:0,reason:"odds_api_not_configured"};
 // Keep old unresolved tips visible as unverified; never turn missing data into a loss or void.
 await db.query("UPDATE ash_tip_results SET status='unverified',updated_at=now() WHERE status='pending' AND commence_time<now()-interval '4 days'");
 const pending=await db.query("SELECT * FROM ash_tip_results WHERE status='pending' AND commence_time<=now()+interval '15 minutes' AND commence_time>=now()-interval '4 days' ORDER BY commence_time ASC LIMIT 250");
 if(!pending.rowCount)return{checked:0,settled:0,reason:"no_due_tips"};
 const groups=new Map();
 for(const tip of pending.rows){if(!groups.has(tip.sport_key))groups.set(tip.sport_key,[]);groups.get(tip.sport_key).push(tip);}
 let checked=0,settled=0;const errors=[];
 for(const [sportKey,tips] of groups){
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
     settled++;
     const row=saved.rows[0];
     const message="ASH • PICK RESULT\\n"+row.home_team+" "+row.home_score+" - "+row.away_score+" "+row.away_team+
       "\\nPick: "+row.selection+" @ "+Number(row.decimal_odds).toFixed(2)+
       "\\nResult: "+outcome.toUpperCase()+"\\nP/L: "+(Number(row.profit_units)>0?"+":"")+Number(row.profit_units).toFixed(2)+" units"+
       "\\nFinal score source: The Odds API";
     try{
      await db.query("UPDATE ash_tip_results SET notification_status='sending',notification_updated_at=now() WHERE tip_id=$1 AND notification_status IN ('pending','failed')",[row.tip_id]);
      await telegram(message);
      await db.query("UPDATE ash_tip_results SET notification_status='sent',notification_updated_at=now() WHERE tip_id=$1",[row.tip_id]);
     }catch(error){
      await db.query("UPDATE ash_tip_results SET notification_status='failed',notification_updated_at=now() WHERE tip_id=$1",[row.tip_id]).catch(()=>{});
      console.error("[ash-results] Telegram result notification failed",row.tip_id,String(error?.message||error).slice(0,160));
     }
    }
   }catch(error){errors.push({sport:sportKey,error:String(error?.message||error).slice(0,180)});}
  }
 }
 const summary=await maybeSendDailyResultsSummary();
 return{checked,settled,errors,summary};
}
async function maybeSendDailyResultsSummary(){
 const localNow=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Kampala",hour:"2-digit",minute:"2-digit",hour12:false}).format(new Date());
 if(localNow<"23:00")return{sent:false,reason:"not_summary_time"};
 const localDay=new Intl.DateTimeFormat("en-CA",{timeZone:"Africa/Kampala",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
 const prior=await db.query("SELECT status FROM ash_tip_result_summaries WHERE local_date=$1::date",[localDay]);
 if(prior.rowCount&&prior.rows[0].status==="sent")return{sent:false,reason:"already_sent_today"};
 const stats=await db.query(`SELECT
  COUNT(*) FILTER(WHERE status='won')::int AS won,
  COUNT(*) FILTER(WHERE status='lost')::int AS lost,
  COUNT(*) FILTER(WHERE status='void')::int AS void,
  COUNT(*) FILTER(WHERE status IN ('pending','unverified'))::int AS pending,
  COALESCE(SUM(profit_units) FILTER(WHERE status IN ('won','lost')),0)::float8 AS profit
  FROM ash_tip_results WHERE (settled_at AT TIME ZONE 'Africa/Kampala')::date=$1::date`,[localDay]);
 const row=stats.rows[0],settled=Number(row.won)+Number(row.lost);
 const hitRate=settled?((Number(row.won)/settled)*100).toFixed(1):"n/a";
 const profit=Number(row.profit||0);
 const message="ASH • DAILY RESULTS — "+localDay+
  "\\nWon: "+row.won+" | Lost: "+row.lost+" | Void: "+row.void+
  "\\nStill pending/unverified: "+row.pending+
  "\\nHit rate: "+hitRate+"%"+
  "\\nNet: "+(profit>0?"+":"")+profit.toFixed(2)+" units"+
  "\\nOne unit stake per pick; results only where final scores were verified.";
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
 const prior=await db.query("SELECT status,started_at FROM ash_daily_publications WHERE local_date=$1::date",[localDay]);
 if(prior.rowCount&&prior.rows[0].status==="sent")return{sent:false,skipped:true,reason:"already_sent_today",localDate:localDay};
 if(prior.rowCount&&prior.rows[0].status==="sending"&&Date.now()-new Date(prior.rows[0].started_at).getTime()<20*60*1000)return{sent:false,skipped:true,reason:"publish_already_running",localDate:localDay};
 await db.query("INSERT INTO ash_daily_publications(local_date,status,attempts,started_at) VALUES($1::date,'sending',1,now()) ON CONFLICT(local_date) DO UPDATE SET status='sending',attempts=ash_daily_publications.attempts+1,started_at=now(),error_summary=NULL",[localDay]);
 try{
  let collection=null;
  try{collection=await collectOdds(6);}catch(error){console.error("[ash-daily] odds refresh failed",String(error?.message||error).slice(0,180));}
  const fixturesResult=await db.query("SELECT id,sport,competition,home_or_player_one AS home,away_or_player_two AS away,starts_at FROM sports_matches WHERE status='scheduled' AND source='the_odds_api' AND starts_at>now() AND starts_at<=now()+interval '36 hours' ORDER BY starts_at ASC LIMIT 250");
  const fixtures=fixturesResult.rows;
  if(!fixtures.length){
   await db.query("UPDATE ash_daily_publications SET status='waiting_for_odds',picks_count=0,message_preview=NULL,message_text=NULL,picks_json='[]'::jsonb,error_summary=$2 WHERE local_date=$1::date",[localDay,"No upcoming bookmaker fixtures are available yet."]);
   return{sent:false,reason:"no_upcoming_fixtures",collection,localDate:localDay};
  }
  const ids=fixtures.map(row=>row.id);
  const oddsResult=await db.query("SELECT DISTINCT ON(match_id,bookmaker_key,market_key,outcome_name) match_id,bookmaker_key,market_key,outcome_name,decimal_odds,observed_at FROM bookmaker_odds WHERE match_id=ANY($1::text[]) AND market_key='h2h' AND observed_at>now()-interval '6 hours' ORDER BY match_id,bookmaker_key,market_key,outcome_name,observed_at DESC",[ids]);
  if(!oddsResult.rows.length){
   await db.query("UPDATE ash_daily_publications SET status='waiting_for_odds',picks_count=0,message_preview=NULL,message_text=NULL,picks_json='[]'::jsonb,error_summary=$2 WHERE local_date=$1::date",[localDay,"No fresh head-to-head bookmaker prices are available."]);
   return{sent:false,reason:"no_fresh_bookmaker_odds",collection,localDate:localDay};
  }
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
  const dayLabel=new Intl.DateTimeFormat("en-GB",{timeZone:"Africa/Kampala",day:"2-digit",month:"short",year:"numeric"}).format(new Date());
  const message=formatDailyPicks(dayLabel,picks);
  // Persist the complete ticket and structured selections even before Telegram is configured.
  await db.query("UPDATE ash_daily_publications SET picks_count=$2,message_preview=$3,message_text=$4,picks_json=$5::jsonb WHERE local_date=$1::date",[localDay,picks.length,message.slice(0,500),message,JSON.stringify(picks)]);
  await savePublishedTips(localDay,picks);
  const bot=await read("telegram_bot");
  if(!bot?.botToken||!bot?.chatId){
   await db.query("UPDATE ash_daily_publications SET status='waiting_for_telegram_config',error_summary=$2 WHERE local_date=$1::date",[localDay,"Telegram bot token and chat ID are not configured."]);
   return{sent:false,reason:"telegram_not_configured",picks:picks.length,localDate:localDay};
  }
  const delivery=await telegram(message);
  await db.query("UPDATE ash_daily_publications SET status='sent',error_summary=NULL,sent_at=now() WHERE local_date=$1::date",[localDay]);
  return{sent:true,picks:picks.length,localDate:localDay,delivery,collection};
 }catch(error){
  const detail=String(error?.message||error).slice(0,300);
  await db.query("UPDATE ash_daily_publications SET status='failed',error_summary=$2 WHERE local_date=$1::date",[localDay,detail]).catch(()=>{});
  throw error;
 }
}

export default {async runScheduledCollection(){return await collectOdds(6);},async runHistoricalRatingsImport(){return await importHistoricalRatings();},async runScheduledDailyPublisher(){return await runScheduledDailyPublisher();},async runTipResultsTracker(){return await runTipResultsTracker();},async fetch(req){if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});const p=new URL(req.url).pathname;if(p==="/health"&&req.method==="GET"){try{await db.query("SELECT 1");return reply({ok:true,service:"ash-sports-api",database:"connected"});}catch{return reply({ok:false,error:"database_unavailable"},503);}}
if(p.startsWith("/v1/public/")){
try{
if(p==="/v1/public/odds/sports"&&req.method==="GET"){
const r=await db.query("SELECT id,competition,sport FROM sports_matches WHERE starts_at>now()-interval '1 day' ORDER BY starts_at DESC LIMIT 500");
const seen=new Set(),data=[];
for(const row of r.rows){const key=String(row.id).split(":")[0];if(seen.has(key))continue;seen.add(key);data.push({key,title:row.competition,group:row.sport,active:true});}
return reply({data});
}
if(p==="/v1/public/odds/events"&&req.method==="GET"){
const matches=await db.query("SELECT id,sport,competition,home_or_player_one,away_or_player_two,starts_at,status,source_updated_at FROM sports_matches WHERE starts_at>now()-interval '1 day' ORDER BY starts_at ASC LIMIT 400");
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