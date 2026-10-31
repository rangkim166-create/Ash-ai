import postgres from "postgres";
import { createHash } from "node:crypto";

const sql = postgres(process.env.DATABASE_URL, { max: 2, connect_timeout: 10 });
const ROOT = "https://raw.githubusercontent.com/openfootball/football.json/master";
const LEAGUES = [
  ["en.1", "English Premier League"],
  ["en.2", "English Championship"],
  ["de.1", "German Bundesliga"],
  ["es.1", "Spanish La Liga"],
  ["it.1", "Italian Serie A"],
  ["fr.1", "French Ligue 1"]
];

function seasonNames() {
  const out = [];
  for (let y = 2010; y <= 2025; y++) out.push(`${y}-${String(y + 1).slice(-2)}`);
  return out;
}

export async function importPublicFootballHistory() {
  await sql`
    CREATE TABLE IF NOT EXISTS public_history_imports (
      source_path text PRIMARY KEY,
      imported_matches integer NOT NULL DEFAULT 0,
      imported_at timestamptz NOT NULL DEFAULT now()
    )
  `;
  const doneRows = await sql`SELECT source_path FROM public_history_imports WHERE imported_matches > 0`;
  const done = new Set(doneRows.map(r => r.source_path));
  const jobs = seasonNames().flatMap(season =>
    LEAGUES.map(([code]) => `${season}/${code}.json`)
  ).filter(path => !done.has(path));

  let filesImported = 0, matchesImported = 0, filesMissing = 0, errors = [];
  for (let i = 0; i < jobs.length; i += 4) {
    const batch = jobs.slice(i, i + 4);
    const results = await Promise.all(batch.map(async path => {
      try {
        const response = await fetch(`${ROOT}/${path}`, { signal: AbortSignal.timeout(20000) });
        if (response.status === 404) return { path, missing: true };
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const competition = String(payload.name || path.split("/")[1]).slice(0, 180);
        const matches = (payload.matches || []).flatMap((m, index) => {
          const ft = Array.isArray(m.score) ? m.score : m.score?.ft;
          if (!m.date || !m.team1 || !m.team2 || !Array.isArray(ft) ||
              !Number.isInteger(Number(ft[0])) || !Number.isInteger(Number(ft[1]))) return [];
          const date = String(m.date);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
          const kickoff = m.time && /^\d{2}:\d{2}$/.test(m.time) ? m.time : "12:00";
          const matchId = "history:openfootball:" + createHash("sha1")
            .update(path + "|" + date + "|" + m.team1 + "|" + m.team2).digest("hex");
          return [{
            id: matchId, competition, home: String(m.team1).slice(0, 180),
            away: String(m.team2).slice(0, 180), starts: date + "T" + kickoff + ":00Z",
            home_score: Number(ft[0]), away_score: Number(ft[1])
          }];
        });
        return { path, competition, matches };
      } catch (error) {
        return { path, error: String(error?.message || error).slice(0, 180) };
      }
    }));
    for (const result of results) {
      if (result.missing) { filesMissing++; continue; }
      if (result.error) { errors.push({ path: result.path, error: result.error }); continue; }
      const rows = result.matches || [];
      if (rows.length) {
        await sql`
          INSERT INTO sports_matches
            (id, sport, competition, home_or_player_one, away_or_player_two,
             starts_at, status, home_score, away_score, source, source_updated_at, updated_at)
          SELECT x.id, 'football', x.competition, x.home, x.away,
                 x.starts::timestamptz, 'completed', x.home_score, x.away_score,
                 'openfootball', now(), now()
          FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(
            id text, competition text, home text, away text, starts text,
            home_score integer, away_score integer
          )
          ON CONFLICT (id) DO UPDATE SET
            competition = EXCLUDED.competition,
            home_or_player_one = EXCLUDED.home_or_player_one,
            away_or_player_two = EXCLUDED.away_or_player_two,
            starts_at = EXCLUDED.starts_at, status = 'completed',
            home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score,
            source = 'openfootball', source_updated_at = now(), updated_at = now()
        `;
      }
      await sql`INSERT INTO public_history_imports(source_path, imported_matches)
        VALUES (${result.path}, ${rows.length})
        ON CONFLICT (source_path) DO UPDATE SET
          imported_matches = EXCLUDED.imported_matches, imported_at = now()`;
      filesImported++;
      matchesImported += rows.length;
    }
    console.log("[ash-history] batch", JSON.stringify({
      processed: Math.min(i + 4, jobs.length), total: jobs.length,
      filesImported, matchesImported, filesMissing, errors: errors.length
    }));
  }
  await sql.end({ timeout: 5 });
  return { source: "openfootball CC0", filesAttempted: jobs.length, filesImported,
    matchesImported, filesMissing, errors: errors.slice(0, 20), complete: errors.length === 0 };
}
