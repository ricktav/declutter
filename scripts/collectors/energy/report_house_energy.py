#!/usr/bin/env python3
# scripts/collectors/energy/report_house_energy.py
"""Send the house's monthly grid import/export (DSMR-reader) and solar
production (SolarEdge) to HomeBase (energy.report).

Secrets are read at runtime from their existing files on dockermac-1 and are
never printed: the DSMR-reader token from ~/html/api/dsmr.php, the SolarEdge
key from ~/tesla/.env. Nightly it sends the previous and the current month;
--all sends everything (DSMR from 2020-07, SolarEdge from 2015-10).
"""
import argparse, json, os, re, sys, urllib.request
from datetime import date, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import homebase
from report_energy_homebase import months_to_send

DSMR = "http://10.50.0.143/api/v2/statistics/day"
SOLAREDGE = "https://monitoringapi.solaredge.com/site/181945/energy"

def _dsmr_token():
    src = open(os.path.expanduser("~/html/api/dsmr.php")).read()
    return re.search(r"\$key\s*=\s*['\"]([^'\"]+)['\"]", src).group(1)

def _solaredge_key():
    for line in open(os.path.expanduser("~/tesla/.env")):
        if line.startswith("SOLAREDGE_API_KEY="):
            return line.split("=", 1)[1].strip().strip("'\"")
    raise RuntimeError("SOLAREDGE_API_KEY not found")

def grid_months(days):
    """DSMR day statistics -> grid report months. T2 (electricity2) is normal, T1 is off-peak."""
    acc = {}
    for d in days:
        m = d["day"][:7]
        a = acc.setdefault(m, {"month": m, "kwhNormal": 0.0, "kwhOffpeak": 0.0, "kwhReturnedNormal": 0.0, "kwhReturnedOffpeak": 0.0, "hours": 0.0})
        a["kwhNormal"] += float(d["electricity2"] or 0)
        a["kwhOffpeak"] += float(d["electricity1"] or 0)
        a["kwhReturnedNormal"] += float(d["electricity2_returned"] or 0)
        a["kwhReturnedOffpeak"] += float(d["electricity1_returned"] or 0)
        a["hours"] += 24.0
    return [{k: (round(v, 3) if isinstance(v, float) else v) for k, v in a.items()} for _, a in sorted(acc.items())]

def solar_months(values):
    """SolarEdge MONTH values (Wh, None for no data) -> solar report months."""
    return [{"month": v["date"][:7], "kwhProduced": round(v["value"] / 1000, 3)} for v in values if v.get("value") is not None]

def fetch_dsmr(since):
    token, url, days = _dsmr_token(), f"{DSMR}?ordering=day&limit=500&day__gte={since}", []
    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Token {token}"})
        page = json.load(urllib.request.urlopen(req, timeout=30))
        days += page["results"]
        url = page.get("next")
    return days

def fetch_solar(since):
    url = f"{SOLAREDGE}?timeUnit=MONTH&startDate={since}&endDate={date.today()}&api_key={_solaredge_key()}"
    return json.load(urllib.request.urlopen(url, timeout=30))["energy"]["values"]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    wanted = months_to_send(datetime.now())
    failed = 0
    for kind, since, fetch, shape in (("grid", "2020-07-01", fetch_dsmr, grid_months), ("solar", "2015-10-01", fetch_solar, solar_months)):
        meters = homebase.meters(kind)
        if len(meters) != 1:
            print(f"WARNING: expected one {kind} meter, found {len(meters)}", file=sys.stderr)
            failed += 1
            continue
        try:
            start = since if args.all else f"{wanted[0]}-01"
            months = [m for m in shape(fetch(start)) if args.all or m["month"] in wanted]
            if args.dry_run:
                print(kind, len(months), "months; last:", json.dumps(months[-1]) if months else "-")
            else:
                homebase.report(meters[0]["id"], "dsmr" if kind == "grid" else "solaredge", months)
                print(f"{kind}: {len(months)} months sent")
        except Exception as e:  # never print the request URL: it carries the SolarEdge key
            failed += 1
            print(f"WARNING: {kind}: {type(e).__name__}", file=sys.stderr)
    return 1 if failed else 0

if __name__ == "__main__":
    sys.exit(main())
