# scripts/collectors/energy/homebase.py
"""Tiny HomeBase tRPC client for the energy collectors."""
import json, os, urllib.parse, urllib.request

BASE = os.environ.get("HOMEBASE_URL", "http://10.50.0.102:3001")

def _get(path, inp):
    url = f"{BASE}/api/trpc/{path}?input=" + urllib.parse.quote(json.dumps({"json": inp}))
    body = json.load(urllib.request.urlopen(url, timeout=30))
    if "error" in body:
        raise RuntimeError(f"{path}: {body['error']['json'].get('message')}")
    return body["result"]["data"]["json"]

def meters(kind):
    """Active meter items of one kind (plug, grid, solar), in every house."""
    items = _get("items.listAll", {"includeArchived": False, "houseId": None})
    return [i for i in items if (i.get("attributes") or {}).get("role") == "meter" and (i.get("attributes") or {}).get("meter_kind") == kind]

def report(item_id, source, months):
    """Send months in chunks of 200 (the contract's limit)."""
    for i in range(0, len(months), 200):
        data = json.dumps({"json": {"itemId": item_id, "source": source, "months": months[i:i + 200]}}).encode()
        req = urllib.request.Request(f"{BASE}/api/trpc/energy.report", data=data, headers={"content-type": "application/json"})
        try:
            urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"energy.report #{item_id}: {json.load(e).get('error', {}).get('json', {}).get('message', e)}")
