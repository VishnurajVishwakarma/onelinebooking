"use client";

import React, { useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Alert, Button, Card, Field } from "@/components/ui";

const SDK_SNIPPET = `import { OneLineBookingClient } from "@onelinebooking/sdk/server";

const olb = new OneLineBookingClient({
  baseUrl: process.env.OLB_API_URL!,
  apiKey: process.env.OLB_API_KEY!,
});

const availability = await olb.availability.get({
  facilityId: "<facility-uuid>",
  fromDate: "2026-12-01",
  toDate: "2026-12-01",
});

const hold = await olb.holds.create({
  facilityId: "<facility-uuid>",
  slotRefs: [availability.slots[0].slotRef],
  externalCustomerId: "player-42",
});

const booking = await olb.holds.convert(hold.id);`;

export default function PlaygroundPage() {
  const [operation, setOperation] = useState<"getAvailability" | "listBookings">("listBookings");
  const [facilityId, setFacilityId] = useState("");
  const [fromDate, setFromDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [output, setOutput] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);

  const runPlayground = async () => {
    setErr(null);
    const params =
      operation === "getAvailability"
        ? { facilityId, fromDate, toDate: fromDate }
        : { limit: 20 };
    const res = await fetch("/api/console/playground", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation, params }),
    });
    const d = await res.json();
    if (!res.ok) {
      setErr(d.error ?? "Playground execution blocked");
      return;
    }
    setOutput(JSON.stringify(d, null, 2));
  };

  return (
    <ConsoleShell>
      {(ctx) => {
        const isLive = ctx.activeEnv?.type === "live";
        return (
          <>
            <h1 style={{ marginTop: 0 }}>Interactive Test Playground &amp; SDK Integration</h1>

            {isLive && (
              <Alert tone="danger">
                Interactive playground is disabled in LIVE environments. Switch to a TEST environment in the header bar.
              </Alert>
            )}
            {err && <Alert tone="danger">{err}</Alert>}

            <Card title="Interactive API Playground (Test Environments Only)">
              <Field label="Operation">
                <select className="select" value={operation} onChange={(e) => setOperation(e.target.value as "getAvailability" | "listBookings")}>
                  <option value="listBookings">bookings.list()</option>
                  <option value="getAvailability">availability.get()</option>
                </select>
              </Field>
              {operation === "getAvailability" && (
                <>
                  <Field label="Facility UUID"><input className="input" value={facilityId} onChange={(e) => setFacilityId(e.target.value)} /></Field>
                  <Field label="Date"><input className="input" type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} /></Field>
                </>
              )}
              <Button disabled={isLive} onClick={() => void runPlayground()}>Execute Test Request</Button>
              {output && (
                <pre style={{ background: "#0f172a", color: "#e2e8f0", padding: 14, borderRadius: 8, overflowX: "auto", marginTop: 14 }}>
                  {output}
                </pre>
              )}
            </Card>

            <Card title="Server-Side @onelinebooking/sdk Quickstart">
              <pre style={{ background: "#0f172a", color: "#e2e8f0", padding: 14, borderRadius: 8, overflowX: "auto" }}>
                {SDK_SNIPPET}
              </pre>
            </Card>
          </>
        );
      }}
    </ConsoleShell>
  );
}

