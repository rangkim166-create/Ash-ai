export function normalizeScoutTeam(value) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/\b(fc|cf|sc|afc|cfc|club)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

export function validateScoutSignal(input = {}) {
  const sport = String(input.sport || "football").toLowerCase();
  const team = String(input.team || "").trim();
  const opinion = String(input.opinion || "").toLowerCase();
  const allowedOpinions = new Set(["win", "lose", "not_win", "draw", "upset", "avoid"]);
  if (!["football", "basketball", "tennis"].includes(sport)) throw new Error("unsupported_sport");
  if (team.length < 2 || team.length > 100) throw new Error("team_or_player_required");
  if (!allowedOpinions.has(opinion)) throw new Error("invalid_opinion");
  const reason = String(input.reason || "").trim().slice(0, 1000);
  return { sport, team, normalizedTeam: normalizeScoutTeam(team), opinion, reason };
}

export function buildScoutResearchQueries(signal, opponent = "", competition = "") {
  const team = String(signal.team || "").trim();
  const other = String(opponent || "").trim();
  const league = String(competition || "").trim();
  const reason = String(signal.reason || "").replace(/\\s+/g, " ").trim().slice(0, 160);
  const sport = String(signal.sport || "football").toLowerCase();
  const view = signal.opinion === "win" ? "win prediction"
    : signal.opinion === "lose" || signal.opinion === "not_win" ? "failure to win upset draw loss"
    : signal.opinion === "draw" ? "draw prediction"
    : signal.opinion === "upset" ? "underdog upset"
    : "team form match preview";
  const pair = [team, other].filter(Boolean).join(" vs ");
  const suffix = sport === "tennis" ? "tennis player" : sport === "basketball" ? "basketball team" : "football club";
  return [
    [pair, league, suffix, view, "recent form head to head"].filter(Boolean).join(" "),
    [team, suffix, "latest injury availability lineup suspension news"].join(" "),
    [other, suffix, "latest injury availability lineup suspension news"].filter(Boolean).join(" "),
    [pair, "manager coach tactics rotation motivation schedule news"].filter(Boolean).join(" "),
    [pair, "independent match analysis contrary predictions upset risk"].filter(Boolean).join(" "),
    ...(reason ? [[pair, "verify user scouting concern", reason].filter(Boolean).join(" ")] : [])
  ];
}
