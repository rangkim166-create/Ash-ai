import http from "node:http";
import handler from "./neon-functions/ashsports/index.mjs";
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
  const runDailyScout = async () => {
    if (!process.env.ASH_APP_TOKEN || !process.env.THE_ODDS_API_KEY) {
      console.log("[ash-scout] skipped configuration", { appToken: !!process.env.ASH_APP_TOKEN, oddsApiKey: !!process.env.THE_ODDS_API_KEY });
      return;
    }
    try {
      const request = new Request(`http://127.0.0.1:${port}/v1/odds/collect`, {
        method: "POST",
        headers: { authorization: "Bearer " + process.env.ASH_APP_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ maxSports: 6 })
      });
      const response = await handler.fetch(request);
      console.log("[ash-scout] daily collection", response.status, await response.text());
    } catch (error) {
      console.error("[ash-scout] daily collection failed", error);
    }
  };
  setTimeout(() => void runDailyScout(), 20000).unref();
  setInterval(() => void runDailyScout(), 24 * 60 * 60 * 1000).unref();
});
