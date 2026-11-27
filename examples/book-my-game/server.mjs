import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OneLineBookingApiError, OneLineBookingClient, verifyWebhookSignature } from "../../packages/sdk/dist/esm/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * "Book My Game" Pilot Reference Application.
 * Consumes OneLineBooking strictly through its public REST API and @onelinebooking/sdk/server.
 * Zero direct database access or internal engine imports.
 */
export function createBookMyGameApp(config) {
  const sdk = new OneLineBookingClient({
    baseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
    timeoutMs: 10_000,
    maxRetries: 2,
  });

  const apiBaseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  const apiKey = config.apiKey;
  const tenantId = config.tenantId;
  const html = readFileSync(join(__dirname, "public", "index.html"), "utf8");
  const webhookEvents = [];

  function send(res, status, data) {
    const body = JSON.stringify(data);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Length", Buffer.byteLength(body));
    res.end(body);
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    return { raw, data: raw ? JSON.parse(raw) : {} };
  }

  async function apiCall(method, path, payload) {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `bmg_${randomUUID()}`,
    };
    if (tenantId) headers["X-Tenant-Id"] = tenantId;
    const res = await fetch(`${apiBaseUrl}${path}`, {
      method,
      headers,
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
    const parsed = await res.json();
    if (!res.ok) {
      throw new OneLineBookingApiError(res.status, parsed.error ?? { code: "INTERNAL_ERROR", category: "infrastructure", message: "API failed", retryable: false });
    }
    return parsed;
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" && url.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }

      // Gaming cafe onboarding: multiple outlets (locations) + PC and Console inventory
      if (method === "POST" && url.pathname === "/api/pilot/onboard") {
        const { data } = await readBody(req);
        const dateStr = data.effectiveFrom || new Date().toISOString().slice(0, 10);
        const outletNames = Array.isArray(data.outlets) && data.outlets.length > 0
          ? data.outlets
          : ["Downtown Hub", "Westside Arena"];
        const locations = [];
        const inventory = [];

        for (const outletName of outletNames) {
          const locRes = await apiCall("POST", "/v1/locations", {
            name: outletName,
            timeZone: data.timeZone || "UTC",
            city: data.city || "Bengaluru",
            country: "IN",
          });
          locations.push(locRes.location);

          for (const item of [
            { name: `${outletName} — RTX PC Bay 1`, category: "gaming_pc", priceMinor: 12000, kind: "pc" },
            { name: `${outletName} — PS5 Lounge 1`, category: "console_ps5", priceMinor: 18000, kind: "console" },
          ]) {
            const fac = await sdk.facilities.create({
              name: item.name,
              category: item.category,
              timeZone: data.timeZone || "UTC",
              metadata: { outlet: outletName, kind: item.kind },
            });
            await apiCall("POST", `/v1/facilities/${encodeURIComponent(fac.id)}/location`, {
              locationId: locRes.location.id,
              resourceKind: item.kind,
            });
            await sdk.facilities.setSchedule(
              fac.id,
              [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
                weekday,
                opensAt: "09:00",
                closesAt: "23:00",
                endDayOffset: 0,
                effectiveFrom: dateStr,
                effectiveUntil: null,
                breaks: [],
              })),
            );
            await sdk.facilities.setSlotPolicy(fac.id, {
              durationMinutes: 60,
              intervalMinutes: 60,
              minNoticeMinutes: 0,
              maxAdvanceDays: 90,
              bufferBeforeMinutes: 0,
              bufferAfterMinutes: 0,
              maxSlotsPerBooking: 4,
              defaultHoldMinutes: 5,
              maxActiveHoldsPerCustomer: 5,
            });
            await sdk.facilities.setPricing(fac.id, { amountMinor: item.priceMinor, currency: "INR" });
            inventory.push(fac);
          }
        }

        send(res, 201, { locations, inventory });
        return;
      }

      if (method === "GET" && url.pathname === "/api/pilot/inventory") {
        const list = await sdk.facilities.list();
        send(res, 200, list);
        return;
      }

      if (method === "GET" && url.pathname === "/api/pilot/availability") {
        const facilityId = url.searchParams.get("facilityId") ?? "";
        const fromDate = url.searchParams.get("fromDate") ?? "";
        const toDate = url.searchParams.get("toDate") ?? fromDate;
        const avail = await sdk.availability.get({ facilityId, fromDate, toDate });
        send(res, 200, avail);
        return;
      }

      // Online customer reservation. This only places a hold.
      // Booking confirmation and payment status stay separate: this app never
      // marks a charge paid and never invents a gateway reference.
      if (method === "POST" && url.pathname === "/api/pilot/reserve/online") {
        const { data } = await readBody(req);
        const holdInput = {
          facilityId: data.facilityId,
          slotRefs: data.slotRefs,
          externalCustomerId: data.customerId,
        };
        if (data.expectedAmountMinor !== undefined || data.expectedCurrency !== undefined) {
          holdInput.expectedAmountMinor = data.expectedAmountMinor;
          holdInput.expectedCurrency = data.expectedCurrency;
        }
        const hold = await sdk.holds.create(holdInput, { idempotencyKey: data.idempotencyKey });
        send(res, 201, {
          mode: "online",
          booking: null,
          hold,
          payment: {
            status: "awaiting_provider",
            confirmed: false,
            simulated: false,
            method: data.paymentMethod || "upi_online",
          },
        });
        return;
      }

      // Explicit customer hold (allows deferred payment confirmation or expiry testing)
      if (method === "POST" && url.pathname === "/api/pilot/holds") {
        const { data } = await readBody(req);
        const hold = await sdk.holds.create(
          {
            facilityId: data.facilityId,
            slotRefs: data.slotRefs,
            externalCustomerId: data.customerId,
            holdMinutes: data.holdMinutes,
          },
          { idempotencyKey: data.idempotencyKey },
        );
        send(res, 201, { hold });
        return;
      }

      const confirmHoldMatch = /^\/api\/pilot\/holds\/([^/]+)\/confirm$/.exec(url.pathname);
      if (method === "POST" && confirmHoldMatch) {
        const { data } = await readBody(req);
        const paymentRef = typeof data.paymentRef === "string" ? data.paymentRef.trim() : "";
        const simulated = data.paymentSimulation === true;
        if (simulated && paymentRef) {
          send(res, 422, {
            error: "Send either a provider paymentRef or paymentSimulation, not both.",
            payment: { status: "unverified", confirmed: false, simulated: false },
          });
          return;
        }
        if (!paymentRef && !simulated) {
          send(res, 422, {
            error: "Verify the charge with the payment provider and pass its paymentRef. This app does not invent gateway ids or mark payment confirmed. Set paymentSimulation true only for an explicitly labelled demo conversion.",
            payment: { status: "unverified", confirmed: false, simulated: false },
          });
          return;
        }
        const convertInput = {
          expectedAmountMinor: data.expectedAmountMinor,
          expectedCurrency: data.expectedCurrency,
        };
        if (paymentRef) convertInput.externalPaymentRef = paymentRef;
        const booking = await sdk.holds.convert(confirmHoldMatch[1], convertInput, {
          idempotencyKey: data.idempotencyKey,
        });
        send(res, 200, {
          booking,
          payment: simulated
            ? { status: "simulated", confirmed: false, simulated: true, paymentRef: null }
            : { status: "reference_recorded", confirmed: false, simulated: false, paymentRef },
        });
        return;
      }

      // Receptionist walk-in / cash / pay-at-counter reservation (Direct Booking)
      if (method === "POST" && url.pathname === "/api/pilot/reserve/walk-in") {
        const { data } = await readBody(req);
        const paymentMode =
          data.cashPaid === true
            ? "cash_paid"
            : data.payAtCounter === false
              ? "prepaid"
              : "pay_at_counter";
        const receiptNumber =
          data.receiptNumber ?? (paymentMode === "cash_paid" ? `CASH-${Date.now()}` : `COUNTER-${Date.now()}`);
        const booking = await apiCall("POST", "/v1/bookings", {
          facilityId: data.facilityId,
          slotRefs: data.slotRefs,
          externalCustomerId: data.customerId,
          externalPaymentRef: `${paymentMode}:${receiptNumber}`,
          metadata: {
            channel: "receptionist_walk_in",
            paymentMode,
            cashAmountMinor: data.cashAmountMinor ?? null,
            receiptNumber,
            receptionist: data.receptionistId || "front-desk",
          },
        });
        send(res, 201, { mode: `walk_in_${paymentMode}`, receiptNumber, ...booking });
        return;
      }

      // Admin pricing update via public SDK
      if (method === "PUT" && url.pathname === "/api/pilot/pricing") {
        const { data } = await readBody(req);
        const pricing = await sdk.facilities.setPricing(data.facilityId, {
          amountMinor: Number(data.amountMinor),
          currency: data.currency || "INR",
        });
        send(res, 200, { pricing });
        return;
      }

      // Booking cancellation
      const cancelMatch = /^\/api\/pilot\/bookings\/([^/]+)\/cancel$/.exec(url.pathname);
      if (method === "POST" && cancelMatch) {
        const { data } = await readBody(req);
        const cancelled = await sdk.bookings.cancel(cancelMatch[1], {
          reason: data.reason || "Customer requested cancellation",
        });
        send(res, 200, { booking: cancelled });
        return;
      }

      // Maintenance blackout creation via REST API
      if (method === "POST" && url.pathname === "/api/pilot/blackouts") {
        const { data } = await readBody(req);
        const blackoutRes = await apiCall(
          "POST",
          `/v1/facilities/${encodeURIComponent(data.facilityId)}/blackouts`,
          {
            startsAt: data.startsAt,
            endsAt: data.endsAt,
            reason: data.reason || "Hardware Maintenance",
          },
        );
        send(res, 201, blackoutRes);
        return;
      }

      // Customer booking history
      const custMatch = /^\/api\/pilot\/customers\/([^/]+)\/bookings$/.exec(url.pathname);
      if (method === "GET" && custMatch) {
        const page = await sdk.bookings.list({
          externalCustomerId: decodeURIComponent(custMatch[1]),
          limit: 50,
        });
        send(res, 200, { ...page, recentWebhooks: webhookEvents.slice(0, 10) });
        return;
      }

      if (method === "POST" && url.pathname === "/api/pilot/webhooks") {
        const { raw, data } = await readBody(req);
        if (
          config.webhookSecret &&
          !verifyWebhookSignature({
            secret: config.webhookSecret,
            payloadJson: raw,
            signatureHeader: String(req.headers["x-oneline-signature"] ?? ""),
          })
        ) {
          send(res, 401, { error: "Invalid webhook signature" });
          return;
        }
        webhookEvents.unshift({ id: data.id, type: data.type });
        send(res, 200, { ok: true });
        return;
      }

      send(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof OneLineBookingApiError) {
        send(res, err.status, { error: err.message, code: err.code });
        return;
      }
      send(res, 500, { error: err instanceof Error ? err.message : "Server error" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4400);
  const apiBaseUrl = process.env.OLB_API_URL || "http://127.0.0.1:4100";
  const apiKey = process.env.OLB_API_KEY || "";
  if (!apiKey) {
    console.error("Set OLB_API_URL and OLB_API_KEY to start Book My Game");
    process.exit(1);
  }
  createBookMyGameApp({
    apiBaseUrl,
    apiKey,
    tenantId: process.env.OLB_TENANT_ID,
    webhookSecret: process.env.OLB_WEBHOOK_SECRET,
  }).listen(port, "127.0.0.1", () => {
    console.log(`Book My Game pilot running at http://127.0.0.1:${port}`);
  });
}

