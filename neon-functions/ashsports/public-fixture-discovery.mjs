const LEAGUES = [
  ["soccer","eng.1","Premier League"],["soccer","esp.1","La Liga"],
  ["soccer","ger.1","Bundesliga"],["soccer","ita.1","Serie A"],
  ["soccer","fra.1","Ligue 1"],["soccer","uefa.champions","UEFA Champions League"],
  ["soccer","uefa.europa","UEFA Europa League"],["soccer","usa.1","MLS"],
  ["soccer","mex.1","Liga MX"],["soccer","bra.1","Brazil Serie A"],
  ["soccer","arg.1","Argentina Primera"],["basketball","nba","NBA"]
];
const ymd = date => date.toISOString().slice(0,10).replace(/-/g,"");
export function buildEspnScoreboardUrl(sport,league,from,to) {
  return "https://site.api.espn.com/apis/site/v2/sports/"+encodeURIComponent(sport)+"/"+encodeURIComponent(league)+"/scoreboard?dates="+ymd(from)+"-"+ymd(to);
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
    if(!event.id||!home?.team?.displayName||!away?.team?.displayName||!Number.isFinite(startsAt))continue;
    if(startsAt<now.getTime()-12*60*60*1000||startsAt>now.getTime()+14*86400000)continue;
    const state=String(comp?.status?.type?.state||event.status?.type?.state||"").toLowerCase();
    const detail=String(comp?.status?.type?.name||event.status?.type?.name||"").toLowerCase();
    const status=state==="post"||/final/.test(detail)?"completed":/cancel/.test(detail)?"cancelled":/postpon/.test(detail)?"postponed":"scheduled";
    rows.push({
      id:"espn:"+league+":"+event.id,sport,competition:competition||event?.season?.name||league,
      home:home.team.displayName,away:away.team.displayName,startsAt:new Date(startsAt).toISOString(),status
    });
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
export async function discoverPublicFixtures(db,{now=new Date(),fetchImpl=fetch,leagues=LEAGUES,concurrency=4}={}){
  const from=new Date(now.getTime()-12*60*60*1000),to=new Date(now.getTime()+14*86400000);
  const results=[],errors=[];
  for(let offset=0;offset<leagues.length;offset+=Math.max(1,Math.min(6,concurrency))){
    const batch=await Promise.allSettled(leagues.slice(offset,offset+Math.max(1,Math.min(6,concurrency))).map(entry=>fetchScoreboard(entry,{from,to,fetchImpl,now})));
    for(let i=0;i<batch.length;i++){
      const result=batch[i],entry=leagues[offset+i];
      if(result.status==="fulfilled")results.push(...result.value);
      else errors.push({league:entry[1],error:String(result.reason?.message||result.reason).slice(0,180)});
    }
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
  return {provider:"ESPN public scoreboard",eventsFound:results.length,fixturesUpserted:inserted,leaguesAttempted:leagues.length,errors};
}
