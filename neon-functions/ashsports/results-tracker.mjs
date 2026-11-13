export function parseFinalScore(event, homeTeam, awayTeam) {
  if (!event || event.completed !== true || !Array.isArray(event.scores) || event.scores.length < 2) return null;
  const norm = value => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const scores = new Map(event.scores.filter(row => String(row.score ?? "").trim() !== "").map(row => [norm(row.name), Number(row.score)]));
  const home = scores.get(norm(homeTeam));
  const away = scores.get(norm(awayTeam));
  if (!Number.isFinite(home) || !Number.isFinite(away) || home < 0 || away < 0) return null;
  return { homeScore: home, awayScore: away };
}
export function settleHeadToHead(selection, homeTeam, awayTeam, homeScore, awayScore) {
  const norm = value => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const chosen = norm(selection);
  if (!chosen || !Number.isFinite(Number(homeScore)) || !Number.isFinite(Number(awayScore))) return null;
  if (chosen === norm(homeTeam)) return Number(homeScore) > Number(awayScore) ? "won" : "lost";
  if (chosen === norm(awayTeam)) return Number(awayScore) > Number(homeScore) ? "won" : "lost";
  return null;
}

export function orientScoreToTip(tipHome, tipAway, fixtureHome, fixtureAway, fixtureHomeScore, fixtureAwayScore) {
  const norm = value => String(value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const th = norm(tipHome), ta = norm(tipAway), fh = norm(fixtureHome), fa = norm(fixtureAway);
  const home = Number(fixtureHomeScore), away = Number(fixtureAwayScore);
  if (!th || !ta || !fh || !fa || !Number.isFinite(home) || !Number.isFinite(away)) return null;
  if (th === fh && ta === fa) return { homeScore: home, awayScore: away };
  if (th === fa && ta === fh) return { homeScore: away, awayScore: home };
  return null;
}

export function overdueFixtureThresholdHours(sport) {
  const key = String(sport || "").trim().toLowerCase();
  if (key === "football") return 3;
  if (key === "basketball") return 4;
  if (key === "tennis") return 10;
  return 6;
}
export function shouldMoveFixtureToAwaitingResult({ sport, startsAt, now = new Date(), status = "scheduled", homeScore = null, awayScore = null }) {
  if (status !== "scheduled" || homeScore != null || awayScore != null) return false;
  const start = new Date(startsAt).getTime();
  const current = new Date(now).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(current)) return false;
  return current - start >= overdueFixtureThresholdHours(sport) * 3600000;
}
