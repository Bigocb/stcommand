#!/usr/bin/env node
// Rate-limit probe: does SpaceTraders limit per account or per IP?
//
// Run it ON THE BOX that runs the fleet (same IP as the live agents), with a token for the SECOND account's agent:
//   ST_PROBE_TOKEN=<second account agent token> node scripts/rate-limit-probe.mjs [requestsPerSecond=6] [seconds=20] [--no-token]
// It sends GET /my/agent (or the public GET /systems?limit=1 with --no-token) at the given rate and prints status counts
// plus the rate-limit headers of the first 429. While it runs, read ops api_budget on the live agents and see whether THEIR
// 429s (hits429BySource) rise:
//   - account B bursts, A's fleet gets 429s too            -> the limit is per IP (shared by every account on this IP)
//   - account B gets 429s, A's fleet does not              -> the limit is per account (an IP shared by two accounts is fine)
// The token is read from the environment so it never lands in shell history or chat. ~120 requests in 20 s at 6/s.
const API = "https://api.spacetraders.io/v2";
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const noToken = process.argv.includes("--no-token");
const rate = Number(args[0] ?? 6);
const seconds = Number(args[1] ?? 20);
const token = process.env.ST_PROBE_TOKEN;
if (!noToken && !token) { console.error("set ST_PROBE_TOKEN to the second account's agent token (or pass --no-token)"); process.exit(1); }
if (!(rate > 0 && rate <= 20) || !(seconds > 0 && seconds <= 60)) { console.error("rate must be 1-20 per second and seconds 1-60"); process.exit(1); }

const counts = {};
let firstHeaders;
const url = noToken ? `${API}/systems?limit=1` : `${API}/my/agent`;
const started = Date.now();
const total = Math.round(rate * seconds);
const jobs = [];
for (let i = 0; i < total; i++) {
  await new Promise((r) => setTimeout(r, Math.max(0, started + (i * 1000) / rate - Date.now())));
  jobs.push(
    fetch(url, { headers: noToken ? {} : { Authorization: `Bearer ${token}` } })
      .then((res) => {
        counts[res.status] = (counts[res.status] ?? 0) + 1;
        if (res.status === 429 && !firstHeaders) {
          firstHeaders = {};
          res.headers.forEach((v, k) => { if (/rate|retry|limit/i.test(k)) firstHeaders[k] = v; });
        }
      })
      .catch((e) => { counts.error = (counts.error ?? 0) + 1; }),
  );
}
await Promise.all(jobs);
console.log(JSON.stringify({ url: noToken ? "public /systems" : "/my/agent", requestsPerSecond: rate, seconds, sent: total, counts, firstRateLimitHeaders: firstHeaders ?? null }, null, 2));
