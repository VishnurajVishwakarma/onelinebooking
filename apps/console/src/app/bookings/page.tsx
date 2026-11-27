"use client";

import React, { useEffect, useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Alert, Badge, Button, Card } from "@/components/ui";

export default function BookingsPage() {
  const [bookings, setBookings] = useState<Array<{ id: string; facilityId: string; status: string; externalCustomerId: string | null; totalMinor: number; currency: string; startsAt: string }>>([]);
  const [customers, setCustomers] = useState<Array<{ customerId: string; bookingCount: number; activeHoldCount: number; lastActivityAt: string | null }>>([]);
  const [history, setHistory] = useState<Array<{ id: string; action: string; priorState: string | null; newState: string | null; decisionAt: string }>>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/console/bookings");
    if (res.ok) {
      const d = await res.json();
      setBookings(d.bookings ?? []);
      setCustomers(d.customers ?? []);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const inspectBooking = async (bookingId: string) => {
    setSelectedId(bookingId);
    const res = await fetch(`/api/console/bookings?bookingId=${encodeURIComponent(bookingId)}`);
    if (res.ok) setHistory((await res.json()).history ?? []);
  };

  const transition = async (bookingId: string, action: "cancel" | "complete" | "no_show") => {
    setErr(null);
    const res = await fetch("/api/console/bookings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bookingId, action }),
    });
    const d = await res.json();
    if (!res.ok) {
      setErr(d.error ?? "Transition failed");
      return;
    }
    await load();
    await inspectBooking(bookingId);
  };

  return (
    <ConsoleShell>
      {() => (
        <>
          <h1 style={{ marginTop: 0 }}>Bookings &amp; Customer Explorer</h1>
          {err && <Alert tone="danger">{err}</Alert>}

          <Card title="Recent Bookings">
            <table className="table">
              <thead><tr><th>Booking ID</th><th>Customer</th><th>Start</th><th>Total</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {bookings.map((b) => (
                  <tr key={b.id}>
                    <td><code>{b.id.slice(0, 8)}...</code></td>
                    <td>{b.externalCustomerId ?? "anonymous"}</td>
                    <td>{b.startsAt}</td>
                    <td>{b.totalMinor} {b.currency}</td>
                    <td><Badge tone={b.status === "confirmed" || b.status === "completed" ? "ok" : "warn"}>{b.status}</Badge></td>
                    <td style={{ display: "flex", gap: 6 }}>
                      <Button variant="secondary" onClick={() => void inspectBooking(b.id)}>History</Button>
                      {b.status === "confirmed" && (
                        <>
                          <Button variant="secondary" onClick={() => void transition(b.id, "complete")}>Complete</Button>
                          <Button variant="danger" onClick={() => void transition(b.id, "cancel")}>Cancel</Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {selectedId && (
            <Card title={`Lifecycle Audit History (${selectedId})`}>
              <table className="table">
                <thead><tr><th>Action</th><th>From &rarr; To</th><th>Timestamp</th></tr></thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td><code>{h.action}</code></td>
                      <td>{h.priorState ?? "-"} &rarr; {h.newState ?? "-"}</td>
                      <td>{h.decisionAt}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <Card title="Customer Explorer">
            <table className="table">
              <thead><tr><th>Customer ID</th><th>Bookings</th><th>Active Holds</th><th>Last Activity</th></tr></thead>
              <tbody>
                {customers.map((c) => (
                  <tr key={c.customerId}>
                    <td><code>{c.customerId}</code></td>
                    <td>{c.bookingCount}</td>
                    <td>{c.activeHoldCount}</td>
                    <td>{c.lastActivityAt ?? "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </ConsoleShell>
  );
}

