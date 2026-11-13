const LEAGUES = [
  ["soccer","eng.1","Premier League"],["soccer","esp.1","La Liga"],
  ["soccer","ger.1","Bundesliga"],["soccer","ita.1","Serie A"],
  ["soccer","fra.1","Ligue 1"],["soccer","uefa.champions","UEFA Champions League"],
  ["soccer","uefa.europa","UEFA Europa League"],["soccer","usa.1","MLS"],
  ["soccer","mex.1","Liga MX"],["soccer","bra.1","Brazil Serie A"],
  ["soccer","arg.1","Argentina Primera"],["basketball","nba","NBA"]
];
const TENNIS = [["atp","ATP"],["wta","WTA"]];
const ymd = d => d.toISOString().slice(0,10).replace(/-/g,"");
function normalizeParticipant(value) {
  return String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}
export function mapScoreToFixture(event, fixture, maxHours = 6) {
  if (!event || !fixture || event.sport !== fixture.sport) return null;
  const eventTime = new Date(event.startsAt).getTime();
  const fixtureTime = new Date(fixture.starts_at).getTime();
  if (!Number.isFinite(eventTime) || !Number.isFinite(fixtureTime) ||
      Math.abs(eventTime - fixtureTime) > maxHours * 60 * 60 * 1000) return null;
  const eventHome = normalizeParticipant(event.home);
  const eventAway = normalizeParticipant(event.away);
  const fixtureHome = normalizeParticipant(fixture.home_or_player_one);
  const fixtureAway = normalizeParticipant(fixture.away_or_player_two);
  if (!eventHome || !eventAway || !fixtureHome || !fixtureAway) return null;
  if (eventHome === fixtureHome && eventAway === fixtureAway) {
    return { homeScore: event.homeScore, awayScore: event.awayScore, reversed: false };
  }
  if (eventHome === fixtureAway && eventAway === fixtureHome) {
    return { homeScore: event.awayScore, awayScore: event.homeScore, reversed: true };
  }
  return null;
}
const validScore = value => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[^0-9.-]/g,""));
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
};
function statusOf(value) {
  const state = String(value?.state || "").toLowerCase();
  const detail = String(value?.description || value?.detail || value?.name || "").toLowerCase();
  if (/cancel/.test(detail)) return "cancelled";
  if (/postpon/.test(detail)) return "postponed";
  if (state === "post" || /final|retired|walkover/.test(detail)) return "completed";
  if (state === "in") return "in_progress";
  return "scheduled";
}
function rowsFromStandard(payload, league, sport, competition) {
  const out = [];
  for (const event of Array.isArray(payload?.events) ? payload.events : []) {
    const comp = event?.competitions?.[0];
    const competitors = Array.isArray(comp?.competitors) ? comp.competitors : [];
    const home = competitors.find(x => x.homeAway === "home") || competitors[0];
    const away = competitors.find(x => x.homeAway === "away") || competitors[1];
    if (!event?.id || !home?.team?.displayName || !away?.team?.displayName) continue;
    const status = statusOf(comp?.status?.type || event?.status?.type);
    if (!["completed","in_progress"].includes(status)) continue;
    const startsAt = event.date || comp?.date;
    const homeScore = validScore(home.score), awayScore = validScore(away.score);
    if (homeScore === null || awayScore === null) continue;
    out.push({
      id: "espn:" + league + ":" + event.id, sport, competition,
      home: home.team.displayName, away: away.team.displayName,
      startsAt, status, homeScore, awayScore,
      clock: String(comp?.status?.displayClock || ""),
      period: String(comp?.status?.period || "")
    });
  }
  return out;
}
function rowsFromTennis(payload, tour) {
  const out = [];
  for (const tournament of Array.isArray(payload?.events) ? payload.events : []) {
    for (const group of (Array.isArray(tournament?.groupings) ? tournament.groupings : [])) {
      if (!/singles/i.test(String(group?.grouping?.displayName || ""))) continue;
      for (const match of (Array.isArray(group?.competitions) ? group.competitions : [])) {
        const competitors = [...(match?.competitors || [])].sort((a,b) => (Number(a?.order)||99)-(Number(b?.order)||99));
        const a = competitors[0], b = competitors[1];
        const home = a?.athlete?.displayName || a?.athlete?.fullName;
        const away = b?.athlete?.displayName || b?.athlete?.fullName;
        if (!match?.id || !home || !away) continue;
        const status = statusOf(match?.status?.type);
        if (!["completed","in_progress"].includes(status)) continue;
        const homeScore = validScore(a?.score), awayScore = validScore(b?.score);
        if (homeScore === null || awayScore === null) continue;
        const comp = [tournament?.name || tour, group?.grouping?.displayName, match?.round?.displayName].filter(Boolean).join(" · ");
        out.push({
          id: "espn:tennis:" + tour.toLowerCase() + ":" + match.id,
          sport: "tennis", competition: comp, home, away,
          startsAt: match.date || match.startDate, status, homeScore, awayScore,
          clock: "", period: ""
        });
      }
    }
  }
  return out;
}
async function getJson(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "AshSportsFixtureResults/1.0" },
    signal: AbortSignal.timeout(12000)
  });
  const body = await response.text();
  if (!response.ok) {
    const detail = body.replace(/\\s+/g, " ").slice(0, 180);
    throw new Error("ESPN HTTP " + response.status + " " + detail);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("ESPN returned invalid JSON: " + body.replace(/\\s+/g, " ").slice(0, 180));
  }
}
async function sendOutbox(db, telegram, limit=30) {
  const rows = await db.query(`SELECT id,match_id,kind,payload FROM ash_fixture_telegram_notifications
    WHERE status IN ('pending','failed','sending') AND (updated_at IS NULL OR updated_at < now()-interval '2 minutes')
    ORDER BY created_at ASC LIMIT $1`, [limit]);
  let sent=0, failed=0;
  for (const row of rows.rows) {
    const claim = await db.query(`UPDATE ash_fixture_telegram_notifications SET status='sending',updated_at=now()
      WHERE id=$1 AND status IN ('pending','failed','sending') AND (updated_at IS NULL OR updated_at < now()-interval '2 minutes')
      RETURNING id`, [row.id]);
    if (!claim.rowCount) continue;
    try {
      await telegram(row.payload);
      await db.query("UPDATE ash_fixture_telegram_notifications SET status='sent',sent_at=now(),updated_at=now() WHERE id=$1", [row.id]);
      sent++;
    } catch (error) {
      await db.query("UPDATE ash_fixture_telegram_notifications SET status='failed',updated_at=now(),last_error=$2 WHERE id=$1",
        [row.id, String(error?.message || error).slice(0,240)]);
      failed++;
    }
  }
  return {sent,failed};
}
export async function runFixtureResultNotifications(db, telegram, {now=new Date(),fetchImpl=fetch,concurrency=4}={}) {
  await db.query(`CREATE TABLE IF NOT EXISTS ash_fixture_telegram_notifications(
    id bigserial PRIMARY KEY,match_id text NOT NULL,kind text NOT NULL,fingerprint text NOT NULL,
    payload text NOT NULL,status text NOT NULL DEFAULT 'pending',created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz,sent_at timestamptz,last_error text,
    UNIQUE(match_id,kind,fingerprint)
  )`);
  const from = new Date(now.getTime()-48*60*60*1000), to = now;
  // ESPN Site API no longer reliably accepts YYYYMMDD-YYYYMMDD ranges.
  // Fetch each calendar day separately and deduplicate event IDs.
  const dates=[];
  for (let day=new Date(Date.UTC(from.getUTCFullYear(),from.getUTCMonth(),from.getUTCDate()));
       day<=to; day=new Date(day.getTime()+24*60*60*1000)) dates.push(ymd(day));
  const jobs = [
    ...LEAGUES.map(([sport,league,name]) => async () => {
      const rows=[];
      for (const date of dates) {
        const url = "https://site.api.espn.com/apis/site/v2/sports/"+sport+"/"+league+"/scoreboard?dates="+date;
        rows.push(...rowsFromStandard(await getJson(url,fetchImpl),league,sport==="soccer"?"football":"basketball",name));
      }
      return [...new Map(rows.map(row=>[row.id,row])).values()];
    }),
    ...TENNIS.map(([tour]) => async () => {
      const rows=[];
      for (const date of dates) {
        const url = "https://site.api.espn.com/apis/site/v2/sports/tennis/"+tour+"/scoreboard?dates="+date;
        rows.push(...rowsFromTennis(await getJson(url,fetchImpl),tour));
      }
      return [...new Map(rows.map(row=>[row.id,row])).values()];
    })
  ];
  const results=[], errors=[];
  const width=Math.max(1,Math.min(6,concurrency));
  for(let offset=0;offset<jobs.length;offset+=width) {
    const batch=await Promise.allSettled(jobs.slice(offset,offset+width).map(fn=>fn()));
    for(const result of batch) {
      if(result.status==="fulfilled") results.push(...result.value);
      else errors.push(String(result.reason?.message||result.reason).slice(0,160));
    }
  }
  let updated=0, queuedFinal=0, queuedLive=0;
  for(const event of results) {
    let saved=await db.query(`UPDATE sports_matches SET status=$2,home_score=$3,away_score=$4,
      source_updated_at=now(),updated_at=now()
      WHERE id=$1 RETURNING id,sport,competition,home_or_player_one,away_or_player_two`,
      [event.id,event.status,event.homeScore,event.awayScore]);
    // Bookmaker-created fixtures have their own public-scrape IDs, not ESPN IDs.
    // Match only an exact participant pair in the same sport near the scheduled kickoff.
    if(!saved.rowCount) {
      const candidates=await db.query(`SELECT id,sport,starts_at,competition,home_or_player_one,away_or_player_two
        FROM sports_matches WHERE sport=$1
          AND starts_at BETWEEN $2::timestamptz-interval '6 hours' AND $2::timestamptz+interval '6 hours'
          AND status NOT IN ('cancelled','postponed') LIMIT 50`,[event.sport,event.startsAt]);
      const matched=candidates.rows.map(fixture=>({
        fixture, score:mapScoreToFixture(event,fixture),
        distance:Math.abs(new Date(fixture.starts_at).getTime()-new Date(event.startsAt).getTime())
      })).filter(item=>item.score).sort((a,b)=>a.distance-b.distance);
      const best=matched[0];
      // Refuse ambiguous duplicate fixtures rather than attaching a score to the wrong event.
      if(best && (!matched[1] || matched[1].distance-best.distance>=60*60*1000)) {
        saved=await db.query(`UPDATE sports_matches SET status=$2,home_score=$3,away_score=$4,
          source_updated_at=now(),updated_at=now() WHERE id=$1
          RETURNING id,sport,competition,home_or_player_one,away_or_player_two`,
          [best.fixture.id,event.status,best.score.homeScore,best.score.awayScore]);
      }
    }
    if(!saved.rowCount) continue;
    updated++;
    const fixture=saved.rows[0];
    const isFinal=event.status==="completed";
    const kind=isFinal?"final":"live";
    const fingerprint=isFinal?"final:"+event.homeScore+":"+event.awayScore:
      "live:"+event.homeScore+":"+event.awayScore;
    const label=isFinal?"FINAL RESULT":"LIVE SCORE";
    const payload="ASH • "+label+"\n"+fixture.home_or_player_one+" "+event.homeScore+" - "+event.awayScore+" "+fixture.away_or_player_two+
      "\n"+fixture.competition+" • "+String(fixture.sport).toUpperCase()+
      (isFinal?"\nStatus: verified final score":"\nStatus: in progress")+
      "\nSource: ESPN scoreboard";
    const inserted=await db.query(`INSERT INTO ash_fixture_telegram_notifications(match_id,kind,fingerprint,payload)
      VALUES($1,$2,$3,$4) ON CONFLICT(match_id,kind,fingerprint) DO NOTHING RETURNING id`,
      [event.id,kind,fingerprint,payload]);
    if(inserted.rowCount) { if(isFinal)queuedFinal++; else queuedLive++; }
  }
  const delivery=await sendOutbox(db,telegram);
  return {provider:"ESPN scoreboard",eventsWithScores:results.length,fixturesUpdated:updated,
    finalNotificationsQueued:queuedFinal,liveUpdatesQueued:queuedLive,delivery,errors};
}
export const __test = { validScore, statusOf, rowsFromStandard, rowsFromTennis, mapScoreToFixture };
