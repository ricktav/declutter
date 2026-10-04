#!/usr/bin/env python3
# scripts/collectors/energy/report_energy_homebase.py
"""Send each Plugwise plug's monthly figures to HomeBase (energy.report).

Reads the 15-minute rows of ~/plugwise/plugwise_energy_complete_history.db
and sends the previous and the current month for every plug item (found by
its mac). --all sends every month in the database; --dry-run prints and
sends nothing. Small negative readings (idle plugs) count as 0.
"""
import argparse, json, os, sqlite3, sys
from datetime import datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import homebase

DB = os.path.expanduser("~/plugwise/plugwise_energy_complete_history.db")

def is_offpeak(t):
    """Dutch off-peak: weekdays 23:00-07:00, weekends all day (holidays ignored)."""
    return t.weekday() >= 5 or t.hour >= 23 or t.hour < 7

def percentile(values, p):
    s = sorted(values)
    k = (len(s) - 1) * p
    f = int(k)
    c = min(f + 1, len(s) - 1)
    return s[f] + (s[c] - s[f]) * (k - f)

def aggregate(rows):
    """rows: (timestamp_15min, avg_power_w, max_power_w) of one plug -> {month: report month}."""
    acc = {}
    for ts, avg, mx in rows:
        t = datetime.fromisoformat(ts)
        a = acc.setdefault(t.strftime("%Y-%m"), {"n": 0, "norm": 0.0, "off": 0.0, "avgs": [], "peak": 0.0})
        w = max(float(avg), 0.0)
        kwh = w * 0.25 / 1000
        a["off" if is_offpeak(t) else "norm"] += kwh
        a["n"] += 1
        a["avgs"].append(w)
        a["peak"] = max(a["peak"], float(mx or 0))
    out = {}
    for month, a in acc.items():
        hours = a["n"] * 0.25
        kwh = a["norm"] + a["off"]
        out[month] = {
            "month": month,
            "kwhNormal": round(a["norm"], 3),
            "kwhOffpeak": round(a["off"], 3),
            "avgW": round(kwh * 1000 / hours, 1) if hours else 0.0,
            "baseW": round(percentile(a["avgs"], 0.10), 1),
            "peakW": round(max(a["peak"], 0.0), 1),
            "hours": round(hours, 1),
        }
    return out

def months_to_send(now):
    prev = f"{now.year - 1}-12" if now.month == 1 else f"{now.year}-{now.month - 1:02d}"
    return [prev, now.strftime("%Y-%m")]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    wanted = None if args.all else months_to_send(datetime.now())
    con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    sent = failed = 0
    for plug in homebase.meters("plug"):
        mac = (plug.get("attributes") or {}).get("mac")
        if not mac:
            continue
        rows = con.execute("SELECT timestamp_15min, avg_power_w, max_power_w FROM energy_readings WHERE mac_address = ? ORDER BY timestamp_15min", (mac,)).fetchall()
        months = [m for k, m in sorted(aggregate(rows).items()) if wanted is None or k in wanted]
        if not months:
            continue
        if args.dry_run:
            print(plug["name"], json.dumps(months[-1]), f"({len(months)} months)")
            continue
        try:
            homebase.report(plug["id"], "plugwise", months)
            sent += len(months)
        except Exception as e:  # one plug failing must not stop the others
            failed += 1
            print(f"WARNING: {plug['name']}: {e}", file=sys.stderr)
    print(f"energy report: {sent} months sent, {failed} plugs failed")
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
