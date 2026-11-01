import http from "node:http";
import handler from "./neon-functions/ashsports/index.mjs";
import { importPublicFootballHistory } from "./neon-functions/ashsports/public-history.mjs";
const port = Number(process.env.PORT || 10000);
const server = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const origin = `http://127.0.0.1:${port}`;
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
  console.log(`Ash Sports API listening on ${port}`);
  let scoutRunning = false;
  const runScout = async () => {
    if (scoutRunning) {
      console.log("[ash-scout] skipped: previous run still active; retrying shortly");
      setTimeout(() => void runScout(), 60 * 1000).unref();
      return;
    }
    if (!process.env.THE_ODDS_API_KEY) return console.log("[ash-scout] skipped: Odds API key is not configured");
    scoutRunning = true;
    try {
      const result = await handler.runScheduledCollection();
      console.log("[ash-scout] scheduled collection", JSON.stringify(result));
      // Publish as soon as fresh odds have been collected instead of waiting
      // for the next hourly timer after the first startup attempt.
      if (result && (result.status === "success" || result.status === "partial")) {
        await runDailyPublish();
      }
      // Retry interrupted, failed, or partial collection runs. The database
      // cooldown prevents repeated provider calls when a run is healthy.
      const retryDelay = result?.status === "failed" || result?.lastStatus === "failed"
        ? 2 * 60 * 1000
        : result?.status === "partial" || result?.lastStatus === "partial"
          ? 6 * 60 * 1000
          : result?.lastStatus === "running"
            ? 2 * 60 * 1000
            : 0;
      if (retryDelay > 0) setTimeout(() => void runScout(), retryDelay).unref();
    } catch (error) {
      console.error("[ash-scout] scheduled collection failed", error);
      setTimeout(() => void runScout(), 2 * 60 * 1000).unref();
    } finally {
      scoutRunning = false;
    }
  };
  let referenceDataPromise = null;
  const ensureReferenceData = () => {
    if (!referenceDataPromise) {
      referenceDataPromise = Promise.allSettled([
        importPublicFootballHistory(),
        handler.runHistoricalRatingsImport()
      ]).then(results => {
        const [history, ratings] = results;
        if (history.status === "fulfilled") {
          console.log("[ash-history] import finished", JSON.stringify(history.value));
        } else {
          console.error("[ash-history] import failed", history.reason);
        }
        if (ratings.status === "fulfilled") {
          console.log("[ash-ratings] import finished", JSON.stringify(ratings.value));
        } else {
          console.error("[ash-ratings] import failed", ratings.reason);
        }
        // Retry a failed source on the next publication attempt without blocking
        // today's ticket from using whichever reference data did load.
        if (history.status === "rejected" || ratings.status === "rejected") {
          referenceDataPromise = null;
        }
        return results;
      });
    }
    return referenceDataPromise;
  };
  let dailyPublishRunning = false;
  const runDailyPublish = async () => {
    if (dailyPublishRunning) return console.log("[ash-daily] skipped: previous publish attempt still running");
    dailyPublishRunning = true;
    try {
      await ensureReferenceData();
      const result = await handler.runScheduledDailyPublisher();
      console.log("[ash-daily] Odds of the Day", JSON.stringify(result));
    } catch (error) {
      console.error("[ash-daily] publish attempt failed", error);
    } finally {
      dailyPublishRunning = false;
    }
  };
  setTimeout(() => void runScout(), 20000);
  setTimeout(() => void runDailyPublish(), 60000);
  setInterval(() => void runScout(), 4 * 60 * 60 * 1000).unref();
  // Retry hourly until today's sheet is delivered; the database publication row prevents duplicates.
  setInterval(() => void runDailyPublish(), 60 * 60 * 1000).unref();
  let resultsTrackerRunning = false;
  const runResultsTracker = async () => {
    if (resultsTrackerRunning) return;
    resultsTrackerRunning = true;
    try {
      const result = await handler.runTipResultsTracker();
      if (result.checked || result.settled || result.errors?.length) {
        console.log("[ash-results] tracker", JSON.stringify(result));
      }
    } catch (error) {
      console.error("[ash-results] tracker failed", error);
    } finally {
      resultsTrackerRunning = false;
    }
  };
  setTimeout(() => void runResultsTracker(), 90000);
  setInterval(() => void runResultsTracker(), 10 * 60 * 1000).unref();
});
