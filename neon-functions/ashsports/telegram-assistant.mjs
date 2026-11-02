import { createHash } from "node:crypto";
const TG="https://api.telegram.org";
const timeout=(ms)=>AbortSignal.timeout(ms);
const clean=(s,n=1200)=>String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g," ").trim().slice(0,n);
async function searchWeb(q){
 const results=[],seen=new Set(),now=Date.now();
 const queries=[q,q+" latest team news injuries suspensions predicted lineup",q+" recent form last matches results",q+" bookmaker odds odds comparison"];
 const add=(item)=>{if(item?.title&&item?.url&&/^https?:/.test(item.url)&&!seen.has(item.url)){seen.add(item.url);results.push(item);}};
 await Promise.all(queries.map(async(query)=>{try{
  const rss="https://news.google.com/rss/search?q="+encodeURIComponent(query)+"&hl=en-US&gl=US&ceid=US:en";
  const r=await fetch(rss,{signal:timeout(12000)});if(!r.ok)return;const x=await r.text();
  for(const m of x.matchAll(/<item>([\\s\\S]*?)<\\/item>/gi)){const b=m[1],title=clean((b.match(/<title>([\\s\\S]*?)<\\/title>/i)||[])[1],240),link=(b.match(/<link>([\\s\\S]*?)<\\/link>/i)||[])[1]?.trim(),raw=(b.match(/<pubDate>([\\s\\S]*?)<\\/pubDate>/i)||[])[1],date=clean(raw,80),published=raw?Date.parse(raw):NaN;
   if(title&&link)add({title,url:link,date,publishedAt:Number.isFinite(published)?new Date(published).toISOString():null,ageHours:Number.isFinite(published)?Math.round((now-published)/3600000):null,source:"Google News"});
   if(results.length>=24)break;
  }
 }catch{}}));
 await Promise.all(queries.slice(0,3).map(async(query)=>{try{
  const r=await fetch("https://html.duckduckgo.com/html/?q="+encodeURIComponent(query),{headers:{"user-agent":"Mozilla/5.0 AshSportsResearch/2.0"},signal:timeout(12000)});if(!r.ok)return;const h=await r.text();
  for(const m of h.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/gi)){let u=m[1];if(u.includes("uddg=")){try{u=decodeURIComponent(new URL(u,"https://duckduckgo.com").searchParams.get("uddg")||u)}catch{}}add({title:clean(m[2],200),url:u,source:"Web search"});if(results.length>=30)break;}
 }catch{}}));
 const ranked=results.sort((a,b)=>(a.ageHours??999999)-(b.ageHours??999999)).slice(0,12);
 const pages=[];
 for(const item of ranked.slice(0,9)){try{const r=await fetch(item.url,{headers:{"user-agent":"Mozilla/5.0 AshSportsResearch/2.0"},signal:timeout(9000),redirect:"follow"});if(!r.ok)continue;const type=r.headers.get("content-type")||"";if(!type.includes("text/html")&&!type.includes("text/plain"))continue;const body=clean(await r.text(),2600);if(body.length>180)pages.push({...item,excerpt:body.slice(0,1900)});}catch{}}
 return {items:ranked,pages,retrievedAt:new Date().toISOString()};
}
async function fetchLiveOdds(prompt){
 const key=await (async()=>{try{return await globalThis.__ashOddsKey?.()}catch{return null}})();
 if(!key)return {status:"not_configured",events:[]};
 try{
  const sr=await fetch("https://api.the-odds-api.com/v4/sports?apiKey="+encodeURIComponent(key),{signal:timeout(12000)});
  if(!sr.ok)return {status:"sports_catalog_http_"+sr.status,events:[]};
  const sports=await sr.json(),words=(prompt.toLowerCase().match(/[a-z0-9]+/g)||[]).filter(x=>x.length>2);
  const candidates=sports.filter(s=>s.active&&words.some(w=>(s.title+" "+s.key).toLowerCase().includes(w)||w.includes((s.key||"").toLowerCase().replace(/_/g," "))));
  const category=/\\b(nba|basketball|wnba|ncaa)\\b/i.test(prompt)?"basketball":/\\b(tennis|atp|wta|grand slam)\\b/i.test(prompt)?"tennis":/\\b(football|soccer|premier league|epl|la liga|bundesliga|serie a|champions league|afcon)\\b/i.test(prompt)?"soccer":"soccer";const pool=sports.filter(s=>s.active&&(s.key||"").toLowerCase().includes(category));const selected=(candidates.length?candidates:pool).slice(0,3);
  const events=[];
  for(const sport of selected){try{
   const u="https://api.the-odds-api.com/v4/sports/"+encodeURIComponent(sport.key)+"/odds?regions=uk,eu,us&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso&apiKey="+encodeURIComponent(key);
   const r=await fetch(u,{signal:timeout(15000)});if(!r.ok)continue;const data=await r.json();
   for(const e of data){const text=(e.home_team+" "+e.away_team).toLowerCase();if(words.some(w=>text.includes(w))||words.length<2)events.push({sport:sport.title,home:e.home_team,away:e.away_team,commence_time:e.commence_time,bookmakers:(e.bookmakers||[]).slice(0,8).map(b=>({name:b.title,updated:b.last_update,markets:b.markets}))});}
  }catch{}}
  return {status:"ok",retrievedAt:new Date().toISOString(),events:events.slice(0,8)};
 }catch(e){return {status:"error",message:String(e.message||e).slice(0,140),events:[]};}
}
export function createTelegramAssistant({db,read,telegram}){
 let connectedLogged=false;
 async function send(chatId,text){const bot=await read("telegram_bot");for(let i=0;i<text.length;i+=3900){const part=text.slice(i,i+3900);const r=await fetch(TG+"/bot"+bot.botToken+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text:part,disable_web_page_preview:true}),signal:timeout(12000)});const j=await r.json();if(!r.ok||!j.ok)throw Error("Telegram send failed: "+(j.description||r.status));}}
 async function ai(messages,provider,key){
  const base=provider==="groq"?"https://api.groq.com/openai/v1/chat/completions":"https://openrouter.ai/api/v1/chat/completions";
  const models=provider==="groq"?[...new Set([process.env.ASH_GROQ_MODEL||"openai/gpt-oss-120b","openai/gpt-oss-120b","openai/gpt-oss-20b"])]:[process.env.ASH_OPENROUTER_MODEL||"openai/gpt-4o-mini"];
  const errors=[];
  for(const model of models){
   const r=await fetch(base,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key,"HTTP-Referer":"https://ash-sports-api.onrender.com","X-Title":"Ash Jarvis Sports"},body:JSON.stringify({model,messages,temperature:0.35,max_tokens:1100}),signal:timeout(45000)});
   const j=await r.json();
   if(r.ok)return j.choices?.[0]?.message?.content||"";
   const detail=JSON.stringify(j).slice(0,180);
   errors.push(model+" HTTP "+r.status+" "+detail);
   if(provider!=="groq"||!(r.status===404||j?.error?.code==="model_not_found"))break;
  }
  throw Error(errors.join(" | "));
 }
 async function answer(chatId,text){
  const bot=await read("telegram_bot");if(!bot?.botToken||!bot?.chatId)throw Error("Telegram bot is not configured");
  if(String(chatId)!==String(bot.chatId))return;
  if(/^\/start|^\/help/i.test(text)){await send(chatId,"Yo, I'm Ash Jarvis — your sports research partner. 🧠\n\nAsk me about any match, sport, league, odds, tactics or betting idea. Example: Analyse Arsenal vs Chelsea, including injuries and value.\n\nCommands: /clear clears chat memory · /help shows this guide.\n\nI'll search current public sources when relevant, compare evidence, and tell you when information is missing. No guaranteed wins.");return;}
  if(/^\/clear/i.test(text)){await db.query("DELETE FROM ash_telegram_memory WHERE chat_id=$1",[String(chatId)]);await send(chatId,"Chat memory cleared. What are we researching?");return;}
  const prompt=text.replace(/^\/\w+\s*/,"").trim();if(!prompt)return;
  await db.query("CREATE TABLE IF NOT EXISTS ash_telegram_memory(chat_id text NOT NULL,role text NOT NULL,content text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())");
  const history=await db.query("SELECT role,content FROM ash_telegram_memory WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 12",[String(chatId)]);
  let research={items:[],pages:[],retrievedAt:null};let needsResearch=/(analyse|analy[sz]e|predict|prediction|odds|injur|lineup|line-up|form|fixture|match|game|today|tomorrow|league|team|player|bet|pick|score|who wins|longs|over|under)/i.test(prompt);
  if(needsResearch){globalThis.__ashOddsKey=async()=>await read("the_odds_api");await fetch(TG+"/bot"+bot.botToken+"/sendChatAction",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,action:"typing"}),signal:timeout(5000)}).catch(()=>{});research=await searchWeb(prompt);research.liveOdds=await fetchLiveOdds(prompt);}
  let databaseResearch="";
  if(needsResearch){
   try{
    const stop=new Set(["analyse","analyze","predict","prediction","odds","injury","injuries","lineup","lineups","form","fixture","fixtures","match","matches","game","today","tomorrow","league","team","player","players","bet","bets","pick","picks","score","scores","who","wins","winner","long","longs","over","under","please","what","about","with","from","against","including","value","best","compare","research","sports","football","basketball","tennis"]);
    const terms=[...new Set((prompt.match(/[A-Za-z][A-Za-z0-9.'-]{2,}/g)||[]).map(x=>x.replace(/[.'-]/g,"").toLowerCase()).filter(x=>x.length>=3&&!stop.has(x)))].slice(0,8);
    if(terms.length){
     const patterns=terms.map(x=>"%"+x+"%");
     const matches=await db.query("SELECT id,sport,competition,home_or_player_one,away_or_player_two,starts_at,status FROM sports_matches WHERE starts_at BETWEEN now()-interval '12 hours' AND now()+interval '14 days' AND (home_or_player_one ILIKE ANY($1::text[]) OR away_or_player_two ILIKE ANY($1::text[])) ORDER BY starts_at ASC LIMIT 12",[patterns]);
     if(matches.rows.length){
      const ids=matches.rows.map(x=>x.id);
      const prices=await db.query("SELECT match_id,bookmaker_key,market_key,outcome_name,decimal_odds,line,observed_at FROM bookmaker_odds WHERE match_id=ANY($1::text[]) AND observed_at>now()-interval '36 hours' ORDER BY match_id,observed_at DESC LIMIT 180",[ids]);
      const lines=matches.rows.map(m=>{
       const p=prices.rows.filter(x=>x.match_id===m.id).slice(0,24).map(x=>x.bookmaker_key+" "+x.market_key+" "+x.outcome_name+(x.line==null?"":" "+x.line)+" @ "+x.decimal_odds+" (seen "+new Date(x.observed_at).toISOString()+")");
       return m.sport+" | "+m.competition+" | "+m.home_or_player_one+" vs "+m.away_or_player_two+" | "+new Date(m.starts_at).toISOString()+" | "+m.status+(p.length?"\\n  bookmaker prices: "+p.join("; "):"\\n  no fresh bookmaker prices stored");
      });
      databaseResearch="Stored fixture and bookmaker research (prices are historical snapshots, not guaranteed live):\\n"+lines.join("\\n");
     }
    }
   }catch(e){console.error("[ash-telegram-db-research]",String(e.message||e));}
  }
  const system="You are Ash Jarvis, a live sports research analyst and thoughtful conversational partner. For every time-sensitive match question, use the supplied current web research and live odds API results, not memory. Explicitly state the research retrieval timestamp and the publication/update dates of key sources. Prefer information from the last 24 hours for team news, last 7 days for form/context, and official club/league sources for injuries and suspensions. Verify important claims against two independent sources when possible. Separate confirmed facts, reported/expected information, and your own inference. Never call predicted lineups confirmed. Never present database snapshots as live odds. Only quote bookmaker prices from the live odds API data and identify bookmaker plus retrieval time. If the odds API returned no matching events, say current bookmaker prices could not be verified. If sources are stale, conflicting, or unavailable, flag that clearly and downgrade confidence. If a match date is ambiguous or already played, clarify/check fixture date before forecasting. Handle ANY sport, league, match, athlete, tactics, statistics or sports question. Ask one concise clarification only when essential. For match analysis, structure: quick verdict; evidence (recent form, home/away, head-to-head only when meaningful, injuries/suspensions/lineups, schedule/rest, surface/weather if relevant); bookmaker consensus and price/value if supplied; risks and what could change the view; confidence as a calibrated qualitative estimate, never certainty. Distinguish verified facts, reports and inference. Never invent odds, injuries, lineups, sources or statistics. Current web research and, where available, direct live bookmaker API data are supplied below; cite source titles and URLs in plain text. Treat timestamps as essential. If sources disagree or are stale, say so. If live info is unavailable, disclose it. Do not force a bet; explain no-bet when edge is unclear. Betting is risky; encourage small fixed stakes and never chase losses. Do not claim a pick is guaranteed. Be willing to challenge the user's assumptions respectfully. Answer non-betting sports questions too. Keep replies readable and under 3500 characters.";
  const context=research.pages.map((p,i)=>"["+ (i+1)+"] "+p.title+" ("+(p.date||"date unavailable")+") "+" "+p.url+"\n"+p.excerpt).join("\n\n").slice(0,9500)+"\\n\\nLIVE ODDS API DATA (retrieved "+(research.liveOdds?.retrievedAt||"not retrieved")+"): "+JSON.stringify(research.liveOdds||{status:"not_checked"}).slice(0,6500)+"\\nResearch retrieved at: "+(research.retrievedAt||"unknown");
  const messages=[{role:"system",content:system+"\n\nWEB RESEARCH:\n"+(context||"No usable current web pages retrieved. Do not pretend web research was successful.")},...history.rows.reverse().map(x=>({role:x.role,content:x.content})),{role:"user",content:prompt}];
  let response="",errors=[];
  for(const provider of ["groq","openrouter"]){try{const key=await read(provider);if(!key)continue;response=await ai(messages,provider,key);if(response)break;}catch(e){errors.push(String(e.message||e));}}
  if(!response)response="I'm unable to reach my AI providers right now. "+(errors.join(" | ").slice(0,400)||"Check Groq/OpenRouter credentials in the Ash backend.");
  await db.query("INSERT INTO ash_telegram_memory(chat_id,role,content) VALUES($1,'user',$2),($1,'assistant',$3)",[String(chatId),prompt,response]);
  await db.query("DELETE FROM ash_telegram_memory WHERE chat_id=$1 AND created_at < now()-interval '14 days'",[String(chatId)]);
  await send(chatId,response);
 }
 function secretToken(bot){return createHash("sha256").update(bot.botToken+"|ash-telegram-webhook-v1").digest("hex");}
 async function configureWebhook(){
  const bot=await read("telegram_bot");if(!bot?.botToken||!bot?.chatId){console.error("[ash-telegram] webhook not configured: missing bot credentials");return false;}
  const r=await fetch(TG+"/bot"+bot.botToken+"/setWebhook",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({url:"https://ash-sports-api.onrender.com/v1/telegram/webhook",secret_token:secretToken(bot),allowed_updates:["message"],drop_pending_updates:false}),signal:timeout(12000)});
  const j=await r.json();if(!r.ok||!j.ok)throw Error(j.description||"Telegram setWebhook failed");
  if(!connectedLogged){const groq=!!(await read("groq")),openrouter=!!(await read("openrouter"));console.log("[ash-telegram] webhook connected; AI credentials:",JSON.stringify({groq,openrouter}));connectedLogged=true;}
  return true;
 }
 async function handleUpdate(update){
  const message=update?.message;if(!message?.text||!message?.chat?.id)return;
  await db.query("CREATE TABLE IF NOT EXISTS ash_telegram_updates(update_id bigint PRIMARY KEY,received_at timestamptz NOT NULL DEFAULT now())");
  const inserted=await db.query("INSERT INTO ash_telegram_updates(update_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING update_id",[String(update.update_id)]);
  if(!inserted.rowCount)return;
  try{await answer(message.chat.id,message.text);}catch(e){console.error("[ash-telegram-ai]",String(e.message||e));if(String(message.chat.id)===String((await read("telegram_bot"))?.chatId))await send(message.chat.id,"I hit a temporary issue: "+String(e.message||e).slice(0,250)).catch(()=>{});}
 }
 async function verifySecret(candidate){const bot=await read("telegram_bot");return !!bot?.botToken&&candidate===secretToken(bot);}
 return {configureWebhook,handleUpdate,verifySecret};
}
