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
export function buildEspnScoreboardUrl(sport,league,from,to) {
  return "https://site.api.espn.com/apis/site/v2/sports/"+encodeURIComponent(sport)+"/"+encodeURIComponent(league)+"/scoreboard?dates="+ymd(from)+"-"+ymd(to);
}
export function buildEspnTennisScoreboardUrl(tour,from,to) {
  return "https://site.api.espn.com/apis/site/v2/sports/tennis/"+encodeURIComponent(tour)+"/scoreboard?dates="+ymd(from)+"-"+ymd(to);
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
    rows.push({
      id:"espn:"+league+":"+event.id,sport,competition:competition||event?.season?.name||league,
      home:home.team.displayName,away:away.team.displayName,startsAt:new Date(startsAt).toISOString(),
      status:eventStatus(comp?.status?.type||event.status?.type)
    });
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
      // Odds and player-form models are singles-oriented; do not mislabel doubles pairs as individual players.
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
        rows.push({
          id:"espn:tennis:"+String(tour||"tour").toLowerCase()+":"+match.id,
          sport:"tennis",
          competition:[tournamentName,draw,round].filter(Boolean).join(" · "),
          home:playerOne,away:playerTwo,startsAt:new Date(startsAt).toISOString(),
          status:eventStatus(match?.status?.type)
        });
      }
    }
  }
  return rows;
}
async function fetchScoreboard(entry,{from,to,fetchImpl=fetch,now=new Date()}){
  const [sport,league,competition]=entry;
  const response=await fetchImpl(buildEspnScoreboardUrl(sport,league,from,to),{
    headers:{"accept":"application/json","user-agent":"AshSportsFixtureDiscovery/1.0"},
    signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw new Error("ESPN "+league+" HTTP "+response.status);
  return normalizeEspnEvents(await response.json(),{sport:sport==="soccer"?"football":"basketball",league,competition,now});
}
async function fetchTennisScoreboard(entry,{from,to,fetchImpl=fetch,now=new Date()}){
  const [tour,label]=entry;
  const response=await fetchImpl(buildEspnTennisScoreboardUrl(tour,from,to),{
    headers:{"accept":"application/json","user-agent":"AshSportsFixtureDiscovery/1.0"},
    signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw new Error("ESPN tennis "+tour+" HTTP "+response.status);
  return normalizeEspnTennisEvents(await response.json(),{tour:label,now});
}
export async function discoverPublicFixtures(db,{now=new Date(),fetchImpl=fetch,leagues=LEAGUES,tennisTours=TENNIS_TOURS,concurrency=4}={}){
  const from=new Date(now.getTime()-12*60*60*1000),to=new Date(now.getTime()+14*86400000);
  const results=[],errors=[];
  const width=Math.max(1,Math.min(6,concurrency));
  for(let offset=0;offset<leagues.length;offset+=width){
    const batch=await Promise.allSettled(leagues.slice(offset,offset+width).map(entry=>fetchScoreboard(entry,{from,to,fetchImpl,now})));
    for(let i=0;i<batch.length;i++){
      const result=batch[i],entry=leagues[offset+i];
      if(result.status==="fulfilled")results.push(...result.value);
      else errors.push({league:entry[1],error:String(result.reason?.message||result.reason).slice(0,180)});
    }
  }
  const tennisResults=await Promise.allSettled(tennisTours.map(entry=>fetchTennisScoreboard(entry,{from,to,fetchImpl,now})));
  for(let i=0;i<tennisResults.length;i++){
    const result=tennisResults[i],entry=tennisTours[i];
    if(result.status==="fulfilled")results.push(...result.value);
    else errors.push({league:"tennis:"+entry[0],error:String(result.reason?.message||result.reason).slice(0,180)});
  }
  let inserted=0;
  for(const fixture of results){
    const saved=await db.query(`INSERT INTO sports_matches(id,sport,competition,home_or_player_one,away_or_player_two,starts_at,status,source,source_updated_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7,'espn_public_schedule',now(),now())
      ON CONFLICT(id) DO UPDATE SET competition=EXCLUDED.competition,home_or_player_one=EXCLUDED.home_or_player_one,
      away_or_player_two=EXCLUDED.away_or_player_two,starts_at=EXCLUDED.starts_at,status=EXCLUDED.status,
      source_updated_at=now(),updated_at=now()
      RETURNING id`,[fixture.id,fixture.sport,fixture.competition,fixture.home,fixture.away,fixture.startsAt,fixture.status]);
    inserted+=saved.rowCount;
  }
  return {provider:"ESPN public scoreboard",eventsFound:results.length,fixturesUpserted:inserted,leaguesAttempted:leagues.length,tennisToursAttempted:tennisTours.length,errors};
}
