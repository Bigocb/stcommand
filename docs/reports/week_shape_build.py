"""Week shape of the THEO 2026-11-15 week in 12-hour buckets (operator request, 2026-11-22).

Inputs (Tailwinds ops tools, read 2026-11-22 07:26 UTC), saved as JSON files in one folder given as the first argument:
  market_sales_*.json  ops_market_sales sinceHours = hours back to each bucket start (13:00 / 01:00 UTC), limit 2000
  timeline.json        ops_timeline samples=true sinceHours=170 (15-minute role mix)
  system_queue.json    ops_system_queue (releasedAt of every fresh system)
Per bucket: a market's sells and profit in the bucket are its window total from the bucket start less the total from the next
bucket start; trading systems are the systems with at least one such sale. Traders are the 15-minute samples of the trader role
in the bucket (this week's samples only). Open systems are fresh systems released by the bucket's end (the home system is not
in the queue, so add one for it).
"""
import glob, json, sys, datetime as dt

def P(s): return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
src = sys.argv[1]
RESET = dt.datetime(2026, 11, 15, 13, tzinfo=dt.timezone.utc)
END = P(sys.argv[2]) if len(sys.argv) > 2 else dt.datetime.now(dt.timezone.utc)
wins = []
for f in glob.glob(f"{src}/market_sales_*.json"):
    j = json.load(open(f))
    wins.append((P(j["since"]), {r["waypoint"]: (r["sells"], r["profit"]) for r in j["rows"]}))
wins.sort(key=lambda w: w[0])
samples = [(P(s["ts"]), s["roles"].get("trader", 0)) for s in json.load(open(f"{src}/timeline.json"))["samples"] if s["reset_date"] == "2026-11-15"]
released = [P(q["releasedAt"]) for q in json.load(open(f"{src}/system_queue.json"))["queue"] if q.get("releasedAt")]

def phase(h0):
    if h0 < 36: return "Before the gate"
    if h0 < 60: return "Gate open, few traders"
    if h0 < 96: return "Crash"
    if h0 < 120: return "Recovery, first heavies"
    return "Hull waves"

rows = []
for i, (start, cur) in enumerate(wins):
    end = wins[i + 1][0] if i + 1 < len(wins) else END
    nxt = wins[i + 1][1] if i + 1 < len(wins) else {}
    sells = profit = 0
    systems = set()
    for wp, (s, p) in cur.items():
        ds = s - nxt.get(wp, (0, 0))[0]
        sells += ds
        profit += p - nxt.get(wp, (0, 0))[1]
        if ds > 0: systems.add("-".join(wp.split("-")[:2]))
    hours = (end - start).total_seconds() / 3600
    tr = [n for (t, n) in samples if start <= t < end]
    h0 = round((start - RESET).total_seconds() / 3600)
    label = (RESET + dt.timedelta(hours=max(h0, 0)))
    avg = sum(tr) / len(tr)
    rows.append({
        "bucket": label.strftime("%a %H:%M"), "start": label.strftime("%Y-%m-%dT%H:%MZ"), "phase": phase(h0),
        "hourFrom": max(h0, 0), "hourTo": round((end - RESET).total_seconds() / 3600, 1), "hours": round(hours, 1),
        "tradersAvg": round(avg, 1), "tradersMax": max(tr),
        "profitM": round(profit / 1e6, 2), "profitPerHourM": round(profit / hours / 1e6, 2),
        "perTraderK": round(profit / hours / avg / 1e3),
        "sells": sells, "openSystems": sum(1 for r in released if r <= end) + 1, "tradingSystems": len(systems),
    })
code = open(__file__).read()
json.dump({"rows": rows, "meta": [
    {"label": "week_shape_build.py", "value": code, "type": "code", "lang": "python"},
    {"label": "Inputs", "value": "Tailwinds ops_market_sales (14 windows), ops_timeline samples, ops_system_queue; read 2026-11-22 07:26 UTC"},
]}, sys.stdout, indent=1)
