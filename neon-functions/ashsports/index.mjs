import postgres from "postgres";
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
const sql=postgres(process.env.DATABASE_URL,{max:5,idle_timeout:20,connect_timeout:10});
const db={query:async(text,values=[])=>{const rows=await sql.unsafe(text,values);return {rows,rowCount:rows.length};}};
const masterKey=Buffer.from(process.env.ASH_CREDENTIALS_KEY||"","base64");
const appToken=process.env.ASH_APP_TOKEN||"";
const cors={"access-control-allow-origin":"*","access-control-allow-methods":"GET,POST,OPTIONS","access-control-allow-headers":"authorization,content-type","content-type":"application/json"};
const reply=(v,s=200)=>new Response(JSON.stringify(v),{status:s,headers:cors});
function encrypt(v){if(masterKey.length!==32)throw Error("ASH_CREDENTIALS_KEY must be base64 for 32 random bytes");const iv=randomBytes(12),c=createCipheriv("aes-256-gcm",masterKey,iv),d=Buffer.concat([c.update(JSON.stringify(v),"utf8"),c.final()]);return{encrypted_value:d.toString("base64"),iv:iv.toString("base64"),auth_tag:c.getAuthTag().toString("base64")};}
function decrypt(r){const d=createDecipheriv("aes-256-gcm",masterKey,Buffer.from(r.iv,"base64"));d.setAuthTag(Buffer.from(r.auth_tag,"base64"));return JSON.parse(Buffer.concat([d.update(Buffer.from(r.encrypted_value,"base64")),d.final()]).toString("utf8"));}
async function save(p,v){const e=encrypt(v);await db.query("INSERT INTO provider_credentials(provider,encrypted_value,iv,auth_tag) VALUES($1,$2,$3,$4) ON CONFLICT(provider) DO UPDATE SET encrypted_value=EXCLUDED.encrypted_value,iv=EXCLUDED.iv,auth_tag=EXCLUDED.auth_tag,updated_at=now()",[p,e.encrypted_value,e.iv,e.auth_tag]);}
async function read(p){const env={the_odds_api:process.env.THE_ODDS_API_KEY,openrouter:process.env.OPENROUTER_API_KEY,groq:process.env.GROQ_API_KEY};if(p==="telegram_bot"&&(process.env.TELEGRAM_BOT_TOKEN||process.env.TELEGRAM_CHAT_ID))return{botToken:process.env.TELEGRAM_BOT_TOKEN||"",chatId:process.env.TELEGRAM_CHAT_ID||""};if(env[p])return env[p];const r=await db.query("SELECT encrypted_value,iv,auth_tag FROM provider_credentials WHERE provider=$1",[p]);return r.rowCount?decrypt(r.rows[0]):null;}
async function test(p,k){let u,h={};if(p==="the_odds_api")u="https://api.the-odds-api.com/v4/sports?apiKey="+encodeURIComponent(k);else if(p==="openrouter"){u="https://openrouter.ai/api/v1/models";h.authorization="Bearer "+k;}else{u="https://api.groq.com/openai/v1/models";h.authorization="Bearer "+k;}const r=await fetch(u,{headers:h,signal:AbortSignal.timeout(12000)}),t=await r.text();if(!r.ok)throw Error("HTTP "+r.status+": "+t.slice(0,180));let j={};try{j=JSON.parse(t)}catch{}return{ok:true,available:Array.isArray(j)?j.length:(j.data?.length||0)};}
async function telegram(message){const c=await read("telegram_bot");if(!c?.botToken||!c?.chatId)throw Error("Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Render environment variables; Telegram requires both to send messages");const r=await fetch("https://api.telegram.org/bot"+c.botToken+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:c.chatId,text:message,disable_web_page_preview:true}),signal:AbortSignal.timeout(15000)}),j=await r.json();if(!r.ok||!j.ok)throw Error(j.description||"Telegram failed");await db.query("INSERT INTO telegram_delivery_log(chat_id,message_preview,status,provider_message_id,sent_at) VALUES($1,$2,'sent',$3,now())",[c.chatId,message.slice(0,240),String(j.result?.message_id||"")]);return{sent:true,messageId:j.result?.message_id};}

async function collectOdds(maxSports=8){
 const key=await read("the_odds_api");
 if(!key)throw Error("The Odds API is not configured");
 const sr=await fetch("https://api.the-odds-api.com/v4/sports?apiKey="+encodeURIComponent(key),{signal:AbortSignal.timeout(15000)});
 const st=await sr.text(); if(!sr.ok)throw Error("Odds sports list HTTP "+sr.status+": "+st.slice(0,160));
 const sports=JSON.parse(st).filter(s=>s.active&&/^(soccer_|basketball_|tennis_)/.test(s.key||""));
 const priority=["saudi","egypt","morocco","qatar","uae","tunisia","algeria","soccer_epl","championship","bundesliga","la_liga","serie_a","ligue_one","basketball_nba","euroleague","tennis_atp","tennis_wta"];
 sports.sort((a,b)=>{const rank=x=>{const i=priority.findIndex(p=>x.key.includes(p));return i<0?99:i;};return rank(a)-rank(b);});
 const selected=sports.slice(0,Math.min(12,Math.max(1,maxSports)));
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

export default {async fetch(req){if(req.method==="OPTIONS")return new Response(null,{status:204,headers:cors});const p=new URL(req.url).pathname;if(p==="/health"&&req.method==="GET"){try{await db.query("SELECT 1");return reply({ok:true,service:"ash-sports-api",database:"connected"});}catch{return reply({ok:false,error:"database_unavailable"},503);}}
const auth=(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");if(!appToken||auth.length!==appToken.length||!timingSafeEqual(Buffer.from(auth),Buffer.from(appToken)))return reply({error:"unauthorized"},401);
try{
if(p==="/v1/odds/collect"&&req.method==="POST"){const b=await req.json().catch(()=>({}));const n=Number(b.maxSports||8);if(!Number.isInteger(n)||n<1||n>12)return reply({error:"maxSports must be 1 to 12"},400);return reply(await collectOdds(n));}
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