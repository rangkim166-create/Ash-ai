import { createHash } from "node:crypto";
const TG="https://api.telegram.org";
const timeout=(ms)=>AbortSignal.timeout(ms);
const clean=(s,n=1200)=>String(s||"").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g," ").trim().slice(0,n);
async function searchWeb(q){
 const results=[],seen=new Set(),now=Date.now();
 const d7=new Date(now-7*24*60*60*1000).toISOString().slice(0,10),d1=new Date(now-24*60*60*1000).toISOString().slice(0,10);
 const queries=[q+" after:"+d7,q+" team news injuries suspensions official after:"+d7,q+" recent form last five matches results match reports",q+" upcoming fixtures schedule next 7 days",q+" bookmaker odds odds comparison after:"+d7];
 const add=(item)=>{if(item?.title&&item?.url&&/^https?:/.test(item.url)&&!seen.has(item.url)){seen.add(item.url);results.push(item);}};
 await Promise.all(queries.map(async(query)=>{try{
  const rss="https://news.google.com/rss/search?q="+encodeURIComponent(query)+"&hl=en-US&gl=US&ceid=US:en";
  const r=await fetch(rss,{signal:timeout(12000)});if(!r.ok)return;const x=await r.text();
   for(const m of x.matchAll(new RegExp("<item>([\\s\\S]*?)</item>","gi"))){const b=m[1],title=clean((b.match(new RegExp("<title>([\\s\\S]*?)</title>","i"))||[])[1],240),link=(b.match(new RegExp("<link>([\\s\\S]*?)</link>","i"))||[])[1]?.trim(),raw=(b.match(new RegExp("<pubDate>([\\s\\S]*?)</pubDate>","i"))||[])[1],date=clean(raw,80),published=raw?Date.parse(raw):NaN;
   if(title&&link)add({title,url:link,date,publishedAt:Number.isFinite(published)?new Date(published).toISOString():null,ageHours:Number.isFinite(published)?Math.round((now-published)/3600000):null,source:"Google News"});
   if(results.length>=24)break;
  }
 }catch{}}));
 await Promise.all(queries.slice(0,4).map(async(query)=>{try{
  const r=await fetch("https://html.duckduckgo.com/html/?q="+encodeURIComponent(query),{headers:{"user-agent":"Mozilla/5.0 AshSportsResearch/2.0"},signal:timeout(12000)});if(!r.ok)return;const h=await r.text();
   for(const m of h.matchAll(new RegExp('class="result__a"[^>]*href="([^"]+)"[^>]*>([\\s\\S]*?)</a>',"gi"))){let u=m[1];if(u.includes("uddg=")){try{u=decodeURIComponent(new URL(u,"https://duckduckgo.com").searchParams.get("uddg")||u)}catch{}}add({title:clean(m[2],200),url:u,source:"Web search"});if(results.length>=30)break;}
 }catch{}}));
 const ranked=results.filter(x=>x.ageHours==null||x.ageHours<=90*24).sort((a,b)=>(a.ageHours??999999)-(b.ageHours??999999)).slice(0,12);
 const pages=[];
 for(const item of ranked.slice(0,9)){try{const r=await fetch(item.url,{headers:{"user-agent":"Mozilla/5.0 AshSportsResearch/2.0"},signal:timeout(9000),redirect:"follow"});if(!r.ok)continue;const type=r.headers.get("content-type")||"";if(!type.includes("text/html")&&!type.includes("text/plain"))continue;const body=clean(await r.text(),2600);if(body.length>180)pages.push({...item,excerpt:body.slice(0,1900)});}catch{}}
 return {items:ranked,pages,retrievedAt:new Date().toISOString()};
}
async function fetchLiveOdds(prompt,read){
 const key=await read("the_odds_api");
 if(!key)return {status:"not_configured",events:[],scores:[],diagnostics:{reason:"missing_api_key"}};
 const now=Date.now(),retrievedAt=new Date(now).toISOString();
 const diagnostics={catalogHttp:null,selectedSports:[],oddsRequests:0,scoreRequests:0,oddsErrors:[],scoreErrors:[],requestsRemaining:null,requestsUsed:null};
 const normalize=s=>(s||"").toLowerCase().replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();
 const stopWords=new Set(["analyse","analyze","predict","prediction","latest","available","information","show","current","injuries","injury","form","bookmaker","bookmakers","comparison","comparisons","timestamps","today","tomorrow","yesterday","please","match","matches","game","games","odds","value","research","using","including","with","the","and","for","from","what","about","can","you","live","score","scores","result","results","football","soccer","upcoming","next","week","days","pick","picks","bet","bets"]);
 const teamTokens=s=>normalize(s).split(" ").filter(w=>w.length>2&&!stopWords.has(w));
 const fixtureParts=prompt.split(/\b(?:vs\.?|versus)\b|\s+[–—-]\s+/i);
 let requestedTeams=[];
 if(fixtureParts.length===2){
  const left=fixtureParts[0].split(/\b(?:analyse|analyze|predict|check|research|show|what|tell me about)\b/i).pop();
  const right=fixtureParts[1].split(/\b(?:using|with|including|and show|for today|today|tomorrow|yesterday|next)\b/i)[0];
  const a=teamTokens(left),b=teamTokens(right);
  if(a.length&&b.length)requestedTeams=[a,b];
 }
 const overlap=(a,b)=>a.some(x=>b.some(y=>x===y||x.startsWith(y)||y.startsWith(x)));
 const matchesTeams=(home,away)=>!requestedTeams.length||((overlap(requestedTeams[0],teamTokens(home))&&overlap(requestedTeams[1],teamTokens(away)))||(overlap(requestedTeams[0],teamTokens(away))&&overlap(requestedTeams[1],teamTokens(home))));
 try{
  const sr=await fetch("https://api.the-odds-api.com/v4/sports?apiKey="+encodeURIComponent(key),{signal:timeout(12000)});
  diagnostics.catalogHttp=sr.status;
  if(!sr.ok)return {status:"sports_catalog_http_"+sr.status,retrievedAt,events:[],scores:[],diagnostics};
  const sports=await sr.json();
  const category=/\b(nba|basketball|wnba|ncaa|euroleague)\b/i.test(prompt)?"basketball":/\b(tennis|atp|wta|grand slam)\b/i.test(prompt)?"tennis":"soccer";
  const active=sports.filter(s=>s.active&&(s.key||"").toLowerCase().startsWith(category+"_")&&!/(championship_winner|outright|winner$)/i.test(s.key||""));
  const priority=category==="soccer"
   ?["soccer_epl","soccer_saudi_professional_league","soccer_ksa_pro_league","soccer_egypt_premier_league","soccer_morocco_botola_pro","soccer_uefa_champs_league","soccer_uefa_europa_league","soccer_spain_la_liga","soccer_germany_bundesliga","soccer_italy_serie_a","soccer_france_ligue_one","soccer_england_efl_cup","soccer_fa_cup"]
   :category==="basketball"?["basketball_nba","basketball_euroleague","basketball_ncaab","basketball_wnba"]:[];
  active.sort((a,b)=>{
   const rank=s=>{const i=priority.indexOf(s.key);if(i>=0)return i;const k=(s.key||"").toLowerCase();if(category==="soccer"&&/(saudi|egypt|morocco|qatar|uae|tunisia|algeria|africa)/.test(k))return 5;if(category==="tennis"&&/(atp|wta)/.test(k))return 10;return 50;};
   return rank(a)-rank(b)||(a.title||"").localeCompare(b.title||"");
  });
  const selected=active.slice(0,8);
  diagnostics.selectedSports=selected.map(s=>s.key);
  const oddsNeeded=/\b(odds|bet|bets|pick|picks|predict|prediction|value|analyse|analyze|vs\.?|versus|bookmaker|tip)\b/i.test(prompt);
  const scoreSports=selected.slice(0,(requestedTeams.length?8:5));
  const [oddsResults,scoreResults]=await Promise.all([
   oddsNeeded?Promise.all(selected.map(async sport=>{
    diagnostics.oddsRequests++;
    try{
     const u="https://api.the-odds-api.com/v4/sports/"+encodeURIComponent(sport.key)+"/odds?regions=uk,eu&markets=h2h&oddsFormat=decimal&dateFormat=iso&apiKey="+encodeURIComponent(key);
     const r=await fetch(u,{signal:timeout(16000)});
     diagnostics.requestsRemaining=r.headers.get("x-requests-remaining")??diagnostics.requestsRemaining;
     diagnostics.requestsUsed=r.headers.get("x-requests-used")??diagnostics.requestsUsed;
     if(!r.ok)throw Error("HTTP "+r.status);
     const data=await r.json(),events=[];
     for(const e of (Array.isArray(data)?data:[])){
      if(!matchesTeams(e.home_team,e.away_team))continue;
      const start=Date.parse(e.commence_time||"");
      if(!Number.isFinite(start)||start<now-3*86400000||start>now+14*86400000)continue;
      const fresh=[],stale=[];
      for(const b of(e.bookmakers||[])){
       const updated=Date.parse(b.last_update||"");
       const age=Number.isFinite(updated)?(now-updated)/60000:Infinity;
       if(age>=0&&age<=15)fresh.push({name:b.title,updated:b.last_update,ageMinutes:Math.round(age),markets:(b.markets||[]).filter(m=>m.key==="h2h").map(m=>({key:m.key,outcomes:(m.outcomes||[]).map(o=>({name:o.name,price:o.price}))}))});
       else stale.push({name:b.title,updated:b.last_update,ageMinutes:Number.isFinite(age)?Math.round(age):null});
      }
      events.push({id:e.id,sport:sport.title||sport.key,sportKey:sport.key,home:e.home_team,away:e.away_team,commence_time:e.commence_time,phase:start>now?"upcoming":"started_or_in_play",bookmakers:fresh,staleBookmakers:stale.length,hasFreshOdds:fresh.length>0});
     }
     return events;
    }catch(e){diagnostics.oddsErrors.push({sport:sport.key,error:String(e.message||e).slice(0,100)});return [];}
   })):Promise.resolve([]),
   Promise.all(scoreSports.map(async sport=>{
    diagnostics.scoreRequests++;
    try{
     const u="https://api.the-odds-api.com/v4/sports/"+encodeURIComponent(sport.key)+"/scores?daysFrom=3&dateFormat=iso&apiKey="+encodeURIComponent(key);
     const r=await fetch(u,{signal:timeout(16000)});
     diagnostics.requestsRemaining=r.headers.get("x-requests-remaining")??diagnostics.requestsRemaining;
     diagnostics.requestsUsed=r.headers.get("x-requests-used")??diagnostics.requestsUsed;
     if(!r.ok)throw Error("HTTP "+r.status);
     const data=await r.json(),out=[];
     for(const e of(Array.isArray(data)?data:[])){
      if(!matchesTeams(e.home_team,e.away_team))continue;
      const start=Date.parse(e.commence_time||"");
      if(!Number.isFinite(start)||start<now-3*86400000||start>now+8*86400000)continue;
      const scoreMap=new Map((e.scores||[]).map(x=>[x.name,String(x.score)]));
      const homeScore=scoreMap.has(e.home_team)?scoreMap.get(e.home_team):null;
      const awayScore=scoreMap.has(e.away_team)?scoreMap.get(e.away_team):null;
      const completed=e.completed===true;
      const phase=completed?"completed":start>now?"upcoming":(homeScore!==null||awayScore!==null)?"live":"started_unconfirmed";
      const updated=Date.parse(e.last_update||"");
      out.push({id:e.id,sport:sport.title||sport.key,sportKey:sport.key,home:e.home_team,away:e.away_team,commence_time:e.commence_time,completed,phase,homeScore,awayScore,lastUpdate:e.last_update||null,ageMinutes:Number.isFinite(updated)?Math.round((now-updated)/60000):null});
     }
     return out;
    }catch(e){diagnostics.scoreErrors.push({sport:sport.key,error:String(e.message||e).slice(0,100)});return [];}
   }))
  ]);
  const oddsEvents=oddsResults.flat().sort((a,b)=>Date.parse(a.commence_time)-Date.parse(b.commence_time)).slice(0,16);
  const scoreEvents=scoreResults.flat().sort((a,b)=>Date.parse(b.commence_time)-Date.parse(a.commence_time)).slice(0,24);
  const quotaRemaining=Number(diagnostics.requestsRemaining);
  return {status:diagnostics.oddsErrors.length||diagnostics.scoreErrors.length?"partial":"ok",retrievedAt,requestedTeams:requestedTeams.length?requestedTeams.map(x=>x.join(" ")):null,events:oddsEvents,scores:scoreEvents,diagnostics:{...diagnostics,quotaRemaining:Number.isFinite(quotaRemaining)?quotaRemaining:null}};
 }catch(e){return {status:"error",message:String(e.message||e).slice(0,140),retrievedAt,events:[],scores:[],diagnostics};}
}


async function saveLiveResearchSnapshots(db,live){
 const scores=Array.isArray(live?.scores)?live.scores:[];
 const odds=Array.isArray(live?.events)?live.events:[];
 const byEvent=new Map();
 for(const item of scores){
  const key=String(item.sportKey||"")+":"+String(item.id||"");
  if(!item.id||!item.sportKey)continue;
  byEvent.set(key,{event_id:String(item.id),sport_key:String(item.sportKey),sport_title:String(item.sport||""),home_team:String(item.home||""),away_team:String(item.away||""),commence_time:item.commence_time||null,phase:String(item.phase||"unknown"),home_score:item.homeScore,away_score:item.awayScore,score_updated_at:item.lastUpdate||null,bookmakers:[],retrieved_at:live.retrievedAt||new Date().toISOString()});
 }
 for(const item of odds){
  const key=String(item.sportKey||"")+":"+String(item.id||"");
  if(!item.id||!item.sportKey)continue;
  const row=byEvent.get(key)||{event_id:String(item.id),sport_key:String(item.sportKey),sport_title:String(item.sport||""),home_team:String(item.home||""),away_team:String(item.away||""),commence_time:item.commence_time||null,phase:String(item.phase||"unknown"),home_score:null,away_score:null,score_updated_at:null,bookmakers:[],retrieved_at:live.retrievedAt||new Date().toISOString()};
  row.bookmakers=item.bookmakers||[];
  byEvent.set(key,row);
 }
 const rows=[...byEvent.values()].slice(0,32);
 if(!rows.length)return {saved:0};
 await db.query("CREATE TABLE IF NOT EXISTS ash_live_research_snapshots(id bigserial PRIMARY KEY,event_id text NOT NULL,sport_key text NOT NULL,sport_title text,home_team text NOT NULL,away_team text NOT NULL,commence_time timestamptz,phase text NOT NULL,home_score text,away_score text,score_updated_at timestamptz,bookmakers jsonb NOT NULL DEFAULT '[]'::jsonb,retrieved_at timestamptz NOT NULL)");
 await db.query("INSERT INTO ash_live_research_snapshots(event_id,sport_key,sport_title,home_team,away_team,commence_time,phase,home_score,away_score,score_updated_at,bookmakers,retrieved_at) SELECT x.event_id,x.sport_key,x.sport_title,x.home_team,x.away_team,x.commence_time::timestamptz,x.phase,x.home_score,x.away_score,x.score_updated_at::timestamptz,x.bookmakers::jsonb,x.retrieved_at::timestamptz FROM jsonb_to_recordset($1::jsonb) AS x(event_id text,sport_key text,sport_title text,home_team text,away_team text,commence_time text,phase text,home_score text,away_score text,score_updated_at text,bookmakers jsonb,retrieved_at text)",[JSON.stringify(rows)]);
 return {saved:rows.length};
}

export function createTelegramAssistant({db,read,telegram}){
 let connectedLogged=false;
 async function send(chatId,text){const bot=await read("telegram_bot");for(let i=0;i<text.length;i+=3900){const part=text.slice(i,i+3900);const r=await fetch(TG+"/bot"+bot.botToken+"/sendMessage",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,text:part,disable_web_page_preview:true}),signal:timeout(12000)});const j=await r.json();if(!r.ok||!j.ok)throw Error("Telegram send failed: "+(j.description||r.status));}}
 async function ai(messages,provider,key){
  const base=provider==="groq"?"https://api.groq.com/openai/v1/chat/completions":"https://openrouter.ai/api/v1/chat/completions";
  const models=provider==="groq"?[...new Set([process.env.ASH_GROQ_MODEL||"openai/gpt-oss-120b","openai/gpt-oss-120b","openai/gpt-oss-20b"])]:[process.env.ASH_OPENROUTER_MODEL||"openai/gpt-4o-mini"];
  const errors=[];
  for(const model of models){
   const r=await fetch(base,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key,"HTTP-Referer":"https://ash-sports-api.onrender.com","X-Title":"Ash Jarvis Sports"},body:JSON.stringify({model,messages,temperature:0.35,max_tokens:650}),signal:timeout(45000)});
   const j=await r.json();
   if(r.ok)return j.choices?.[0]?.message?.content||"";
   const detail=JSON.stringify(j).slice(0,180);
   errors.push(model+" HTTP "+r.status+" "+detail);
   if(provider==="groq"&&(r.status===413||r.status===429)&&messages[0]?.content?.length>2200){
    const full=String(messages[0].content||""),marker=full.indexOf("CURRENT RESEARCH:"),systemPart=full.slice(0,Math.min(marker<0?2200:marker,2200)),researchPart=marker>=0?full.slice(marker,marker+3600):full.slice(-3000);const smaller=[{role:"system",content:systemPart+"\\n\\n"+researchPart},...messages.slice(-3).map(x=>({role:x.role,content:String(x.content||"").slice(0,350)}))];
    const retry=await fetch(base,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+key},body:JSON.stringify({model,messages:smaller,temperature:0.25,max_tokens:450}),signal:timeout(45000)});
    const retryJson=await retry.json();if(retry.ok)return retryJson.choices?.[0]?.message?.content||"";
    errors.push(model+" compact retry HTTP "+retry.status+" "+JSON.stringify(retryJson).slice(0,140));
   }
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
  if(needsResearch){await fetch(TG+"/bot"+bot.botToken+"/sendChatAction",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chatId,action:"typing"}),signal:timeout(5000)}).catch(()=>{});research=await searchWeb(prompt);research.liveOdds=await fetchLiveOdds(prompt,read);await saveLiveResearchSnapshots(db,research.liveOdds).catch(e=>console.warn("[ash-live-snapshot-save]",String(e.message||e).slice(0,140)));console.log("[ash-research]",JSON.stringify({retrievedAt:research.retrievedAt,searchResults:research.items?.length||0,extractedPages:research.pages?.length||0,oddsStatus:research.liveOdds?.status,requestedTeams:research.liveOdds?.requestedTeams,selectedSports:research.liveOdds?.diagnostics?.selectedSports,eventCount:research.liveOdds?.events?.length||0,perSport:research.liveOdds?.diagnostics?.perSport,requestsRemaining:research.liveOdds?.diagnostics?.requestsRemaining}));}
  let databaseResearch="";
  if(needsResearch){
   try{
    const stop=new Set(["analyse","analyze","predict","prediction","odds","injury","injuries","lineup","lineups","form","fixture","fixtures","match","matches","game","games","today","tomorrow","league","team","player","players","bet","bets","pick","picks","score","scores","who","wins","winner","long","longs","over","under","please","what","about","with","from","against","including","value","best","compare","research","sports","football","soccer","basketball","tennis","next","days","week","upcoming","genuinely","distinct","independently","confirm","confirmed","actual","seven"]);
    const terms=[...new Set((prompt.match(/[A-Za-z][A-Za-z0-9.'-]{2,}/g)||[]).map(x=>x.replace(/[.'-]/g,"").toLowerCase()).filter(x=>x.length>=3&&!stop.has(x)))].slice(0,8);
    const fixtureIntent=/\b(upcoming|fixtures|next\s+\d+\s+days|next week|matches this week)\b/i.test(prompt);
    let matches={rows:[]};
    if(fixtureIntent&&!/\b(?:vs\.?|versus)\b/i.test(prompt)){
     matches=await db.query("SELECT id,sport,competition,home_or_player_one,away_or_player_two,starts_at,status FROM sports_matches WHERE status='scheduled' AND starts_at>now() AND starts_at<=now()+interval '7 days' ORDER BY starts_at ASC LIMIT 40");
    }else if(terms.length){
     const patterns=terms.map(x=>"%"+x+"%");
     matches=await db.query("SELECT id,sport,competition,home_or_player_one,away_or_player_two,starts_at,status FROM sports_matches WHERE starts_at BETWEEN now()-interval '12 hours' AND now()+interval '14 days' AND (home_or_player_one ILIKE ANY($1::text[]) OR away_or_player_two ILIKE ANY($1::text[])) ORDER BY starts_at ASC LIMIT 20",[patterns]);
    }
    const teamNames=[...new Set(matches.rows.flatMap(x=>[x.home_or_player_one,x.away_or_player_two]).filter(Boolean))];
    let formRows={rows:[]};
    if(teamNames.length){
     formRows=await db.query("SELECT sport,competition,home_or_player_one,away_or_player_two,starts_at,home_score,away_score FROM sports_matches WHERE status='completed' AND starts_at<now() AND home_score IS NOT NULL AND away_score IS NOT NULL AND (home_or_player_one=ANY($1::text[]) OR away_or_player_two=ANY($1::text[])) ORDER BY starts_at DESC LIMIT 120",[teamNames]);
    }
    let priceRows={rows:[]};
    if(matches.rows.length){
     const ids=matches.rows.map(x=>x.id);
     priceRows=await db.query("SELECT match_id,bookmaker_key,market_key,outcome_name,decimal_odds,line,observed_at FROM bookmaker_odds WHERE match_id=ANY($1::text[]) AND observed_at>now()-interval '36 hours' ORDER BY match_id,observed_at DESC LIMIT 240",[ids]);
    }
    const fixtureLines=matches.rows.map(m=>{
     const p=priceRows.rows.filter(x=>x.match_id===m.id).slice(0,18).map(x=>x.bookmaker_key+" "+x.market_key+" "+x.outcome_name+(x.line==null?"":" "+x.line)+" @ "+x.decimal_odds+" (seen "+new Date(x.observed_at).toISOString()+")");
     return m.sport+" | "+m.competition+" | "+m.home_or_player_one+" vs "+m.away_or_player_two+" | "+new Date(m.starts_at).toISOString()+" | "+m.status+(p.length?"\n bookmaker snapshots: "+p.join("; "):"\n no recent bookmaker prices stored");
    });
    const formByTeam=new Map();
    for(const row of formRows.rows){
     const home=row.home_or_player_one,away=row.away_or_player_two;
     for(const team of teamNames){
      if(home!==team&&away!==team)continue;
      const isHome=home===team,forScore=Number(isHome?row.home_score:row.away_score),against=Number(isHome?row.away_score:row.home_score);
      const outcome=forScore>against?"W":forScore<against?"L":"D";
      if(!formByTeam.has(team))formByTeam.set(team,[]);
      if(formByTeam.get(team).length<5)formByTeam.get(team).push(new Date(row.starts_at).toISOString().slice(0,10)+" "+outcome+" "+forScore+"-"+against+" vs "+(isHome?away:home)+" ("+row.competition+")");
     }
    }
    const formLines=[...formByTeam.entries()].map(([team,rows])=>team+" last five stored competitive results: "+rows.join(" | "));
    databaseResearch="STORED UPCOMING FIXTURES (not independently verified):\n"+(fixtureLines.join("\n")||"No matching upcoming fixtures stored.")+"\nLAST FIVE STORED RESULTS (may be incomplete; do not imply complete if fewer than five):\n"+(formLines.join("\n")||"No stored completed results for these teams.");
   }catch(e){console.error("[ash-telegram-db-research]",String(e.message||e));databaseResearch="Database research failed: "+String(e.message||e).slice(0,140);}
  }
  const system="You are Ash Jarvis, a live sports research analyst. Your first duty is to prevent stale or incorrect recommendations. For every match-related request, use the live scores feed, live bookmaker feed and fresh web research supplied below; do not rely on memory or old database snapshots for current facts. First establish the exact fixture, competition, kickoff time and status. If the game has started, label it LIVE and never issue a pre-match prediction. If completed, report the verified final score and never recommend a bet on it. The scores feed is authoritative for live/completed scores when its lastUpdate is recent; cite its timestamp. For pre-match picks, require exact fixture match, kickoff in the future, and at least two bookmakers with odds updated within 15 minutes. If any requirement fails, return NO BET and explain exactly what is missing. Never use odds older than 15 minutes as current prices. Never substitute another fixture or treat a similarly named team as a match. Check for postponed/cancelled status in current sources. For team news, use sources published within 24 hours; if not available, say unknown rather than reuse old articles. Before issuing an actual pre-match betting selection, require current team-news checks for BOTH sides from official club/league channels or reputable reporters within 24 hours; if either side cannot be checked, provide analysis only and return NO BET. Use dated competitive results for last-five form, regardless of publication date, but verify the result dates and avoid confusing cup and league form. Verify important claims against two independent sources when possible. Separate confirmed facts, reports and inference. Never call predicted lineups confirmed. Never present stored database snapshots as live. Only quote bookmaker prices from the supplied live odds feed, with bookmaker name and exact update time. Explain implied probability and market overround correctly. A favourite is not automatically a value bet. Only recommend a selection when your independently assessed probability exceeds the vig-adjusted market probability by a meaningful margin and the evidence supports it; otherwise NO BET. State the research retrieval time, score-feed update time, bookmaker update times, source publication dates and links. If sources are stale, conflicting, incomplete or unavailable, downgrade confidence or refuse a pick. For a named match, check both teams and exact fixture date. For broad fixture discovery, list real upcoming events. Handle any sport, league, athlete, tactics or statistics question. No guaranteed wins, no forced bets, no chasing losses. Do not claim that live data guarantees a result. Keep replies readable and under 3500 characters.";

  const context="Research retrieved at "+(research.retrievedAt||"unknown")+". Search returned "+(research.items||[]).length+" results and extracted "+(research.pages||[]).length+" pages.\n"+research.pages.slice(0,5).map((p,i)=>"["+(i+1)+"] "+p.title+" ("+(p.date||"publication date unavailable")+") "+p.url+"\n"+String(p.excerpt||"").slice(0,450)).join("\n\n").slice(0,2300)+"\n"+String(databaseResearch||"No database research.").slice(0,900)+"\nLIVE SCORES + STATUS: "+JSON.stringify(research.liveOdds?.scores||[]).slice(0,2600)+"\nLIVE BOOKMAKER ODDS: "+JSON.stringify(research.liveOdds||{status:"not_checked"}).slice(0,3000);
  const ageRule="If score feed marks completed=true, treat result as final; if phase=live, report the score as live with lastUpdate. If phase=started_unconfirmed, do not guess the score. For any pre-match recommendation, require at least two bookmakers with ageMinutes <= 15, a future kickoff, and an exact fixture. Otherwise NO BET. The live scores endpoint may cover only selected competitions; disclose coverage limits. Do not infer a team's chance from a single match or from bookmaker favourite status alone.\n";
  const compactSystem=(system+ "\\n"+ageRule).slice(0,2800);
  const messages=[{role:"system",content:compactSystem+"\\n\\nCURRENT RESEARCH:\\n"+(context||"No current sources retrieved; disclose this.")},...history.rows.slice(0,4).reverse().map(x=>({role:x.role,content:String(x.content||"").slice(0,350)})),{role:"user",content:prompt.slice(0,1400)}];
  let response="",errors=[];
  for(const provider of ["groq","openrouter"]){try{const key=await read(provider);if(!key)continue;response=await ai(messages,provider,key);if(response)break;}catch(e){errors.push(String(e.message||e));}}
  if(!response)response="I'm unable to reach my AI providers right now. "+(errors.join(" | ").slice(0,400)||"Check Groq/OpenRouter credentials in the Ash backend.");
  await db.query("INSERT INTO ash_telegram_memory(chat_id,role,content) VALUES($1,'user',$2),($1,'assistant',$3)",[String(chatId),prompt,response]);
  await db.query("DELETE FROM ash_telegram_memory WHERE chat_id=$1 AND created_at < now()-interval '14 days'",[String(chatId)]);
  await send(chatId,response);
 }
 async function researchDailyPicks(picks=[]){
  const candidates=(Array.isArray(picks)?picks:[]).slice(0,3);
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const retrieveRss=async(query)=>{
   const url="https://news.google.com/rss/search?q="+encodeURIComponent(query)+"&hl=en-US&gl=US&ceid=US:en";
   const response=await fetch(url,{signal:timeout(12000)});
   if(!response.ok)throw Error("Google News RSS HTTP "+response.status);
   const xml=await response.text(),now=Date.now(),items=[];
   const tagValue=(block,tag)=>{
    const open="<"+tag+">",close="</"+tag+">",start=block.indexOf(open);
    if(start<0)return "";
    const end=block.indexOf(close,start+open.length);
    return end<0?"":block.slice(start+open.length,end).trim();
   };
   for(const block of xml.split("<item>").slice(1).map(part=>part.split("</item>")[0])){
    const title=clean(tagValue(block,"title"),240),link=tagValue(block,"link"),raw=tagValue(block,"pubDate");
    const published=raw?Date.parse(raw):NaN;
    if(title&&link&&/^https?:/.test(link)){
     let domain="unknown";try{domain=new URL(link).hostname.replace(/^www[.]/,"")}catch{}
     items.push({title,url:link,date:raw?clean(raw,80):null,publishedAt:Number.isFinite(published)?new Date(published).toISOString():null,ageHours:Number.isFinite(published)?Math.max(0,Math.round((now-published)/3600000)):null,domain});
    }
    if(items.length>=8)break;
   }
   return items;
  };
  const fetchArticle=async(item)=>{
   try{
    const response=await fetch(item.url,{headers:{"user-agent":"Mozilla/5.0 (compatible; AshSportsResearch/3.0)"},signal:timeout(9000),redirect:"follow"});
    if(!response.ok)return null;
    const type=response.headers.get("content-type")||"";
    if(!type.includes("text/html")&&!type.includes("text/plain"))return null;
    const excerpt=clean(await response.text(),2600);
    if(excerpt.length<160)return null;
    return {...item,excerpt:excerpt.slice(0,1350)};
   }catch{return null;}
  };
  const reports=[];
  // Research is deliberately serial: one fixture, then its home side, then its away side.
  for(const pick of candidates){
   const home=String(pick.home_team||""),away=String(pick.away_team||""),competition=String(pick.competition||"");
   const matchQuery='"'+home+'" "'+away+'" "'+competition+'" (tipster OR prediction OR expert picks OR match preview OR pundit analysis) after:'+new Date(Date.now()-10*86400000).toISOString().slice(0,10);
   const homeQuery='"'+home+'" '+competition+' (team news OR injuries OR suspensions OR lineup OR manager comments) after:'+new Date(Date.now()-7*86400000).toISOString().slice(0,10);
   const awayQuery='"'+away+'" '+competition+' (team news OR injuries OR suspensions OR lineup OR manager comments) after:'+new Date(Date.now()-7*86400000).toISOString().slice(0,10);
   const matchItems=[],homeItems=[],awayItems=[],errors=[];
   for(const [label,query,target] of [["match",matchQuery,matchItems],["home",homeQuery,homeItems],["away",awayQuery,awayItems]]){
    try{const items=await retrieveRss(query);target.push(...items);console.log("[ash-daily-research-step]",JSON.stringify({match:home+" vs "+away,stage:label,results:items.length}));}
    catch(error){errors.push(label+": "+String(error?.message||error).slice(0,100));}
    await pause(850);
   }
   const unique=new Map();
   for(const item of [...matchItems.slice(0,4),...homeItems.slice(0,3),...awayItems.slice(0,3)])if(!unique.has(item.url))unique.set(item.url,item);
   const candidatesToRead=[...unique.values()].sort((a,b)=>(a.ageHours??999999)-(b.ageHours??999999)).slice(0,5);
   const pages=[];
   for(const item of candidatesToRead){const page=await fetchArticle(item);if(page)pages.push(page);await pause(650);}
   const homePages=pages.filter(p=>homeItems.some(x=>x.url===p.url));
   const awayPages=pages.filter(p=>awayItems.some(x=>x.url===p.url));
   const matchPages=pages.filter(p=>matchItems.some(x=>x.url===p.url));
   const domains=[...new Set(pages.map(p=>p.domain))];
   reports.push({matchId:pick.id,home,away,competition,retrievedAt:new Date().toISOString(),searchCounts:{match:matchItems.length,home:homeItems.length,away:awayItems.length},domains,homePages,awayPages,matchPages,pages,errors,quality:{homeCoverage:homePages.length>0,awayCoverage:awayPages.length>0,expertCoverage:matchPages.length>0,independentDomains:domains.length}});
  }
  // One batch synthesis request per daily publication, never one AI call per team.
  const groqKey=await read("groq");
  if(groqKey&&reports.length){
   try{
    const evidence=reports.map(r=>({matchId:r.matchId,fixture:r.home+" vs "+r.away,competition:r.competition,coverage:r.quality,sources:r.pages.map(p=>({title:p.title,domain:p.domain,published:p.date,excerpt:p.excerpt.slice(0,650)}))}));
    const prompt="You are Ash's evidence auditor. Assess each candidate using ONLY supplied source excerpts. Do not invent tipster opinions, injuries, lineups or facts. Distinguish explicit predictions from news. Compare independent public tipster/pundit views, identify consensus and disagreement, and say when coverage is weak. Return ONLY JSON: {matches:[{matchId,decision:'SUPPORT'|'CONFLICT'|'INSUFFICIENT',confidence:0-100,tipsterConsensus,contraryViews,teamNews,reason}]} . SUPPORT only when multiple independent sources explicitly support the candidate side and there is no material unresolved contradiction. CONFLICT when credible reporting points against it. Otherwise INSUFFICIENT. Never use bookmaker favourite status as expert consensus. Candidate picks: "+JSON.stringify(candidates.map(p=>({id:p.id,fixture:p.home_team+" vs "+p.away_team,proposedSelection:p.selection,competition:p.competition})))+" Evidence: "+JSON.stringify(evidence).slice(0,11500);
    const response=await fetch("https://api.groq.com/openai/v1/chat/completions",{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+groqKey},body:JSON.stringify({model:process.env.ASH_GROQ_MODEL||"openai/gpt-oss-120b",messages:[{role:"system",content:"Be conservative, source-grounded and concise. Output valid JSON only."},{role:"user",content:prompt}],temperature:0.1,max_tokens:900}),signal:timeout(45000)});
    if(!response.ok)throw Error("Groq research synthesis HTTP "+response.status);
    const body=await response.json(),content=body.choices?.[0]?.message?.content||"";
    const jsonText=content.slice(content.indexOf("{"),content.lastIndexOf("}")+1);
    const parsed=JSON.parse(jsonText);
    const analyses=Array.isArray(parsed.matches)?parsed.matches:[];
    const byId=new Map(analyses.map(x=>[String(x.matchId),x]));
    for(const report of reports){
     const analysis=byId.get(String(report.matchId));
     if(analysis)report.analysis={decision:["SUPPORT","CONFLICT","INSUFFICIENT"].includes(analysis.decision)?analysis.decision:"INSUFFICIENT",confidence:Math.max(0,Math.min(100,Number(analysis.confidence)||0)),tipsterConsensus:String(analysis.tipsterConsensus||"Not established").slice(0,500),contraryViews:String(analysis.contraryViews||"Not established").slice(0,400),teamNews:String(analysis.teamNews||"Not verified").slice(0,400),reason:String(analysis.reason||"Insufficient source-grounded analysis").slice(0,500)};
    }
    console.log("[ash-daily-research-synthesis]",JSON.stringify({matches:reports.length,analysed:analyses.length,model:process.env.ASH_GROQ_MODEL||"openai/gpt-oss-120b"}));
   }catch(error){console.error("[ash-daily-research-synthesis]",String(error?.message||error).slice(0,180));}
  }else console.warn("[ash-daily-research-synthesis] skipped: Groq key missing or no candidates");
  return reports;
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
 return {configureWebhook,handleUpdate,verifySecret,researchDailyPicks};
}
