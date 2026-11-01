export function parseFinalScore(event, homeTeam, awayTeam) {
  if (!event || event.completed !== true || !Array.isArray(event.scores) || event.scores.length < 2) return null;
  const norm = value => String(value ?? "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const scores = new Map(event.scores.map(row => [norm(row.name), Number(row.score)]));
  const home = scores.get(norm(homeTeam));
  const away = scores.get(norm(awayTeam));
  if (!Number.isFinite(home) || !Number.isFinite(away) || home < 0 || away < 0) return null;
  return { homeScore: home, awayScore: away };
}
export function settleHeadToHead(selection, homeTeam, awayTeam, homeScore, awayScore) {
  const norm = value => String(value ?? "").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
  const chosen = norm(selection);
  if (!chosen || !Number.isFinite(Number(homeScore)) || !Number.isFinite(Number(awayScore))) return null;
  if (chosen === norm(homeTeam)) return Number(homeScore) > Number(awayScore) ? "won" : "lost";
  if (chosen === norm(awayTeam)) return Number(awayScore) > Number(homeScore) ? "won" : "lost";
  return null;
}
