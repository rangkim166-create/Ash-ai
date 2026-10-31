const normalize = (value) => String(value ?? "").trim().toLocaleLowerCase("en-US");
const finite = (value) => Number.isFinite(Number(value)) && Number(value) > 1;

function summarizeForm(rows, sport, team) {
  const matches = rows
    .filter((row) => normalize(row.sport) === normalize(sport) && normalize(row.team) === normalize(team))
    .sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)))
    .slice(0, 10);
  if (!matches.length) return { played: 0, score: 0, wins: 0, draws: 0, losses: 0 };
  let wins = 0, draws = 0, losses = 0, points = 0;
  for (const row of matches) {
    const outcome = String(row.outcome || "").toUpperCase();
    if (outcome === "W") { wins++; points += 1; }
    else if (outcome === "D") { draws++; points += normalize(sport) === "football" ? 0.5 : 0; }
    else if (outcome === "L") losses++;
  }
  return { played: matches.length, score: points / matches.length, wins, draws, losses };
}

/**
 * Rank only upcoming, fresh h2h markets with independent recent-result samples.
 * This is a conservative evidence filter, not a calibrated probability model.
 */
export function selectDailyPicks(fixtures, oddsRows, formRows, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const maxPicks = Math.max(1, Math.min(5, Number(options.maxPicks) || 3));
  const cutoff = now.getTime() - 6 * 60 * 60 * 1000;
  const byMatch = new Map();

  for (const row of oddsRows || []) {
    if (String(row.market_key).toLowerCase() !== "h2h" || !finite(row.decimal_odds)) continue;
    const observed = Date.parse(row.observed_at);
    if (!Number.isFinite(observed) || observed < cutoff || observed > now.getTime() + 5 * 60 * 1000) continue;
    const matchId = String(row.match_id || "");
    const bookmaker = String(row.bookmaker_key || "");
    const outcome = String(row.outcome_name || "").trim();
    if (!matchId || !bookmaker || !outcome) continue;
    if (!byMatch.has(matchId)) byMatch.set(matchId, new Map());
    const books = byMatch.get(matchId);
    if (!books.has(bookmaker)) books.set(bookmaker, new Map());
    const outcomes = books.get(bookmaker);
    const previous = outcomes.get(outcome);
    if (!previous || Date.parse(row.observed_at) > Date.parse(previous.observed_at)) outcomes.set(outcome, row);
  }

  const ranked = [];
  for (const fixture of fixtures || []) {
    const kickoff = Date.parse(fixture.starts_at);
    if (!Number.isFinite(kickoff) || kickoff <= now.getTime() || kickoff > now.getTime() + 36 * 60 * 60 * 1000) continue;
    const home = String(fixture.home || "").trim();
    const away = String(fixture.away || "").trim();
    const sport = String(fixture.sport || "").trim().toLowerCase();
    if (!home || !away || !sport) continue;
    const books = byMatch.get(String(fixture.id));
    if (!books) continue;

    const homeForm = summarizeForm(formRows || [], sport, home);
    const awayForm = summarizeForm(formRows || [], sport, away);
    if (homeForm.played < 5 || awayForm.played < 5) continue;

    const candidates = [];
    for (const [bookmaker, outcomes] of books.entries()) {
      const valid = [...outcomes.values()].filter((row) => finite(row.decimal_odds));
      if (valid.length < 2) continue;
      const overround = valid.reduce((sum, row) => sum + 1 / Number(row.decimal_odds), 0);
      if (!Number.isFinite(overround) || overround <= 0) continue;
      for (const row of valid) {
        const selection = String(row.outcome_name).trim();
        const side = normalize(selection) === normalize(home) ? "home"
          : normalize(selection) === normalize(away) ? "away" : null;
        if (!side) continue;
        candidates.push({
          bookmaker,
          side,
          selection,
          price: Number(row.decimal_odds),
          fairProbability: (1 / Number(row.decimal_odds)) / overround,
        });
      }
    }

    for (const side of ["home", "away"]) {
      const selection = side === "home" ? home : away;
      const selectedForm = side === "home" ? homeForm : awayForm;
      const opponentForm = side === "home" ? awayForm : homeForm;
      const edge = selectedForm.score - opponentForm.score;
      const selected = candidates.filter((candidate) => candidate.side === side);
      const uniqueBooks = new Map();
      for (const candidate of selected) {
        const prior = uniqueBooks.get(candidate.bookmaker);
        if (!prior || candidate.price > prior.price) uniqueBooks.set(candidate.bookmaker, candidate);
      }
      const supported = [...uniqueBooks.values()];
      if (!supported.length) continue;
      const best = supported.reduce((a, b) => b.price > a.price ? b : a);
      const requiredBooks = best.price > 3.5 ? 5 : best.price > 2.25 ? 4 : 3;
      const requiredForm = best.price > 3.5 ? 0.15 : 0.08;
      if (supported.length < requiredBooks || edge < requiredForm) continue;

      const bookmakerNames = supported.map((row) => row.bookmaker).sort();
      const averagePrice = supported.reduce((sum, row) => sum + row.price, 0) / supported.length;
      const fairProbability = supported.reduce((sum, row) => sum + row.fairProbability, 0) / supported.length;
      const depth = Math.min(selectedForm.played, 10) + Math.min(opponentForm.played, 10);
      const riskPenalty = best.price > 5 ? 20 : best.price > 3.5 ? 12 : best.price > 2.25 ? 5 : 0;
      const evidenceIndex = Math.max(0, Math.min(100,
        supported.length * 7 + depth * 2 + Math.round(edge * 35) - riskPenalty));
      ranked.push({
        id: String(fixture.id),
        sport,
        competition: String(fixture.competition || ""),
        home_team: home,
        away_team: away,
        commence_time: fixture.starts_at,
        selection,
        price: best.price,
        average_market_price: Number(averagePrice.toFixed(3)),
        market_probability_pct: Number((fairProbability * 100).toFixed(1)),
        best_bookmaker: best.bookmaker,
        bookmaker_names: bookmakerNames.join(", "),
        bookmakers: supported.length,
        home_form: `${homeForm.wins}W-${homeForm.draws}D-${homeForm.losses}L`,
        away_form: `${awayForm.wins}W-${awayForm.draws}D-${awayForm.losses}L`,
        home_form_count: homeForm.played,
        away_form_count: awayForm.played,
        form_edge_pct: Number((edge * 100).toFixed(1)),
        evidence_index: evidenceIndex,
        reason: `${supported.length} bookmakers support this side; recent form ${selectedForm.wins}W-${selectedForm.draws}D-${selectedForm.losses}L (${selectedForm.played} matches) versus ${opponentForm.wins}W-${opponentForm.draws}D-${opponentForm.losses}L (${opponentForm.played} matches); weighted by verified results only.`,
      });
    }
  }

  const seen = new Set();
  return ranked
    .sort((a, b) => b.evidence_index - a.evidence_index || b.bookmakers - a.bookmakers || a.price - b.price)
    .filter((pick) => {
      if (seen.has(pick.id)) return false;
      seen.add(pick.id);
      return true;
    })
    .slice(0, maxPicks);
}

export function formatDailyPicks(day, picks, timezone = "Africa/Kampala") {
  const header = `ASH • ODDS OF THE DAY — ${day}`;
  if (!picks?.length) {
    return `${header}\n\nNo selection passed today's checks for fresh bookmaker odds, multi-bookmaker support and verified recent form. No forced bets today.`;
  }
  const lines = [header, "", "Verified upcoming matches • decimal odds • prices can move", ""];
  picks.forEach((pick, index) => {
    const kickoff = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(pick.commence_time));
    lines.push(
      `${index + 1}. ${pick.away_team} vs ${pick.home_team}`,
      `Pick: ${pick.selection} @ ${Number(pick.price).toFixed(2)}`,
      `Best bookmaker: ${pick.best_bookmaker}`,
      `Evidence: ${pick.bookmakers} bookmakers • form edge ${pick.form_edge_pct}% • index ${pick.evidence_index}/100`,
      `Recent form: home ${pick.home_form} • away ${pick.away_form}`,
      `Kick-off (Kampala): ${kickoff}`,
      ""
    );
  });
  lines.push("Research filter, not a guarantee. Recheck the price before placing any bet.");
  return lines.join("\n").slice(0, 3900);
}
