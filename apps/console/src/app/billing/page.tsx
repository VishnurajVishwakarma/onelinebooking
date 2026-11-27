"use client";

import React, { useEffect, useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Alert, Badge, Button, Card } from "@/components/ui";

export default function BillingPage() {
  const [data, setData] = useState<{
    plans: Array<{ id: string; slug: string; name: string; version: number; monthly_base_minor: number; included_bookings: number; overage_policy: string }>;
    subscription: { id: string; status: string; trial_ends_at: string | null } | null;
    invoices: Array<{ id: string; total_minor: number; currency: string; status: string; created_at: string }>;
    quota: { bookingsUsed: number; bookingsQuota: number; apiRequestsUsed: number; apiRequestsQuota: number; allowed: boolean } | null;
  }>({ plans: [], subscription: null, invoices: [], quota: null });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/console/billing");
    if (res.ok) setData(await res.json());
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (payload: Record<string, unknown>) => {
    setErr(null);
    setMsg(null);
    const res = await fetch("/api/console/billing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!res.ok) {
      setErr(d.error ?? "Billing action failed");
      return;
    }
    setMsg("Billing updated");
    await load();
  };

  return (
    <ConsoleShell>
      {() => (
        <>
          <h1 style={{ marginTop: 0 }}>Billing, Plans, Quotas &amp; Invoices</h1>
          {err && <Alert tone="danger">{err}</Alert>}
          {msg && <Alert tone="ok">{msg}</Alert>}

          {data.quota && (
            <Card title="Quota Entitlement & Usage Summary">
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <Badge tone={data.quota.allowed ? "ok" : "danger"}>{data.quota.allowed ? "WITHIN QUOTA" : "CAPPED"}</Badge>
                <span>Bookings: {data.quota.bookingsUsed} / {data.quota.bookingsQuota}</span>
                <span>API Requests: {data.quota.apiRequestsUsed} / {data.quota.apiRequestsQuota}</span>
                <span>Subscription: {data.subscription?.status ?? "none"}</span>
              </div>
            </Card>
          )}

          <Card
            title="Configurable Plan Catalog"
            actions={<Button onClick={() => void act({ action: "create_plan", slug: `growth-${Date.now()}`, name: "Growth Plan", monthlyBaseMinor: 4900, includedBookings: 2500 })}>Add Growth Plan</Button>}
          >
            <table className="table">
              <thead><tr><th>Plan</th><th>Version</th><th>Base</th><th>Included Bookings</th><th>Overage</th><th>Subscribe</th></tr></thead>
              <tbody>
                {data.plans.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name} (<code>{p.slug}</code>)</td>
                    <td>v{p.version}</td>
                    <td>{p.monthly_base_minor} minor</td>
                    <td>{p.included_bookings}</td>
                    <td>{p.overage_policy}</td>
                    <td><Button variant="secondary" onClick={() => void act({ action: "subscribe", planVersionId: p.id })}>Start Trial</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card
            title="Invoices"
            actions={<Button variant="secondary" onClick={() => void act({ action: "generate_invoice" })}>Generate Invoice</Button>}
          >
            <table className="table">
              <thead><tr><th>Invoice</th><th>Total</th><th>Status</th><th>Created</th></tr></thead>
              <tbody>
                {data.invoices.map((inv) => (
                  <tr key={inv.id}>
                    <td><code>{inv.id.slice(0, 8)}...</code></td>
                    <td>{inv.total_minor} {inv.currency}</td>
                    <td><Badge tone={inv.status === "paid" ? "ok" : "warn"}>{inv.status}</Badge></td>
                    <td>{inv.created_at}</td>
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

