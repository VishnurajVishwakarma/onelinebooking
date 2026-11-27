import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { OneLineBookingClient, OneLineBookingApiError, verifyWebhookSignature } from "../../packages/sdk/dist/esm/server.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Creates the Gaming Cafe Reference Web Application server.
 * Communicates strictly through the public REST API via @onelinebooking/sdk/server
 * with ZERO direct database access or private engine imports.
 */
export function createGamingCafeApp(config) {
  const sdk = new OneLineBookingClient({
    baseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
    timeoutMs: 8_000,
    maxRetries: 2,
  });

  const webhookSecret = config.webhookSecret ?? "";
  const receivedWebhookEvents = [];
  const indexHtml = readFileSync(join(__dirname, "public", "index.html"), "utf8");

  function json(res, status, data) {
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
    return raw ? { raw, json: JSON.parse(raw) } : { raw: "", json: {} };
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = (req.method ?? "GET").toUpperCase();

      if (method === "GET" && url.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(indexHtml);
        return;
      }

      if (method === "GET" && url.pathname === "/api/facilities") {
        const list = await sdk.facilities.list();
        json(res, 200, list);
        return;
      }

      if (method === "GET" && url.pathname === "/api/availability") {
        const facilityId = url.searchParams.get("facilityId") ?? "";
        const fromDate = url.searchParams.get("fromDate") ?? "";
        const toDate = url.searchParams.get("toDate") ?? fromDate;
        const avail = await sdk.availability.get({ facilityId, fromDate, toDate });
        json(res, 200, avail);
        return;
      }

      if (method === "POST" && url.pathname === "/api/holds") {
        const { json: body } = await readBody(req);
        const hold = await sdk.holds.create(
          {
            facilityId: body.facilityId,
            slotRefs: body.slotRefs,
            externalCustomerId: body.customerName || "walkin-gamer",
          },
          { idempotencyKey: body.idempotencyKey },
        );
        json(res, 201, { hold });
        return;
      }

      const convertMatch = /^\/api\/holds\/([^/]+)\/convert$/.exec(url.pathname);
      if (method === "POST" && convertMatch) {
        const { json: body } = await readBody(req);
        const booking = await sdk.holds.convert(
          convertMatch[1],
          {
            expectedAmountMinor: body.expectedAmountMinor,
            expectedCurrency: body.expectedCurrency,
          },
          { idempotencyKey: body.idempotencyKey },
        );
        json(res, 200, { booking });
        return;
      }

      if (method === "GET" && url.pathname === "/api/bookings") {
        const bookings = await sdk.bookings.list({ limit: 25 });
        json(res, 200, { ...bookings, recentWebhooks: receivedWebhookEvents.slice(0, 10) });
        return;
      }

      if (method === "POST" && url.pathname === "/api/webhooks/oneline") {
        const { raw } = await readBody(req);
        const sigHeader = String(req.headers["x-oneline-signature"] ?? "");
        if (
          webhookSecret &&
          !verifyWebhookSignature({
            secret: webhookSecret,
            payloadJson: raw,
            signatureHeader: sigHeader,
          })
        ) {
          json(res, 401, { error: "Invalid webhook signature" });
          return;
        }
        const parsed = JSON.parse(raw);
        receivedWebhookEvents.unshift({
          eventId: parsed.id,
          type: parsed.type,
          occurredAt: parsed.occurredAt,
        });
        json(res, 200, { ok: true });
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err) {
      if (err instanceof OneLineBookingApiError) {
        json(res, err.status, { error: err.message, code: err.code });
        return;
      }
      json(res, 500, { error: err instanceof Error ? err.message : "Server error" });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const apiBaseUrl = process.env.OLB_API_URL || "http://127.0.0.1:4100";
  const apiKey = process.env.OLB_API_KEY || "";
  const port = Number(process.env.PORT || 4200);
  if (!apiKey) {
    console.error("Set OLB_API_URL and OLB_API_KEY environment variables to run gaming-cafe-web.");
    process.exit(1);
  }
  const server = createGamingCafeApp({
    apiBaseUrl,
    apiKey,
    tenantId: process.env.OLB_TENANT_ID,
    webhookSecret: process.env.OLB_WEBHOOK_SECRET,
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Gaming Cafe Reference App running at http://127.0.0.1:${port}`);
  });
}

