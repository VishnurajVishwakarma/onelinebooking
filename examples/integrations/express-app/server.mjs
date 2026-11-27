import { randomUUID } from "node:crypto";
import express from "express";
import { OneLineBookingApiError, OneLineBookingClient } from "@onelinebooking/sdk/server";

export function createExpressIntegrationApp(config) {
  const app = express();
  app.use(express.json());

  const olb = new OneLineBookingClient({
    baseUrl: config.apiBaseUrl,
    apiKey: config.apiKey,
    tenantId: config.tenantId,
  });

  app.get("/api/availability", async (req, res, next) => {
    try {
      const data = await olb.availability.get({
        facilityId: String(req.query.facilityId || ""),
        fromDate: String(req.query.fromDate || ""),
        toDate: String(req.query.toDate || req.query.fromDate || ""),
      });
      res.json(data);
    } catch (err) {
      next(err);
    }
  });

  app.post("/api/book", async (req, res, next) => {
    try {
      const idemBase = req.header("idempotency-key") || `exp_${randomUUID()}`;
      const hold = await olb.holds.create(
        {
          facilityId: req.body.facilityId,
          slotRefs: req.body.slotRefs,
          externalCustomerId: req.body.customerId,
        },
        { idempotencyKey: `${idemBase}:hold` },
      );
      const booking = await olb.holds.convert(
        hold.id,
        {},
        { idempotencyKey: `${idemBase}:convert` },
      );
      res.status(201).json({ holdId: hold.id, booking });
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    if (err instanceof OneLineBookingApiError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: err?.message || "Internal error" });
  });

  return app;
}

