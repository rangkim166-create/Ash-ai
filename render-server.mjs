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
    if (scoutRunning) return console.log("[ash-scout] skipped: previous run still active");
    if (!process.env.THE_ODDS_API_KEY) return console.log("[ash-scout] skipped: Odds API key is not configured");
    scoutRunning = true;
    try {
      const result = await handler.runScheduledCollection();
      console.log("[ash-scout] scheduled collection", JSON.stringify(result));
    } catch (error) {
      console.error("[ash-scout] scheduled collection failed", error);
    } finally {
      scoutRunning = false;
    }
  };
  let dailyPublishRunning = false;
  const runDailyPublish = async () => {
    if (dailyPublishRunning) return console.log("[ash-daily] skipped: previous publish attempt still running");
    dailyPublishRunning = true;
    try {
      const result = await handler.runScheduledDailyPublisher();
      console.log("[ash-daily] Odds of the Day", JSON.stringify(result));
    } catch (error) {
      console.error("[ash-daily] publish attempt failed", error);
    } finally {
      dailyPublishRunning = false;
    }
  };
  setTimeout(() => void runScout(), 20000).unref();
  setTimeout(() => {
    importPublicFootballHistory()
      .then(result => console.log("[ash-history] import finished", JSON.stringify(result)))
      .catch(error => console.error("[ash-history] import failed", error));
  }, 45000).unref();
  setTimeout(() => void runDailyPublish(), 60000).unref();
  setInterval(() => void runScout(), 4 * 60 * 60 * 1000).unref();
  // Retry hourly until today's sheet is delivered; the database publication row prevents duplicates.
  setInterval(() => void runDailyPublish(), 60 * 60 * 1000).unref();
});
