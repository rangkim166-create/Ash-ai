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

const WORLD_FILES = [
  "africa/algeria/2023-24_dz1.txt","africa/algeria/2024-25_dz1.txt",
  "africa/egypt/2023-24_eg1.txt","africa/egypt/2024-25_eg1.txt",
  "africa/morocco/2023-24_ma1.txt","africa/morocco/2024-25_ma1.txt",
  "africa/nigeria/2009-10_ng1.txt","africa/nigeria/2010-11_ng1.txt","africa/nigeria/2011-12_ng1.txt",
  "africa/nigeria/2012-13_ng1.txt","africa/nigeria/2013-14_ng1.txt","africa/nigeria/2014-15_ng1.txt",
  "africa/nigeria/2015-16_ng1.txt","africa/nigeria/2016-17_ng1.txt","africa/nigeria/2017-18_ng1.txt",
  "africa/nigeria/2017-18_ng2.txt","africa/nigeria/2018-19_ng1.txt","africa/nigeria/2018-19_ng2.txt",
  "africa/nigeria/2020-21_ng1.txt","africa/nigeria/2020-21_ng2.txt","africa/nigeria/2021-22_ng1.txt",
  "africa/nigeria/2021-22_ng2.txt","africa/nigeria/2022-23_ng1.txt","africa/nigeria/2022-23_ng2.txt",
  "africa/nigeria/2023-24_ng1.txt","africa/nigeria/2023-24_ng2.txt","africa/nigeria/2024-25_ng1.txt",
  "africa/nigeria/2024-25_ng2.txt","africa/nigeria/2025-26_ng1.txt","africa/nigeria/2025-26_ng2.txt",
  "middle-east/saudi-arabia/2024-25_sa1.txt"
];

function parseWorldDate(line, seasonStart) {
  const iso = line.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return iso[1] + "-" + String(iso[2]).padStart(2, "0") + "-" + String(iso[3]).padStart(2, "0");
  const named = line.match(/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?([A-Za-z]{3,9})\s+(\d{1,2})(?:,?\s+((?:19|20)\d{2}))?$/i);
  if (named) {
    const months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
    const month = months[named[1].slice(0,3).toLowerCase()];
    if (!month) return null;
    const year = named[3] ? Number(named[3]) : seasonStart + (month <= 6 ? 1 : 0);
    return String(year) + "-" + String(month).padStart(2, "0") + "-" + String(Number(named[2])).padStart(2, "0");
  }
  const numeric = line.match(/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+)?(\d{1,2})[./](\d{1,2})\.?$/i);
  if (numeric) {
    const day = Number(numeric[1]), month = Number(numeric[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const year = seasonStart + (month <= 6 ? 1 : 0);
    return String(year) + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
  }
  return null;
}

function parseWorldText(body, sourcePath) {
  const lines = body.split(/\r?\n/);
  const parts = sourcePath.split("/");
  const country = (parts[1] || "unknown").replace(/-/g, " ").replace(/\b\w/g, x => x.toUpperCase());
  const seasonMatch = sourcePath.match(/((?:19|20)\d{2})-(\d{2})/);
  const seasonStart = seasonMatch ? Number(seasonMatch[1]) : 2024;
  const header = lines.find(line => line.trim().startsWith("="))?.trim().replace(/^=\s*/, "") || "";
  let league = header;
  if (header.includes("|")) league = header.split("|").slice(1).join("|").trim();
  else if (header.toLowerCase().startsWith(country.toLowerCase())) league = header.slice(country.length).trim();
  const competition = (country + " " + league).trim().slice(0, 180);
  let currentDate = null;
  const matches = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("=") || line.startsWith("▪") || line.startsWith("::") || line.startsWith("(")) continue;
    const parsedDate = parseWorldDate(line, seasonStart);
    if (parsedDate) { currentDate = parsedDate; continue; }
    if (!currentDate) continue;
    const match = line.match(/^(?:(\d{1,2}:\d{2})\s+)?(.+?)\s+v(?:s\.?)?\s+(.+?)\s+(\d{1,2})-(\d{1,2})(?:\s+\([^)]*\))?(?:\s+@.*)?$/i);
    if (!match) continue;
    const home = match[2].replace(/\s+/g, " ").trim();
    const away = match[3].replace(/\s+/g, " ").trim();
    if (!home || !away || home.toLowerCase() === away.toLowerCase()) continue;
    matches.push({competition, home:home.slice(0,180), away:away.slice(0,180),
      starts:currentDate + "T12:00:00Z", home_score:Number(match[4]), away_score:Number(match[5])});
  }
  return matches;
}

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
  const doneRows = await sql`SELECT source_path FROM public_history_imports WHERE imported_matches > 0 OR imported_at > now() - interval '7 days'`;
  const done = new Set(doneRows.map(r => r.source_path));
  const jobs = seasonNames().flatMap(season =>
    LEAGUES.map(([code]) => `${season}/${code}.json`)
  ).filter(path => !done.has(path));

  let filesImported = 0, matchesImported = 0, filesMissing = 0, errors = [], missingPaths = [];
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
      if (result.missing) {
        filesMissing++;
        missingPaths.push(result.path);
        await sql`INSERT INTO public_history_imports(source_path, imported_matches)
          VALUES (${result.path}, 0)
          ON CONFLICT (source_path) DO UPDATE SET imported_matches = 0, imported_at = now()`;
        continue;
      }
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
          FROM jsonb_to_recordset(${sql.json(rows)}::jsonb) AS x(
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
  let worldFilesImported = 0, worldMatchesImported = 0;
  const worldJobs = WORLD_FILES.filter(path => !done.has("world/" + path));
  for (let i = 0; i < worldJobs.length; i += 4) {
    const batch = worldJobs.slice(i, i + 4);
    const results = await Promise.all(batch.map(async path => {
      try {
        const response = await fetch("https://raw.githubusercontent.com/openfootball/world/master/" + path,
          { signal: AbortSignal.timeout(20000) });
        if (response.status === 404) return { path, missing: true };
        if (!response.ok) throw new Error("HTTP " + response.status);
        return { path, matches: parseWorldText(await response.text(), path) };
      } catch (error) {
        return { path, error: String(error?.message || error).slice(0, 180) };
      }
    }));
    for (const result of results) {
      if (result.missing) {
        filesMissing++;
        missingPaths.push('world/' + result.path);
        await sql`INSERT INTO public_history_imports(source_path, imported_matches)
          VALUES (${'world/' + result.path}, 0)
          ON CONFLICT (source_path) DO UPDATE SET imported_matches = 0, imported_at = now()`;
        continue;
      }
      if (result.error) { errors.push({ path: result.path, error: result.error }); continue; }
      const rows = result.matches || [];
      if (rows.length) {
        const enriched = rows.map(row => ({
          id: "history:openfootball-world:" + createHash("sha1")
            .update(result.path + "|" + row.starts + "|" + row.home + "|" + row.away).digest("hex"),
          ...row
        }));
        await sql`
          INSERT INTO sports_matches
            (id, sport, competition, home_or_player_one, away_or_player_two,
             starts_at, status, home_score, away_score, source, source_updated_at, updated_at)
          SELECT x.id, 'football', x.competition, x.home, x.away,
                 x.starts::timestamptz, 'completed', x.home_score, x.away_score,
                 'openfootball_world', now(), now()
          FROM jsonb_to_recordset(${sql.json(enriched)}::jsonb) AS x(
            id text, competition text, home text, away text, starts text,
            home_score integer, away_score integer
          )
          ON CONFLICT (id) DO UPDATE SET
            competition = EXCLUDED.competition,
            home_or_player_one = EXCLUDED.home_or_player_one,
            away_or_player_two = EXCLUDED.away_or_player_two,
            starts_at = EXCLUDED.starts_at, status = 'completed',
            home_score = EXCLUDED.home_score, away_score = EXCLUDED.away_score,
            source = 'openfootball_world', source_updated_at = now(), updated_at = now()
        `;
      }
      await sql`INSERT INTO public_history_imports(source_path, imported_matches)
        VALUES (${"world/" + result.path}, ${rows.length})
        ON CONFLICT (source_path) DO UPDATE SET
          imported_matches = EXCLUDED.imported_matches, imported_at = now()`;
      worldFilesImported++;
      worldMatchesImported += rows.length;
    }
    console.log("[ash-history] regional batch", JSON.stringify({
      processed: Math.min(i + 4, worldJobs.length), total: worldJobs.length,
      worldFilesImported, worldMatchesImported, filesMissing, errors: errors.length
    }));
  }
  await sql.end({ timeout: 5 });
  return { source: "openfootball CC0 + OpenFootball world CC0", filesAttempted: jobs.length + worldJobs.length,
    filesImported, matchesImported, worldFilesImported, worldMatchesImported,
    filesMissing, missingPaths: missingPaths.slice(0, 30), errors: errors.slice(0, 20),
    complete: errors.length === 0 && filesMissing === 0, partial: errors.length > 0 || filesMissing > 0 };
}
