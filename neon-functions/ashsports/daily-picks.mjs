const normalize = value => String(value ?? "").trim().toLocaleLowerCase("en-US");
const normalizeTeam = value => {
  const raw = String(value ?? "").trim();
  const comma = raw.indexOf(",");
  const ordered = comma > 0 ? raw.slice(comma + 1).trim() + " " + raw.slice(0, comma).trim() : raw;
  return normalize(ordered).normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
};
const validPrice = value => Number.isFinite(Number(value)) && Number(value) > 1 && Number(value) <= 1000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const DRAW_NAMES = new Set(["draw", "the draw", "tie", "x"]);

function summarizeForm(rows, sport, team) {
  const target = normalizeTeam(team);
  const matches = (rows || [])
    .filter(row => normalize(row.sport) === normalize(sport) && normalizeTeam(row.team) === target)
    .sort((a, b) => String(b.starts_at).localeCompare(String(a.starts_at)))
    .slice(0, 10);
  let wins = 0, draws = 0, losses = 0, points = 0;
  for (const row of matches) {
    const outcome = String(row.outcome || "").toUpperCase();
    if (outcome === "W") { wins++; points += 1; }
    else if (outcome === "D") { draws++; if (normalize(sport) === "football") points += 0.5; }
    else if (outcome === "L") losses++;
  }
  return { played: matches.length, score: matches.length ? points / matches.length : 0, wins, draws, losses };
}

function ratingFor(ratings, sport, team) {
  const bucket = ratings?.[normalize(sport)];
  if (!bucket) return null;
  const key = normalizeTeam(team);
  const value = bucket[key] ?? bucket[normalize(team)] ?? bucket[team];
  const rating = Number(value);
  return Number.isFinite(rating) ? rating : null;
}

function isDrawName(value) {
  return DRAW_NAMES.has(normalizeTeam(value));
}

function sideForOutcome(value, home, away) {
  const key = normalizeTeam(value);
  if (key === normalizeTeam(home)) return "home";
  if (key === normalizeTeam(away)) return "away";
  if (isDrawName(value)) return "draw";
  return null;
}

function summarizeBookmakerMarkets(books, fixture, sport) {
  const markets = [];
  for (const [bookmaker, outcomes] of books.entries()) {
    const mapped = new Map();
    for (const row of outcomes.values()) {
      if (!validPrice(row.decimal_odds)) continue;
      const side = sideForOutcome(row.outcome_name, fixture.home, fixture.away);
      if (side) mapped.set(side, row);
    }
    // Basketball regulation-result markets can include a draw; when present,
    // include it in the no-vig denominator instead of treating the market as 2-way.
    const required = sport === "football" || (sport === "basketball" && mapped.has("draw"))
      ? ["home", "away", "draw"] : ["home", "away"];
    if (!required.every(side => mapped.has(side))) continue;
    const overround = required.reduce((sum, side) => sum + 1 / Number(mapped.get(side).decimal_odds), 0);
    if (!Number.isFinite(overround) || overround <= 0) continue;
    markets.push({
      bookmaker,
      prices: Object.fromEntries(required.map(side => [side, Number(mapped.get(side).decimal_odds)])),
      probabilities: Object.fromEntries(required.map(side => [side, (1 / Number(mapped.get(side).decimal_odds)) / overround]))
    });
  }
  return markets;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

/**
 * Conservative candidate selector.
 * It requires fresh complete markets, independent bookmakers and either
 * sufficient recent form or a sufficiently large imported Elo archive.
 * Estimated probabilities are deliberately shrunk toward the no-vig market.
 */
export function selectDailyPicks(fixtures, oddsRows, formRows, options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("options.now must be a valid date");
  const maxPicks = Math.max(1, Math.min(5, Number(options.maxPicks) || 3));
  const oldestAllowed = now.getTime() - 15 * 60 * 1000;
  const newestAllowed = now.getTime() + 5 * 60 * 1000;
  const byMatch = new Map();
  const ratings = options.ratings || {};
  const ratingMatchCounts = options.ratingMatchCounts || options.ratingsMeta?.match_counts || {};

  for (const row of oddsRows || []) {
    if (normalize(row.market_key) !== "h2h" || !validPrice(row.decimal_odds)) continue;
    const observed = Date.parse(row.observed_at);
    if (!Number.isFinite(observed) || observed < oldestAllowed || observed > newestAllowed) continue;
    const matchId = String(row.match_id || "");
    const bookmaker = String(row.bookmaker_key || "").trim();
    const outcome = String(row.outcome_name || "").trim();
    if (!matchId || !bookmaker || !outcome) continue;
    if (!byMatch.has(matchId)) byMatch.set(matchId, new Map());
    const books = byMatch.get(matchId);
    if (!books.has(bookmaker)) books.set(bookmaker, new Map());
    const outcomes = books.get(bookmaker);
    const key = normalizeTeam(outcome);
    const previous = outcomes.get(key);
    if (!previous || Date.parse(row.observed_at) > Date.parse(previous.observed_at)) outcomes.set(key, row);
  }

  const ranked = [];
  for (const fixture of fixtures || []) {
    const kickoff = Date.parse(fixture.starts_at);
    if (!Number.isFinite(kickoff) || kickoff <= now.getTime() + 30 * 60 * 1000 || kickoff > now.getTime() + 36 * 60 * 60 * 1000) continue;
    const home = String(fixture.home || "").trim();
    const away = String(fixture.away || "").trim();
    const sport = normalize(fixture.sport);
    if (!home || !away || !sport) continue;
    const books = byMatch.get(String(fixture.id));
    if (!books) continue;

    const homeForm = summarizeForm(formRows, sport, home);
    const awayForm = summarizeForm(formRows, sport, away);
    const hasRecentForm = homeForm.played >= 5 && awayForm.played >= 5;
    const historyCount = Number(ratingMatchCounts[sport] || 0);
    const homeRating = ratingFor(ratings, sport, home);
    const awayRating = ratingFor(ratings, sport, away);
    const hasRatings = homeRating !== null && awayRating !== null && historyCount >= 1000;
    if (!hasRecentForm && !hasRatings) continue;

    const markets = summarizeBookmakerMarkets(books, fixture, sport);
    for (const side of ["home", "away"]) {
      const selection = side === "home" ? home : away;
      const selectedForm = side === "home" ? homeForm : awayForm;
      const opponentForm = side === "home" ? awayForm : homeForm;
      const selectedRating = side === "home" ? homeRating : awayRating;
      const opponentRating = side === "home" ? awayRating : homeRating;
      const formEdge = hasRecentForm ? selectedForm.score - opponentForm.score : 0;
      const ratingDelta = hasRatings ? selectedRating - opponentRating : null;
      const eloProbability = hasRatings ? 1 / (1 + Math.pow(10, -ratingDelta / 400)) : null;
      const signal = Math.max(hasRecentForm ? formEdge : 0, hasRatings ? eloProbability - 0.5 : 0);
      if (signal < 0.06) continue;

      const supported = markets.filter(market => market.probabilities[side] != null);
      if (!supported.length) continue;
      const bookmakerCount = supported.length;
      const provisionalBest = supported.reduce((best, market) =>
        market.prices[side] > best.prices[side] ? market : best, supported[0]);
      // Two independent local bookmaker feeds are currently available. Keep short-price
      // selections eligible at two books, but require a third independent price for long odds.
      const requiredBooks = provisionalBest.prices[side] > 3.5 ? 3 : 2;
      if (bookmakerCount < requiredBooks) continue;

      const marketProbabilities = supported.map(market => market.probabilities[side]);
      const marketProbability = average(marketProbabilities);
      const variance = average(marketProbabilities.map(value => Math.pow(value - marketProbability, 2)));
      const marketDisagreement = Math.sqrt(variance);
      if (marketDisagreement > 0.08) continue;

      const formAdjustment = hasRecentForm ? clamp(formEdge * 0.12, -0.06, 0.06) : 0;
      const eloAdjustment = hasRatings ? clamp((eloProbability - 0.5) * 0.20, -0.07, 0.07) : 0;
      const adjustment = hasRecentForm && hasRatings
        ? formAdjustment * 0.55 + eloAdjustment * 0.45
        : hasRecentForm ? formAdjustment : eloAdjustment;
      const estimatedProbability = clamp(marketProbability + adjustment, 0.02, 0.95);

      const best = supported.reduce((current, market) =>
        market.prices[side] > current.prices[side] ? market : current, supported[0]);
      const bestPrice = best.prices[side];
      const impliedProbability = 1 / bestPrice;
      const valueEdge = estimatedProbability - impliedProbability;
      if (valueEdge < 0.015) continue;

      const bookmakerNames = supported.map(market => market.bookmaker).sort();
      const averagePrice = average(supported.map(market => market.prices[side]));
      const depth = hasRecentForm ? Math.min(homeForm.played, 10) + Math.min(awayForm.played, 10) : 0;
      const riskPenalty = bestPrice > 5 ? 20 : bestPrice > 3.5 ? 12 : bestPrice > 2.25 ? 5 : 0;
      const evidenceIndex = Math.max(0, Math.min(100,
        bookmakerCount * 7 + depth * 2 + Math.round(signal * 35) -
        Math.round(marketDisagreement * 100) - riskPenalty));
      const edgeType = hasRecentForm && hasRatings ? "hybrid_elo_form"
        : hasRecentForm ? "recent_form" : "elo_rating";
      const reasonParts = [
        bookmakerCount + " independent bookmaker prices",
        "no-vig market " + (marketProbability * 100).toFixed(1) + "%",
        "Ash estimate " + (estimatedProbability * 100).toFixed(1) + "%",
        "value edge " + (valueEdge * 100).toFixed(1) + " percentage points"
      ];
      if (hasRecentForm) reasonParts.push("recent form " + selectedForm.wins + "W-" + selectedForm.draws + "D-" + selectedForm.losses + "L vs " + opponentForm.wins + "W-" + opponentForm.draws + "D-" + opponentForm.losses + "L");
      if (hasRatings) reasonParts.push("Elo difference " + Math.round(ratingDelta) + " points from " + historyCount.toLocaleString("en-US") + " archived matches");
      reasonParts.push("screening estimate only; lineups, injuries and late tactical changes may be unknown");

      ranked.push({
        id: String(fixture.id), sport, competition: String(fixture.competition || ""),
        home_team: home, away_team: away, commence_time: fixture.starts_at,
        selection, price: bestPrice, average_market_price: Number(averagePrice.toFixed(3)),
        market_probability_pct: Number((marketProbability * 100).toFixed(1)),
        estimated_probability_pct: Number((estimatedProbability * 100).toFixed(1)),
        implied_probability_pct: Number((impliedProbability * 100).toFixed(1)),
        value_edge_pct: Number((valueEdge * 100).toFixed(1)),
        expected_value_pct: Number(((estimatedProbability * bestPrice - 1) * 100).toFixed(1)),
        market_disagreement_pct: Number((marketDisagreement * 100).toFixed(1)),
        best_bookmaker: best.bookmaker, bookmaker_names: bookmakerNames.join(", "),
        bookmakers: bookmakerCount,
        home_form: hasRecentForm ? homeForm.wins + "W-" + homeForm.draws + "D-" + homeForm.losses + "L" : "not available",
        away_form: hasRecentForm ? awayForm.wins + "W-" + awayForm.draws + "D-" + awayForm.losses + "L" : "not available",
        home_form_count: homeForm.played, away_form_count: awayForm.played,
        edge_type: edgeType,
        ...(hasRecentForm ? { form_edge_pct: Number((formEdge * 100).toFixed(1)) } : {}),
        ...(hasRatings ? {
          home_rating: Number(homeRating.toFixed(1)), away_rating: Number(awayRating.toFixed(1)),
          rating_edge_points: Math.round(ratingDelta), historical_match_count: historyCount
        } : {}),
        evidence_index: evidenceIndex,
        reason: reasonParts.join("; ") + "."
      });
    }
  }

  const bestByFixture = new Map();
  for (const pick of ranked.sort((a, b) =>
    b.value_edge_pct - a.value_edge_pct || b.evidence_index - a.evidence_index || b.bookmakers - a.bookmakers)) {
    if (!bestByFixture.has(pick.id)) bestByFixture.set(pick.id, pick);
  }
  return [...bestByFixture.values()].slice(0, maxPicks);
}

export function isAvailabilityResearchSufficient(report, { fixtureStart, sport = "football", now = new Date() } = {}) {
  if (!report || !report.researchedAt) return false;
  const current = new Date(now), researched = new Date(report.researchedAt), starts = new Date(fixtureStart);
  if (!Number.isFinite(current.getTime()) || !Number.isFinite(researched.getTime()) || !Number.isFinite(starts.getTime())) return false;
  const nearKickoff = starts.getTime() <= current.getTime() + 3 * 60 * 60 * 1000;
  const maxAgeMs = nearKickoff ? 20 * 60 * 1000 : 6 * 60 * 60 * 1000;
  const ageMs = current.getTime() - researched.getTime();
  if (ageMs < 0 || ageMs > maxAgeMs) return false;
  const coverage = report.coverage || {};
  const assessment = report.assessment || {};
  const sportKey = String(sport || "football").toLowerCase();
  const sportCoverage = sportKey === "tennis"
    ? (coverage.injuryReportingFound === true || coverage.withdrawalReportingFound === true) &&
      (Number(coverage.categoryCounts?.form_statistics || 0) > 0 || Number(coverage.categoryCounts?.preview_analysis || 0) > 0)
    : coverage.injuryReportingFound === true && coverage.lineupReportingFound === true;
  return Number(report.sourceCount) >= 2 &&
    Number(report.independentDomains) >= 2 &&
    coverage.home === true && coverage.away === true && sportCoverage &&
    assessment.error == null && Number(assessment.confidence) >= 60 &&
    !(Array.isArray(assessment.contradictions) && assessment.contradictions.length > 0);
}

export function formatDailyPicks(day, picks, timezone = "Africa/Kampala") {
  const header = "ASH • ODDS OF THE DAY — " + day;
  if (!picks?.length) {
    return header + "\n\nNo selection passed checks for fresh complete markets, bookmaker agreement, historical evidence and positive estimated value. NO BET is a valid result.";
  }
  const lines = [header, "", "Evidence-based shortlist • odds snapshots ≤15 min • prices can move", "Estimated probabilities are model estimates, not guarantees. Recheck lineups, injuries and match status.", ""];
  picks.forEach((pick, index) => {
    const kickoff = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false
    }).format(new Date(pick.commence_time));
    lines.push(
      (index + 1) + ". " + pick.away_team + " vs " + pick.home_team,
      "Pick: " + pick.selection + " @ " + Number(pick.price).toFixed(2),
      "Best bookmaker: " + pick.best_bookmaker,
      "Ash estimate: " + pick.estimated_probability_pct + "% • market: " + pick.market_probability_pct + "%",
      "Value edge: " + (pick.value_edge_pct > 0 ? "+" : "") + pick.value_edge_pct + " pp • expected value: " + (pick.expected_value_pct > 0 ? "+" : "") + pick.expected_value_pct + "%",
      "Evidence index: " + pick.evidence_index + "/100 • " + pick.bookmakers + " bookmakers"
    );
    if (pick.edge_type === "elo_rating" || pick.edge_type === "hybrid_elo_form") {
      lines.push(
        "Historical Elo: home " + pick.home_rating + " • away " + pick.away_rating + " • selected edge " + (pick.rating_edge_points > 0 ? "+" : "") + pick.rating_edge_points + " points",
        "Archive baseline: " + Number(pick.historical_match_count || 0).toLocaleString("en-US") + " " + pick.sport + " matches"
      );
    }
    if (pick.edge_type === "recent_form" || pick.edge_type === "hybrid_elo_form") {
      lines.push("Recent form: home " + pick.home_form + " • away " + pick.away_form + " • form edge " + pick.form_edge_pct + "%");
    }
    lines.push("Kick-off (Kampala): " + kickoff);
    const availability = pick.availability_research;
    if (availability) {
      const assessment = availability.assessment || {};
      const renderNews = value => (Array.isArray(value) ? value : (value ? [value] : [])).slice(0, 2).map(item => typeof item === "string" ? item : String(item.claim || item.player || item.status || JSON.stringify(item))).join("; ");
      lines.push("Availability/news research: " + (availability.researchedAt || "not available") + " • " + Number(availability.sourceCount || 0) + " sources");
      for (const [label, key] of [["Injuries/fitness","injuryUpdates"],["Lineups","lineupUpdates"],["Suspensions","suspensions"],["Manager/training","managerAndTrainingNews"],["Weather/venue","weatherAndVenue"]]) {
        const detail = renderNews(assessment[key]);
        if (detail) lines.push(label + ": " + detail.slice(0, 260));
      }
      const unknowns = renderNews(assessment.unknowns);
      if (unknowns) lines.push("Still unknown: " + unknowns.slice(0, 220));
      for (const source of (availability.sources || []).slice(0, 2)) lines.push("News source: " + String(source.title || "").slice(0, 100) + " — " + String(source.url || "").slice(0, 180));
      lines.push("Note: availability news is evidence context; the probability model does not yet quantify individual-player impact.");
    }
    const web = pick.web_research;
    if (web?.analysis) {
      lines.push("WORLD TIPSTER / EXPERT REVIEW: " + web.analysis.decision + " • confidence " + web.analysis.confidence + "/100");
      lines.push("Consensus: " + web.analysis.tipsterConsensus);
      lines.push("Contrary views: " + web.analysis.contraryViews);
      lines.push("Team news: " + web.analysis.teamNews);
      lines.push("Ash assessment: " + web.analysis.reason);
    }
    lines.push("Independent sources: " + (web?.quality?.independentDomains || 0) +
      " domains • home coverage " + (web?.quality?.homeCoverage ? "yes" : "no") +
      " • away coverage " + (web?.quality?.awayCoverage ? "yes" : "no") +
      " • expert coverage " + (web?.quality?.expertCoverage ? "yes" : "no"));
    for (const page of (web?.pages || []).slice(0, 3)) {
      lines.push("• " + String(page.title || "").slice(0, 125) +
        (page.domain ? " — " + page.domain : "") + (page.date ? " (" + page.date + ")" : ""));
      lines.push(String(page.url || "").slice(0, 220));
    }
    lines.push("Research checked: " + (web?.retrievedAt || "timestamp unavailable"), "");
  });
  lines.push("No outcome is guaranteed. Track every pick against its final result and evaluate long-run calibration before staking.");
  return lines.join("\n").slice(0, 3900);
}


export function shouldSkipSentDailyPublication(prior, now = new Date(), retryAfterMs = 2 * 60 * 60 * 1000) {
  if (!prior || prior.status !== "sent") return false;
  if (Number(prior.picks_count || 0) > 0) return true;
  const current = new Date(now).getTime();
  const started = new Date(prior.started_at || "").getTime();
  if (!Number.isFinite(current) || !Number.isFinite(started)) return false;
  return current >= started && current - started < retryAfterMs;
}
