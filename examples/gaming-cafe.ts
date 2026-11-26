import "dotenv/config";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import {
  ALL_ADMIN_CAPABILITIES,
  createBookingPool,
  PostgresBookingStore,
  TimeSlotEngine,
} from "../src/index.js";

const pool = createBookingPool();

try {
  const store = new PostgresBookingStore(pool);
  const engine = new TimeSlotEngine(store);

  const tenant = await engine.createTenant({ name: "Pixel Lounge Demo" });
  const client = engine.forTenant({
    tenantId: tenant.id,
    actor: {
      id: "demo-admin",
      type: "admin",
      capabilities: ALL_ADMIN_CAPABILITIES,
    },
    correlationId: `demo-${randomUUID()}`,
  });

  const facility = await client.createFacility({
    name: "PC Station 01",
    category: "gaming-pc",
    timeZone: "Asia/Kolkata",
  });

  const effectiveFrom = DateTime.now().setZone(facility.timeZone).toISODate()!;
  await client.setSchedule(
    facility.id,
    Array.from({ length: 7 }, (_, index) => ({
      weekday: index + 1,
      opensAt: "10:00",
      closesAt: "22:00",
      endDayOffset: 0,
      effectiveFrom,
      effectiveUntil: null,
      breaks: [{ startsAt: "14:00", endsAt: "14:30", startDayOffset: 0, endDayOffset: 0 }],
    })),
  );
  await client.setSlotPolicy(facility.id, {
    durationMinutes: 60,
    intervalMinutes: 60,
    minNoticeMinutes: 30,
    maxAdvanceDays: 30,
    bufferBeforeMinutes: 0,
    bufferAfterMinutes: 0,
    maxSlotsPerBooking: 6,
    defaultHoldMinutes: 5,
    maxActiveHoldsPerCustomer: 3,
  });
  await client.setPricing({
    facilityId: facility.id,
    amountMinor: 15000,
    currency: "INR",
  });
  await client.setCancellationPolicy({
    facilityId: facility.id,
    customerCancellationAllowed: true,
    minNoticeMinutes: 60,
    adminOverrideAllowed: true,
  });

  const localDate = DateTime.now().setZone(facility.timeZone).plus({ days: 1 }).toISODate()!;
  const availability = await client.getAvailability({
    facilityIds: [facility.id],
    localDate,
  });
  const firstSlot = availability.slots.find((slot) => slot.available);
  if (!firstSlot) throw new Error("No available slot was returned for the demo date");

  const hold = await client.createHold(
    {
      facilityId: facility.id,
      slotRefs: [firstSlot.slotRef],
      externalCustomerId: "customer_demo_01",
      expectedAmountMinor: firstSlot.amountMinor ?? 15000,
      expectedCurrency: firstSlot.currency ?? "INR",
    },
    { idempotencyKey: `hold-${randomUUID()}` },
  );

  const confirmed = await client.convertHoldToBooking(
    {
      holdId: hold.id,
      expectedAmountMinor: hold.totalMinor,
      expectedCurrency: hold.currency,
      externalPaymentRef: "pay_demo_01",
    },
    { idempotencyKey: `confirm-${randomUUID()}` },
  );

  process.stdout.write(JSON.stringify({ tenant, facility, localDate, hold, confirmed }, null, 2) + "\n");
} finally {
  await pool.end();
}
