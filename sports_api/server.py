from __future__ import annotations

import json
import os
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlparse
from urllib.request import Request, urlopen

HOST = "0.0.0.0"
PORT = int(os.getenv("PORT", "8000"))
ODDS_API_KEY = os.getenv("ODDS_API_KEY", "").strip()
ODDS_API_BASE = "https://api.the-odds-api.com/v4"
CACHE_SECONDS = max(15, int(os.getenv("ODDS_CACHE_SECONDS", "60")))
_cache: dict[str, tuple[float, object]] = {}\n_request_times: dict[str, list[float]] = {}
SPORT_KEY_RE = re.compile(r"^[a-z0-9_]{2,80}$")
MARKET_RE = re.compile(r"^[a-z0-9_]{2,60}$")
REGIONS_ALLOWED = {"uk", "eu", "us", "us2", "au"}
FEATURED_MARKETS = {"h2h", "spreads", "totals", "outrights"}
# Odd/even is intentionally not assumed to exist: it is not listed as a standard
# market by The Odds API. The event-markets endpoint can check bookmaker coverage.
ODD_EVEN_MARKET_CANDIDATES = ("odd_even", "odd_even_goals", "total_goals_odd_even")


def fetch_json(path: str, params: dict[str, str]) -> tuple[object, dict[str, str]]:
    from urllib.parse import urlencode
    query = urlencode({**params, "apiKey": ODDS_API_KEY})
    req = Request(f"{ODDS_API_BASE}{path}?{query}", headers={"Accept": "application/json", "User-Agent": "AshJarvis-Sports/1.0"})
    with urlopen(req, timeout=18) as response:
        body = response.read().decode("utf-8")
        headers = {k.lower(): v for k, v in response.headers.items()}
        return json.loads(body), headers


def cached(key: str, fetcher):
    now = time.time()
    hit = _cache.get(key)
    if hit and now - hit[0] < CACHE_SECONDS:
        return hit[1], True
    value = fetcher()
    _cache[key] = (now, value)
    return value, False


class Handler(BaseHTTPRequestHandler):
    server_version = "AshSportsAPI/1.0"

    def log_message(self, fmt, *args):
        print("%s - %s" % (self.address_string(), fmt % args))

    def send_json(self, status: int, payload: object, extra_headers: dict[str, str] | None = None):
        raw = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        for key, value in (extra_headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self.send_json(204, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path in {"/odds", "/event-markets", "/event-odds"}:
            ip = self.client_address[0]
            now = time.time()
            recent = [stamp for stamp in _request_times.get(ip, []) if now - stamp < 60]
            if len(recent) >= 18:
                self.send_json(429, {"error": "Rate limit reached. Wait a minute before requesting more odds."})
                return
            recent.append(now)
            _request_times[ip] = recent
        if parsed.path == "/health":
            self.send_json(200, {"ok": True, "service": "ash-sports-api", "odds_api_key_configured": bool(ODDS_API_KEY)})
            return
        if not ODDS_API_KEY:
            self.send_json(503, {"error": "ODDS_API_KEY is not configured on the server. Add it as a private environment variable."})
            return
        try:
            if parsed.path == "/sports":
                data, hit = cached("sports", lambda: fetch_json("/sports", {})[0])
                self.send_json(200, {"data": data, "cached": hit})
                return
            if parsed.path == "/odds":
                sport = query.get("sport", ["soccer_epl"])[0].strip()
                regions = query.get("regions", ["uk,eu"])[0].strip().lower()
                markets = query.get("markets", ["h2h,totals"])[0].strip().lower()
                odds_format = query.get("oddsFormat", ["decimal"])[0].strip().lower()
                if not SPORT_KEY_RE.fullmatch(sport):
                    self.send_json(400, {"error": "Invalid sport key."}); return
                region_list = [r.strip() for r in regions.split(",") if r.strip()]
                if not region_list or any(r not in REGIONS_ALLOWED for r in region_list):
                    self.send_json(400, {"error": "regions must be from uk,eu,us,us2,au."}); return
                market_list = [m.strip() for m in markets.split(",") if m.strip()]
                if not market_list or len(market_list) > 4 or any(not MARKET_RE.fullmatch(m) for m in market_list):
                    self.send_json(400, {"error": "Provide 1-4 valid market keys."}); return
                if any(m not in FEATURED_MARKETS for m in market_list):
                    self.send_json(400, {"error": "The list odds endpoint accepts featured markets only. Use /event-markets and /event-odds for additional markets."}); return
                if odds_format not in {"decimal", "american"}:
                    self.send_json(400, {"error": "oddsFormat must be decimal or american."}); return
                cache_key = f"odds:{sport}:{regions}:{markets}:{odds_format}"
                def load():
                    data, headers = fetch_json(f"/sports/{sport}/odds", {"regions": regions, "markets": markets, "oddsFormat": odds_format})
                    return {"data": data, "quota": {k: headers.get(k) for k in ("x-requests-remaining", "x-requests-used", "x-requests-last")}}
                payload, hit = cached(cache_key, load)
                payload["cached"] = hit
                payload["requested_markets"] = market_list
                payload["odd_even_note"] = "The Odds API does not list odd/even as a standard market. Check an individual event's available market keys before claiming bookmaker odd/even odds exist."
                self.send_json(200, payload)
                return
            if parsed.path == "/event-markets":
                sport = query.get("sport", ["soccer_epl"])[0].strip()
                event_id = query.get("event_id", [""])[0].strip()
                regions = query.get("regions", ["uk,eu"])[0].strip().lower()
                if not SPORT_KEY_RE.fullmatch(sport) or not event_id or not re.fullmatch(r"[A-Za-z0-9_-]{5,100}", event_id):
                    self.send_json(400, {"error": "Provide valid sport and event_id."}); return
                region_list = [r.strip() for r in regions.split(",") if r.strip()]
                if not region_list or any(r not in REGIONS_ALLOWED for r in region_list):
                    self.send_json(400, {"error": "regions must be from uk,eu,us,us2,au."}); return
                data, hit = cached(f"markets:{sport}:{event_id}:{regions}", lambda: fetch_json(f"/sports/{sport}/events/{event_id}/markets", {"regions": regions})[0])
                # Shape is provider-native. Keep raw market keys so newly-added markets aren't lost.
                self.send_json(200, {"data": data, "cached": hit, "odd_even_market_keys": list(ODD_EVEN_MARKET_CANDIDATES), "note": "Only keys actually returned by the provider are real bookmaker markets."})
                return
            if parsed.path == "/event-odds":
                sport = query.get("sport", ["soccer_epl"])[0].strip()
                event_id = query.get("event_id", [""])[0].strip()
                regions = query.get("regions", ["uk,eu"])[0].strip().lower()
                markets = query.get("markets", ["odd_even"])[0].strip().lower()
                if not SPORT_KEY_RE.fullmatch(sport) or not re.fullmatch(r"[A-Za-z0-9_-]{5,100}", event_id):
                    self.send_json(400, {"error": "Provide valid sport and event_id."}); return
                market_list = [m.strip() for m in markets.split(",") if m.strip()]
                if not market_list or len(market_list) > 4 or any(not MARKET_RE.fullmatch(m) for m in market_list):
                    self.send_json(400, {"error": "Provide 1-4 valid market keys."}); return
                region_list = [r.strip() for r in regions.split(",") if r.strip()]
                if not region_list or any(r not in REGIONS_ALLOWED for r in region_list):
                    self.send_json(400, {"error": "regions must be from uk,eu,us,us2,au."}); return
                cache_key = f"eventodds:{sport}:{event_id}:{regions}:{markets}"
                payload, hit = cached(cache_key, lambda: fetch_json(f"/sports/{sport}/events/{event_id}/odds", {"regions": regions, "markets": markets, "oddsFormat": "decimal"})[0])
                self.send_json(200, {"data": payload, "cached": hit, "note": "If provider rejects odd_even as unsupported, Ash must show unavailable and must not invent bookmaker prices."})
                return
            self.send_json(404, {"error": "Not found", "routes": ["/health", "/sports", "/odds", "/event-markets", "/event-odds"]})
        except HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")[:1500]
            status = 502 if exc.code >= 500 else 400
            self.send_json(status, {"error": "The Odds API request failed", "provider_status": exc.code, "details": details})
        except (URLError, TimeoutError) as exc:
            self.send_json(502, {"error": "Could not reach The Odds API", "details": str(exc)[:300]})
        except Exception as exc:
            self.send_json(500, {"error": "Unexpected sports API error", "details": str(exc)[:300]})


if __name__ == "__main__":
    print(f"Starting Ash Sports API on {HOST}:{PORT}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
