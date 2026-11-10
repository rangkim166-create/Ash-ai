const LEAGUES = [
  ["soccer","eng.1","Premier League"],["soccer","esp.1","La Liga"],
  ["soccer","ger.1","Bundesliga"],["soccer","ita.1","Serie A"],
  ["soccer","fra.1","Ligue 1"],["soccer","uefa.champions","UEFA Champions League"],
  ["soccer","uefa.europa","UEFA Europa League"],["soccer","usa.1","MLS"],
  ["soccer","mex.1","Liga MX"],["soccer","bra.1","Brazil Serie A"],
  ["soccer","arg.1","Argentina Primera"],["basketball","nba","NBA"]
];
const TENNIS_TOURS = [["atp","ATP"],["wta","WTA"]];
const ymd = date => date.toISOString().slice(0,10).replace(/-/g,"");
function calendarDates(from,to) {
  const dates=[];
  for(let day=new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth(),from.getUTCDate()));
      day<=to;day=new Date(day.getTime()+86400000)) dates.push(ymd(day));
  return dates;
}
// ESPN's Site API rejects multi-day date ranges on several scoreboards.
// Keep the date parameter to one UTC calendar day per request.
export function buildEspnScoreboardUrl(sport,league,date) {
  const day=date instanceof Date?ymd(date):String(date).replace(/-/g,"");
  if(!/^\\d{8}$/.test(day)) throw new Error("ESPN scoreboard date must be YYYYMMDD");
  return "https://site.api.espn.com/apis/site/v2/sports/"+encodeURIComponent(sport)+"/"+encodeURIComponent(league)+"/scoreboard?dates="+day;
}
export function buildEspnTennisScoreboardUrl(tour,date) {
  const day=date instanceof Date?ymd(date):String(date).replace(/-/g,"");
  if(!/^\\d{8}$/.test(day)) throw new Error("ESPN tennis scoreboard date must be YYYYMMDD");
  return "https://site.api.espn.com/apis/site/v2/sports/tennis/"+encodeURIComponent(tour)+"/scoreboard?dates="+day;
}
function withinWindow(startsAt,now) {
  return Number.isFinite(startsAt)&&startsAt>=now.getTime()-12*60*60*1000&&startsAt<=now.getTime()+14*86400000;
}
function eventStatus(status) {
  const state=String(status?.state||"").toLowerCase();
  const detail=String(status?.description||status?.detail||status?.name||"").toLowerCase();
  if(/cancel/.test(detail))return "cancelled";
  if(/postpon/.test(detail))return "postponed";
  if(state==="post"||/final|retired|walkover/.test(detail))return "completed";
  if(state==="in")return "in_progress";
  return "scheduled";
}
export function normalizeEspnEvents(payload,{sport,league,competition,now=new Date()}={}) {
  const events=Array.isArray(payload?.events)?payload.events:[];
  const rows=[];
  for(const event of events){
    const comp=event?.competitions?.[0];
    const competitors=Array.isArray(comp?.competitors)?comp.competitors:[];
    const home=competitors.find(x=>x.homeAway==="home")||competitors[0];
    const away=competitors.find(x=>x.homeAway==="away")||competitors[1];
    const startsAt=Date.parse(event.date||comp?.date||"");
    if(!event.id||!home?.team?.displayName||!away?.team?.displayName||!withinWindow(startsAt,now))continue;
    rows.push({id:"espn:"+league+":"+event.id,sport,competition:competition||event?.season?.name||league,
      home:home.team.displayName,away:away.team.displayName,startsAt:new Date(startsAt).toISOString(),
      status:eventStatus(comp?.status?.type||event.status?.type)});
  }
  return rows;
}
export function normalizeEspnTennisEvents(payload,{tour,now=new Date()}={}) {
  const events=Array.isArray(payload?.events)?payload.events:[];
  const rows=[];
  for(const tournament of events){
    const groups=Array.isArray(tournament?.groupings)?tournament.groupings:[];
    for(const group of groups){
      const draw=String(group?.grouping?.displayName||"");
      if(!/singles/i.test(draw))continue;
      const matches=Array.isArray(group?.competitions)?group.competitions:[];
      for(const match of matches){
        const competitors=Array.isArray(match?.competitors)?match.competitors:[];
        const ordered=[...competitors].sort((a,b)=>(Number(a?.order)||99)-(Number(b?.order)||99));
        const playerOne=ordered[0]?.athlete?.displayName||ordered[0]?.athlete?.fullName;
        const playerTwo=ordered[1]?.athlete?.displayName||ordered[1]?.athlete?.fullName;
        const startsAt=Date.parse(match?.date||match?.startDate||"");
        if(!match?.id||!playerOne||!playerTwo||playerOne===playerTwo||!withinWindow(startsAt,now))continue;
        const round=String(match?.round?.displayName||"").trim();
        const tournamentName=String(tournament?.name||tour||"Tennis");
        rows.push({id:"espn:tennis:"+String(tour||"tour").toLowerCase()+":"+match.id,sport:"tennis",
          competition:[tournamentName,draw,round].filter(Boolean).join(" · "),
          home:playerOne,away:playerTwo,startsAt:new Date(startsAt).toISOString(),
          status:eventStatus(match?.status?.type)});
      }
    }
  }
  return rows;
}
async function getJson(url,fetchImpl) {
  const response=await fetchImpl(url,{headers:{"accept":"application/json","user-agent":"AshSportsFixtureDiscovery/1.0"},
    signal:AbortSignal.timeout(12000)});
  const body=await response.text();
  if(!response.ok)throw new Error("ESPN HTTP "+response.status+" "+body.replace(/\\s+/g," ").slice(0,140));
  try{return JSON.parse(body);}catch{throw new Error("ESPN returned invalid JSON: "+body.replace(/\\s+/g," ").slice(0,140));}
}
async function fetchLeagueDays(entry,{dates,fetchImpl,now}) {
  const [sport,league,competition]=entry,rows=[];
  for(const date of dates) {
    const payload=await getJson(buildEspnScoreboardUrl(sport,league,date),fetchImpl);
    rows.push(...normalizeEspnEvents(payload,{sport:sport==="soccer"?"football":"basketball",league,competition,now}));
  }
  return [...new Map(rows.map(row=>[row.id,row])).values()];
}
async function fetchTennisDays(entry,{dates,fetchImpl,now}) {
  const [tour,label]=entry,rows=[];
  for(const date of dates) {
    const payload=await getJson(buildEspnTennisScoreboardUrl(tour,date),fetchImpl);
    rows.push(...normalizeEspnTennisEvents(payload,{tour:label,now}));
  }
  return [...new Map(rows.map(row=>[row.id,row])).values()];
}
export async function discoverPublicFixtures(db,{now=new Date(),fetchImpl=fetch,leagues=LEAGUES,tennisTours=TENNIS_TOURS,concurrency=4}={}) {
  const from=new Date(now.getTime()-12*60*60*1000),to=new Date(now.getTime()+14*86400000);
  const dates=calendarDates(from,to),jobs=[
    ...leagues.map(entry=>({label:entry[1],run:()=>fetchLeagueDays(entry,{dates,fetchImpl,now})})),
    ...tennisTours.map(entry=>({label:"tennis:"+entry[0],run:()=>fetchTennisDays(entry,{dates,fetchImpl,now})}))
  ];
  const results=[],errors=[],width=Math.max(1,Math.min(6,concurrency));
  for(let offset=0;offset<jobs.length;offset+=width) {
    const batch=await Promise.allSettled(jobs.slice(offset,offset+width).map(job=>job.run()));
    for(let i=0;i<batch.length;i++) {
      const result=batch[i],job=jobs[offset+i];
      if(result.status==="fulfilled")results.push(...result.value);
      else errors.push({league:job.label,error:String(result.reason?.message||result.reason).slice(0,180)});
    }
  }
  const unique=[...new Map(results.map(row=>[row.id,row])).values()];
  let inserted=0;
  for(const fixture of unique) {
    const saved=await db.query(`INSERT INTO sports_matches(id,sport,competition,home_or_player_one,away_or_player_two,starts_at,status,source,source_updated_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7,'espn_public_schedule',now(),now())
      ON CONFLICT(id) DO UPDATE SET competition=EXCLUDED.competition,home_or_player_one=EXCLUDED.home_or_player_one,
      away_or_player_two=EXCLUDED.away_or_player_two,starts_at=EXCLUDED.starts_at,status=EXCLUDED.status,
      source_updated_at=now(),updated_at=now()
      RETURNING id`,[fixture.id,fixture.sport,fixture.competition,fixture.home,fixture.away,fixture.startsAt,fixture.status]);
    inserted+=saved.rowCount;
  }
  return {provider:"ESPN public scoreboard",eventsFound:unique.length,fixturesUpserted:inserted,
    leaguesAttempted:leagues.length,tennisToursAttempted:tennisTours.length,datesRequested:dates.length,errors};
}
