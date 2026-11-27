import "dotenv/config";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import {
  ALL_PLATFORM_SCOPES,
  OneLineBookingClient,
  OutboxWebhookWorker,
  PlatformService,
  PostgresBookingStore,
  TimeSlotEngine,
  createBookingPool,
  createPlatformHttpServer,
  runMigrations,
  verifyWebhookSignature,
} from "../src/index.js";

/**
 * End-to-end Developer Quickstart demonstrating SaaS onboarding, REST API,
 * Developer SDK, Hold->Convert flow, and HMAC-signed webhook verification.
 */
async function main(): Promise<void> {
  const pool = createBookingPool(undefined, { max: 10 });
  await runMigrations(pool);
  const store = new PostgresBookingStore(pool);
  const engine = new TimeSlotEngine(store);
  const platform = new PlatformService(pool, { ssrfOptions: { allowLocalHttpForTesting: true } });

  // 1. Provision developer org, project, and live tenant + API key
  const tag = randomUUID().slice(0, 8);
  const { organization } = await platform.createOrganization({
    name: `Quickstart Studio ${tag}`,
    slug: `quickstart-${tag}`,
    ownerEmail: `dev-${tag}@example.com`,
  });
  const project = await platform.createProjectWithEnvironments({
    organizationId: organization.id,
    name: "Arcade Cloud",
    slug: `arcade-${tag}`,
  });
  const tenant = await platform.createScopedTenant({
    organizationId: organization.id,
    projectId: project.project.id,
    environmentId: project.liveEnvironment.id,
    name: "Flagship Venue",
  });
  const credential = await platform.createApiKey({
    organizationId: organization.id,
    projectId: project.project.id,
    environmentId: project.liveEnvironment.id,
    tenantId: tenant.id,
    name: "Backend Server Key",
    scopes: ALL_PLATFORM_SCOPES,
  });

  // 2. Start API HTTP server + webhook receiver
  const apiServer = createPlatformHttpServer({ pool, engine, platform });
  const receivedEvents: string[] = [];
  let webhookSecret = "";

  const webhookReceiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const payload = Buffer.concat(chunks).toString("utf8");
      const valid = verifyWebhookSignature({
        secret: webhookSecret,
        payloadJson: payload,
        signatureHeader: String(req.headers["x-oneline-signature"] ?? ""),
      });
      if (valid) {
        const evt = JSON.parse(payload) as { type: string; id: string };
        receivedEvents.push(`${evt.type}:${evt.id}`);
      }
      res.statusCode = valid ? 200 : 400;
      res.end("ok");
    });
  });

  await new Promise<void>((r) => apiServer.listen(0, "127.0.0.1", () => r()));
  await new Promise<void>((r) => webhookReceiver.listen(0, "127.0.0.1", () => r()));
  const apiBase = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
  const hookBase = `http://127.0.0.1:${(webhookReceiver.address() as AddressInfo).port}`;

  try {
    // 3. Use Developer TypeScript SDK
    const client = new OneLineBookingClient({
      baseUrl: apiBase,
      apiKey: credential.token,
    });

    const endpoint = await client.webhooks.createEndpoint({ url: `${hookBase}/events` });
    webhookSecret = endpoint.signingSecret;

    const location = await client.facilities.createLocation({
      name: "Main Floor",
      timeZone: "UTC",
      city: "San Francisco",
      country: "US",
    });
    const facility = await client.facilities.create({
      name: "Sim Rig Alpha",
      category: "racing_sim",
      timeZone: "UTC",
    });
    await client.facilities.attachLocation(facility.id, {
      locationId: location.id,
      resourceKind: "simulator",
    });

    const dateStr = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    const weekday = ((new Date(`${dateStr}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    await client.facilities.setSchedule(facility.id, [
      {
        weekday,
        opensAt: "10:00",
        closesAt: "18:00",
        endDayOffset: 0,
        effectiveFrom: dateStr,
        effectiveUntil: null,
        breaks: [],
      },
    ]);
    await client.facilities.setSlotPolicy(facility.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 90,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 4,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 3,
    });
    await client.facilities.setPricing(facility.id, { amountMinor: 2500, currency: "USD" });

    const availability = await client.availability.get({
      facilityId: facility.id,
      fromDate: dateStr,
      toDate: dateStr,
    });
    const hold = await client.holds.create({
      facilityId: facility.id,
      externalCustomerId: "player-42",
      slotRefs: [availability.slots[0]!.slotRef],
    });
    const booking = await client.holds.convert(hold.id, {
      expectedAmountMinor: 2500,
      expectedCurrency: "USD",
    });

    // Dispatch transactional outbox webhook events
    const worker = new OutboxWebhookWorker({
      pool,
      engine,
      platform,
      tenantFilter: [tenant.id],
      ssrfOptions: { allowLocalHttpForTesting: true },
    });
    await worker.runOnce();
    const usage = await client.usage.getSummary();

    console.log(
      JSON.stringify(
        {
          organizationId: organization.id,
          environment: project.liveEnvironment.type,
          tenantId: tenant.id,
          bookingId: booking.id,
          bookingStatus: booking.status,
          verifiedWebhookEvents: receivedEvents,
          usageMetrics: usage.metrics,
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all([
      new Promise<void>((r) => apiServer.close(() => r())),
      new Promise<void>((r) => webhookReceiver.close(() => r())),
    ]);
    await pool.end();
  }
}

void main();
