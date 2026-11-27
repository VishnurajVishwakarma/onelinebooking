#!/usr/bin/env bash
set -euo pipefail

: "${OLB_API_URL:?Set OLB_API_URL (e.g. http://127.0.0.1:4100)}"
: "${OLB_API_KEY:?Set OLB_API_KEY (e.g. olb_test_...)}"
: "${OLB_FACILITY_ID:?Set OLB_FACILITY_ID}"
: "${OLB_DATE:?Set OLB_DATE (YYYY-MM-DD)}"

TENANT_HDR=()
if [ -n "${OLB_TENANT_ID:-}" ]; then
  TENANT_HDR=(-H "X-Tenant-Id: $OLB_TENANT_ID")
fi

AVAIL_JSON=$(curl -sSf "$OLB_API_URL/v1/availability?facilityId=$OLB_FACILITY_ID&fromDate=$OLB_DATE&toDate=$OLB_DATE" \
  -H "Authorization: Bearer $OLB_API_KEY" "${TENANT_HDR[@]}")

SLOT_REF=$(printf '%s' "$AVAIL_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); const s=d.slots.find(x=>x.available); if(!s) process.exit(2); console.log(s.slotRef);")

IDEM_H="curl-hold-$(date +%s)-$$"
HOLD_JSON=$(curl -sSf -X POST "$OLB_API_URL/v1/holds" \
  -H "Authorization: Bearer $OLB_API_KEY" \
  -H "Idempotency-Key: $IDEM_H" \
  -H "Content-Type: application/json" \
  "${TENANT_HDR[@]}" \
  -d "{\"facilityId\":\"$OLB_FACILITY_ID\",\"slotRefs\":[\"$SLOT_REF\"],\"externalCustomerId\":\"curl-cust-1\"}")

HOLD_ID=$(printf '%s' "$HOLD_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.hold.id);")

IDEM_C="curl-conv-$(date +%s)-$$"
BOOKING_JSON=$(curl -sSf -X POST "$OLB_API_URL/v1/holds/$HOLD_ID/convert" \
  -H "Authorization: Bearer $OLB_API_KEY" \
  -H "Idempotency-Key: $IDEM_C" \
  -H "Content-Type: application/json" \
  "${TENANT_HDR[@]}" \
  -d '{}')

BOOKING_ID=$(printf '%s' "$BOOKING_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.booking.id);")

IDEM_X="curl-cancel-$(date +%s)-$$"
CANCEL_JSON=$(curl -sSf -X POST "$OLB_API_URL/v1/bookings/$BOOKING_ID/cancel" \
  -H "Authorization: Bearer $OLB_API_KEY" \
  -H "Idempotency-Key: $IDEM_X" \
  -H "Content-Type: application/json" \
  "${TENANT_HDR[@]}" \
  -d '{"reason":"cURL quickstart verification"}')

FINAL_STATUS=$(printf '%s' "$CANCEL_JSON" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log(d.booking.status);")
echo "{\"ok\":true,\"holdId\":\"$HOLD_ID\",\"bookingId\":\"$BOOKING_ID\",\"finalStatus\":\"$FINAL_STATUS\"}"
