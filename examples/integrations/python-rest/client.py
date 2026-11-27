#!/usr/bin/env python3
"""
Standalone Python REST integration example for OneLineBooking (/v1).
Requires only Python 3 standard library (`urllib.request`, `json`, `uuid`).
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


def olb_request(base_url: str, api_key: str, method: str, path: str, body=None, tenant_id=None, idempotency_key=None):
    url = f"{base_url.rstrip('/')}{path}"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
    }
    if tenant_id:
        headers["X-Tenant-Id"] = tenant_id
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        err_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OneLineBooking HTTP {exc.code}: {err_body}") from exc


def main():
    base_url = os.environ["OLB_API_URL"]
    api_key = os.environ["OLB_API_KEY"]
    facility_id = os.environ["OLB_FACILITY_ID"]
    date_iso = os.environ["OLB_DATE"]
    tenant_id = os.environ.get("OLB_TENANT_ID")

    qs = urllib.parse.urlencode({"facilityId": facility_id, "fromDate": date_iso, "toDate": date_iso})
    avail = olb_request(base_url, api_key, "GET", f"/v1/availability?{qs}", tenant_id=tenant_id)
    open_slots = [s for s in avail["slots"] if s.get("available")]
    if not open_slots:
        print(json.dumps({"ok": False, "reason": "No open slots"}))
        return 1

    slot_ref = open_slots[0]["slotRef"]
    hold_res = olb_request(
        base_url,
        api_key,
        "POST",
        "/v1/holds",
        body={"facilityId": facility_id, "slotRefs": [slot_ref], "externalCustomerId": "py-cust-1"},
        tenant_id=tenant_id,
        idempotency_key=f"py-hold-{uuid.uuid4()}",
    )
    hold_id = hold_res["hold"]["id"]
    conv_res = olb_request(
        base_url,
        api_key,
        "POST",
        f"/v1/holds/{hold_id}/convert",
        body={},
        tenant_id=tenant_id,
        idempotency_key=f"py-conv-{uuid.uuid4()}",
    )
    booking_id = conv_res["booking"]["id"]
    cancel_res = olb_request(
        base_url,
        api_key,
        "POST",
        f"/v1/bookings/{booking_id}/cancel",
        body={"reason": "Python REST verification cleanup"},
        tenant_id=tenant_id,
        idempotency_key=f"py-cancel-{uuid.uuid4()}",
    )
    print(json.dumps({
        "ok": True,
        "holdId": hold_id,
        "bookingId": booking_id,
        "finalStatus": cancel_res["booking"]["status"],
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())

