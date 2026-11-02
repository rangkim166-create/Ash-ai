const TG="https://api.telegram.org";
const timeout=(ms)=>AbortSignal.timeout(ms);
const clean=(s,n=1200)=>String(s||"").replace(/<script[\\s\\S]*?<\\/script>/gi," ").replace(/<style[\\s\\S]*?<\\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\\s+/g," ").trim().slice(0,n);
async function searchWeb(q){
 const results=[];
 const rss="https://news.google.com/rss/search?q="+encodeURIComponent(q+" sports team match injury lineup form")+"&hl=en-US&gl=US&ceid=US:en";
 try{const r=await fetch(rss,{signal:timeout(10000)});if(r.ok){const x=await r.text();for(const m of x.matchAll(/<item>([\\s\\S]*?)<\\/item>/gi)){const b=m[1],title=clean((b.match(/<title>([\\s\\S]*?)<\\/title>/i)||[])[1],240),link=(b.match(/<link>([\\s\\S]*?)<\\/link>/i)||[])[1]?.trim(),date=clean((b.match(/<pubDate>([\\s\\S]*?)<\\/pubDate>/i)||[])[1],80);if(title&&link)results.push({title,url:link,date,source:"Google News"});if(results.length>=6)break;}}}catch{}
 try{const r=await fetch("https://html.duckduckgo.com/html/?q="+encodeURIComponent(q+" sports injuries team news"),{headers:{"user-agent":"Mozilla/5.0 AshSportsResearch/1.0"},signal:timeout(10000)});if(r.ok){const h=await r.text();for(const m of h.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)<\\/a>/gi)){let u=m[1];if(u.includes("uddg=")){try{u=decodeURIComponent(new URL(u,"https://duckduckgo.com").searchParams.get("uddg")||u)}catch{}}const title=clean(m[2],200);if(title&&/^https?:/.test(u)&&!results.some(x=>x.url===u))results.push({title,url:u,source:"Web search"});if(results.length>=10)break;}}}catch{}
 const pages=[];
 for(const item of results.slice(0,5)){try{const r=await fetch(item.url,{headers:{"user-agent":"Mozilla/5.0 AshSportsResearch/1.0"},signal:timeout(8000),redirect:"follow"});if(!r.ok)continue;const type=r.headers.get("content-type")||"";if(!type.includes("text/html")&&!type.includes("text/plain"))continue;const body=clean(await r.text(),1800);if(body.length>180)pages.push({...item,excerpt:body.slice(0,1400)});}catch{}}
 return {items:results,pages};
}
export function createTelegramAssistant({db,read,telegram}){
 let offset=0,running=false;
 async function send(chatId,text){for(let i=0;i<text.length;i+=3900){const part=text.slice(i,i+3900);await fetch(TG+"/bot"+(await read("telegram_bot")).botToken+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text:part,disable_web_page_preview:true}),signal:timeout(12000)});}}
 async function ai(messages,provider,key){const base=provider==="groq"?"https://api.groq.com/openai/v1/chat/completions":"https://openrouter.ai/api/v1/chat/completions";const model=provider==="groq"?(process.env.ASH_GROQ_MODEL||"llama-3.3-70b-versatile"):(process.env.ASH_OPENROUTER_MODEL||"openai/gpt-4o-mini");const r=await fetch(base,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key,"HTTP-Referer":"https://ash-sports-api.onrender.com","X-Title":"Ash Jarvis Sports"},body:JSON.stringify({model,messages,temperature:0.35,max_tokens:1100}),signal:timeout(45000)});const j=await r.json();if(!r.ok)throw Error(provider+" HTTP "+r.status+" "+JSON.stringify(j).slice(0,180));return j.choices?.[0]?.message?.content||"";}
 async function answer(chatId,text){
  const bot=await read("telegram_bot");if(!bot?.botToken||!bot?.chatId)throw Error("Telegram bot is not configured");
  if(String(chatId)!==String(bot.chatId))return;
  if(/^\\/start|^\\/help/i.test(text)){await send(chatId,"Yo, I'm Ash Jarvis — your sports research partner. 🧠\\n\\nAsk me about any match, sport, league, odds, tactics or betting idea. Example: Analyse Arsenal vs Chelsea, including injuries and value.\\n\\nCommands: /clear clears chat memory · /help shows this guide.\\n\\nI'll search current public sources when relevant, compare evidence, and tell you when information is missing. No guaranteed wins.");return;}
  if(/^\\/clear/i.test(text)){await db.query("DELETE FROM ash_telegram_memory WHERE chat_id=$1",[String(chatId)]);await send(chatId,"Chat memory cleared. What are we researching?");return;}
  const prompt=text.replace(/^\\/\\w+\\s*/,"").trim();if(!prompt)return;
  await db.query("CREATE TABLE IF NOT EXISTS ash_telegram_memory(chat_id text NOT NULL,role text NOT NULL,content text NOT NULL,created_at timestamptz NOT NULL DEFAULT now())");
  const history=await db.query("SELECT role,content FROM ash_telegram_memory WHERE chat_id=$1 ORDER BY created_at DESC LIMIT 12",[String(chatId)]);
  let research={items:[],pages:[]};let needsResearch=/(analyse|analy[sz]e|predict|prediction|odds|injur|lineup|line-up|form|fixture|match|game|today|tomorrow|league|team|player|bet|pick|score|who wins|longs|over|under)/i.test(prompt);
  if(needsResearch){await fetch(TG+"/bot"+bot.botToken+"/sendChatAction",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,action:"typing"}),signal:timeout(5000)}).catch(()=>{});research=await searchWeb(prompt);}
  const system="You are Ash Jarvis, a thoughtful, curious sports research partner chatting in Telegram. Be conversational and genuinely brainstorm with the user. Handle ANY sport, league, match, athlete, tactics, statistics or sports question. Ask one concise clarification only when essential. For match analysis, structure: quick verdict; evidence (recent form, home/away, head-to-head only when meaningful, injuries/suspensions/lineups, schedule/rest, surface/weather if relevant); bookmaker consensus and price/value if supplied; risks and what could change the view; confidence as a calibrated qualitative estimate, never certainty. Distinguish verified facts, reports and inference. Never invent odds, injuries, lineups, sources or statistics. Current web research is supplied below; cite source titles and URLs in plain text. If sources disagree or are stale, say so. If live info is unavailable, disclose it. Do not force a bet; explain no-bet when edge is unclear. Betting is risky; encourage small fixed stakes and never chase losses. Do not claim a pick is guaranteed. Be willing to challenge the user's assumptions respectfully. Answer non-betting sports questions too. Keep replies readable and under 3500 characters.";
  const context=research.pages.map((p,i)=>"["+ (i+1)+"] "+p.title+" ("+(p.date||"date unavailable")+") "+" "+p.url+"\\n"+p.excerpt).join("\\n\\n").slice(0,7000);
  const messages=[{role:"system",content:system+"\\n\\nWEB RESEARCH:\\n"+(context||"No usable current web pages retrieved. Do not pretend web research was successful.")},...history.rows.reverse().map(x=>({role:x.role,content:x.content})),{role:"user",content:prompt}];
  let response="",errors=[];
  for(const provider of ["groq","openrouter"]){try{const key=await read(provider);if(!key)continue;response=await ai(messages,provider,key);if(response)break;}catch(e){errors.push(String(e.message||e));}}
  if(!response)response="I'm unable to reach my AI providers right now. "+(errors.join(" | ").slice(0,400)||"Check Groq/OpenRouter credentials in the Ash backend.");
  await db.query("INSERT INTO ash_telegram_memory(chat_id,role,content) VALUES($1,'user',$2),($1,'assistant',$3)",[String(chatId),prompt,response]);
  await db.query("DELETE FROM ash_telegram_memory WHERE chat_id=$1 AND created_at < now()-interval '14 days'",[String(chatId)]);
  await send(chatId,response);
 }
 async function poll(){
  if(running)return;running=true;
  try{const bot=await read("telegram_bot");if(!bot?.botToken||!bot?.chatId)return;const r=await fetch(TG+"/bot"+bot.botToken+"/getUpdates?timeout=20&offset="+offset+"&allowed_updates=%5B%22message%22%5D",{signal:timeout(26000)});const j=await r.json();if(!r.ok||!j.ok)throw Error(j.description||"Telegram polling failed");for(const u of j.result||[]){offset=Math.max(offset,Number(u.update_id)+1);const m=u.message;if(!m?.text)continue;try{await answer(m.chat.id,m.text);}catch(e){console.error("[ash-telegram-ai]",e);if(String(m.chat.id)===String(bot.chatId))await send(m.chat.id,"I hit a temporary issue: "+String(e.message||e).slice(0,250)).catch(()=>{});}}}catch(e){console.error("[ash-telegram-poll]",String(e.message||e));}finally{running=false;}
 }
 return {poll};
}
