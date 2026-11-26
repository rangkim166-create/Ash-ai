import http from "node:http";
import handler from "./neon-functions/ashsports/index.mjs";
import { importPublicFootballHistory } from "./neon-functions/ashsports/public-history.mjs";

const port = Number(process.env.PORT || 10000);
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const origin = "http://127.0.0.1:" + port;
    const init = { method: req.method, headers: req.headers };
    if (req.method !== "GET" && req.method !== "HEAD" && body.length) init.body = body;
    const request = new Request(new URL(req.url || "/", origin), init);
    const response = await handler.fetch(request);
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error("[ash-sports-http]", error);
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal_server_error" }));
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log("[ash-sports] engine listening", JSON.stringify({
    port,
    mode: "website-first",
    telegramPublishing: false
  }));

  let scraperRunning = false;
  const runBookmakerScrapers = async () => {
    if (scraperRunning) return;
    scraperRunning = true;
    try {
      const result = await handler.runScheduledScraping();
      console.log("[ash-bookmaker-scraper]", JSON.stringify(result));
    } catch (error) {
      console.error("[ash-bookmaker-scraper] failed", String(error?.message || error).slice(0, 240));
    } finally {
      scraperRunning = false;
    }
  };

  let researchRunning = false;
  const runFixtureResearch = async () => {
    if (researchRunning) return;
    researchRunning = true;
    try {
      const result = await handler.runScheduledFixtureResearch();
      console.log("[ash-research]", JSON.stringify(result));
    } catch (error) {
      console.error("[ash-research] failed", String(error?.message || error).slice(0, 240));
    } finally {
      researchRunning = false;
    }
  };

  let scoutRunning = false;
  const runScout = async () => {
    if (scoutRunning) return;
    if (process.env.ASH_ENABLE_ODDS_API_FIXTURE_DISCOVERY !== "true") {
      console.log("[ash-scout] optional Odds API fixture discovery disabled");
      return;
    }
    scoutRunning = true;
    try {
      const result = await handler.runScheduledCollection();
      console.log("[ash-scout]", JSON.stringify(result));
      const retryDelay = result?.status === "failed" ? 2 * 60 * 1000
        : result?.status === "partial" ? 6 * 60 * 1000 : 0;
      if (retryDelay) setTimeout(() => void runScout(), retryDelay).unref();
    } catch (error) {
      console.error("[ash-scout] failed", String(error?.message || error).slice(0, 240));
      setTimeout(() => void runScout(), 2 * 60 * 1000).unref();
    } finally {
      scoutRunning = false;
    }
  };

  let ratingsPromise;
  const importReferenceData = () => {
    if (!ratingsPromise) {
      ratingsPromise = Promise.allSettled([
        importPublicFootballHistory(),
        handler.runHistoricalRatingsImport()
      ]).then(results => {
        for (const [index, result] of results.entries()) {
          const label = index === 0 ? "football-history" : "historical-ratings";
          if (result.status === "fulfilled") console.log("[ash-reference]", label, JSON.stringify(result.value));
          else console.error("[ash-reference]", label, String(result.reason?.message || result.reason));
        }
        if (results.some(result => result.status === "rejected")) ratingsPromise = null;
        return results;
      });
    }
    return ratingsPromise;
  };

  let resultsRunning = false;
  const runResultsTracker = async () => {
    if (resultsRunning) return;
    resultsRunning = true;
    try {
      const result = await handler.runTipResultsTracker();
      console.log("[ash-results]", JSON.stringify(result));
    } catch (error) {
      console.error("[ash-results] failed", String(error?.message || error).slice(0, 240));
    } finally {
      resultsRunning = false;
    }
  };

  void importReferenceData();
  setTimeout(() => void runBookmakerScrapers(), 45000);
  setInterval(() => void runBookmakerScrapers(), 30 * 60 * 1000).unref();
  setTimeout(() => void runFixtureResearch(), 70000);
  setInterval(() => void runFixtureResearch(), 15 * 60 * 1000).unref();
  setTimeout(() => void runScout(), 20000);
  setInterval(() => void runScout(), 4 * 60 * 60 * 1000).unref();
  setTimeout(() => void runResultsTracker(), 90000);
  setInterval(() => void runResultsTracker(), 10 * 60 * 1000).unref();
});
