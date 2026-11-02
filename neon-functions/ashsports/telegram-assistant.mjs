import { createHash } from "node:crypto";
const TG="https://api.telegram.org";
const timeout=(ms)=>AbortSignal.timeout(ms);
const clean=(s,n=1200)=>String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g," ").trim().slice(0,n);
async function searchWeb(q){
 const results=[];
 const rss="https://news.google.com/rss/search?q="+encodeURIComponent(q+" sports team match injury lineup form")+"&hl=en-US&gl=US&ceid=US:en";
 try{const r=await fetch(rss,{signal:timeout(10000)});if(r.ok){const x=await r.text();for(const m of x.matchAll(/<item>([\s\S]*?)<\/item>/gi)){const b=m[1],title=clean((b.match(/<title>([\s\S]*?)<\/title>/i)||[])[1],240),link=(b.match(/<link>([\s\S]*?)<\/link>/i)||[])[1]?.trim(),date=clean((b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)||[])[1],80);if(title&&link)results.push({title,url:link,date,source:"Google News"});if(results.length>=6)break;}}}catch{}
 try{const r=await fetch("https://html.duckduckgo.com/html/?q="+encodeURIComponent(q+" sports injuries team news"),{headers:{"user-agent":"Mozilla/5.0 AshSportsResearch/1.0"},signal:timeout(10000)});if(r.ok){const h=await r.text();for(const m of h.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)){let u=m[1];if(u.includes("uddg=")){try{u=decodeURIComponent(new URL(u,"https://duckduckgo.com").searchParams.get("uddg")||u)}catch{}}const title=clean(m[2],200);if(title&&/^https?:/.test(u)&&!results.some(x=>x.url===u))results.push({title,url:u,source:"Web search"});if(results.length>=10)break;}}}catch{}
 const pages=[];
 for(const item of results.slice(0,5)){try{const r=await fetch(item.url,{headers:{"user-agent":"Mozilla/5.0 AshSportsResearch/1.0"},signal:timeout(8000),redirect:"follow"});if(!r.ok)continue;const type=r.headers.get("content-type")||"";if(!type.includes("text/html")&&!type.includes("text/plain"))continue;const body=clean(await r.text(),1800);if(body.length>180)pages.push({...item,excerpt:body.slice(0,1400)});}catch{}}
 return {items:results,pages};
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
  let research={items:[],pages:[]};let needsResearch=/(analyse|analy[sz]e|predict|prediction|odds|injur|lineup|line-up|form|fixture|match|game|today|tomorrow|league|team|player|bet|pick|score|who wins|longs|over|under)/i.test(prompt);
  if(needsResearch){await fetch(TG+"/bot"+bot.botToken+"/sendChatAction",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,action:"typing"}),signal:timeout(5000)}).catch(()=>{});research=await searchWeb(prompt);}
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
  const system="You are Ash Jarvis, a thoughtful, curious sports research partner chatting in Telegram. Be conversational and genuinely brainstorm with the user. Handle ANY sport, league, match, athlete, tactics, statistics or sports question. Ask one concise clarification only when essential. For match analysis, structure: quick verdict; evidence (recent form, home/away, head-to-head only when meaningful, injuries/suspensions/lineups, schedule/rest, surface/weather if relevant); bookmaker consensus and price/value if supplied; risks and what could change the view; confidence as a calibrated qualitative estimate, never certainty. Distinguish verified facts, reports and inference. Never invent odds, injuries, lineups, sources or statistics. Current web research is supplied below; cite source titles and URLs in plain text. If sources disagree or are stale, say so. If live info is unavailable, disclose it. Do not force a bet; explain no-bet when edge is unclear. Betting is risky; encourage small fixed stakes and never chase losses. Do not claim a pick is guaranteed. Be willing to challenge the user's assumptions respectfully. Answer non-betting sports questions too. Keep replies readable and under 3500 characters.";
  const context=research.pages.map((p,i)=>"["+ (i+1)+"] "+p.title+" ("+(p.date||"date unavailable")+") "+" "+p.url+"\n"+p.excerpt).join("\n\n").slice(0,7000);
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
