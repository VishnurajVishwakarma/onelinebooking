# `@onelinebooking/sdk` (`v1.0.0`)

Typed ESM & CommonJS TypeScript SDK for the **OneLineBooking `/v1` REST API**.

## Installation & Module Formats

- **ESM (`import`)**:
  ```ts
  import { OneLineBookingClient, verifyWebhookSignature } from "@onelinebooking/sdk/server";
  ```
- **CommonJS (`require`)**:
  ```js
  const { OneLineBookingClient } = require("@onelinebooking/sdk/server");
  ```
- **Browser-safe Client** (zero secret keys, zero Node built-ins):
  ```ts
  import { OneLineBookingPublicClient } from "@onelinebooking/sdk/browser";
  const publicSdk = new OneLineBookingPublicClient({ proxyBaseUrl: "/api/booking" });
  ```

## Security Boundary

Never ship `olb_live_*` or `olb_test_*` API keys to browsers. `OneLineBookingClient` rejects `olb_live_*` tokens if instantiated inside a browser `window` context. Use `@onelinebooking/sdk/server` inside Express/Fastify/Next.js Route Handlers and `@onelinebooking/sdk/browser` in frontend components.

## Quickstart (Server)

```ts
import { OneLineBookingClient } from "@onelinebooking/sdk/server";

const booking = new OneLineBookingClient({
  baseUrl: process.env.OLB_API_URL!,
  apiKey: process.env.OLB_API_KEY!, // olb_test_... or olb_live_...
  timeoutMs: 8000,
  maxRetries: 3, // retries GET and idempotent POST reusing the exact Idempotency-Key
});

const slots = await booking.availability.get({
  facilityId,
  fromDate: "2026-12-01",
  toDate: "2026-12-01",
});

const hold = await booking.holds.create({
  facilityId,
  externalCustomerId: "player-99",
  slotRefs: [slots.slots[0]!.slotRef],
});

const confirmed = await booking.holds.convert(hold.id, {
  expectedAmountMinor: slots.slots[0]!.amountMinor!,
  expectedCurrency: slots.slots[0]!.currency!,
});
```

## Framework Integration Examples

- **Next.js App Router Proxy (`app/api/holds/route.ts`)**: read customer session server-side, call `new OneLineBookingClient({ baseUrl, apiKey: process.env.OLB_API_KEY! }).holds.create(...)`, return hold DTO without ever leaking `OLB_API_KEY`.
- **Express Webhook Handler**: read raw JSON body (`express.raw({ type: "application/json" })`) and call `verifyWebhookSignature({ secret: process.env.OLB_WEBHOOK_SECRET!, payloadJson, signatureHeader: req.header("x-oneline-signature") ?? "" })`.

## API Reference Summary

| Namespace | Methods |
| --- | --- |
| `tenants` | `list()`, `create()` |
| `facilities` | `list()`, `create()`, `get()`, `setSchedule()`, `setSlotPolicy()`, `setPricing()` |
| `availability` | `get({ facilityId, fromDate, toDate })` |
| `holds` | `create()`, `get()`, `release()`, `convert()` |
| `bookings` | `create()`, `list()`, `get()`, `cancel()` |
| `verifyWebhookSignature` | Constant-time HMAC-SHA256 verification with 300s timestamp replay guard |

