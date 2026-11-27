"use client";

import React, { useEffect, useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Alert, Badge, Button, Card, Field } from "@/components/ui";

export default function WebhooksPage() {
  const [endpoints, setEndpoints] = useState<Array<{ id: string; url: string; active: boolean; eventTypes: string[] }>>([]);
  const [deliveries, setDeliveries] = useState<Array<{ id: string; eventType: string; status: string; attempts: number; responseStatus: number | null; lastError: string | null }>>([]);
  const [url, setUrl] = useState("");
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    const res = await fetch("/api/console/webhooks");
    if (res.ok) {
      const d = await res.json();
      setEndpoints(d.endpoints ?? []);
      setDeliveries(d.deliveries ?? []);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const act = async (payload: Record<string, unknown>) => {
    setErr(null);
    setRevealedSecret(null);
    const res = await fetch("/api/console/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await res.json();
    if (!res.ok) {
      setErr(d.error ?? "Webhook action failed");
      return;
    }
    if (d.signingSecret) setRevealedSecret(d.signingSecret);
    await load();
  };

  return (
    <ConsoleShell>
      {() => (
        <>
          <h1 style={{ marginTop: 0 }}>Webhooks, Secret Rotation &amp; Delivery Replay</h1>
          {err && <Alert tone="danger">{err}</Alert>}
          {revealedSecret && (
            <Alert tone="ok">
              Signing secret (encrypted at rest via AES-256-GCM; shown once): <code>{revealedSecret}</code>
            </Alert>
          )}

          <Card title="Register SSRF-Protected Webhook Endpoint" subtitle="HTTPS required; private, loopback, link-local, and cloud metadata IPs are blocked.">
            <Field label="Destination URL"><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://webhooks.example.com/oneline" /></Field>
            <Button onClick={() => void act({ action: "create_endpoint", url })}>Add Endpoint</Button>
          </Card>

          <Card title="Configured Endpoints">
            <table className="table">
              <thead><tr><th>URL</th><th>Status</th><th>Actions</th></tr></thead>
              <tbody>
                {endpoints.map((ep) => (
                  <tr key={ep.id}>
                    <td><code>{ep.url}</code></td>
                    <td><Badge tone={ep.active ? "ok" : "danger"}>{ep.active ? "active" : "disabled"}</Badge></td>
                    <td style={{ display: "flex", gap: 6 }}>
                      {ep.active && (
                        <>
                          <Button variant="secondary" onClick={() => void act({ action: "rotate_secret", endpointId: ep.id })}>Rotate Secret</Button>
                          <Button variant="danger" onClick={() => void act({ action: "disable_endpoint", endpointId: ep.id })}>Disable</Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Delivery History">
            <table className="table">
              <thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>HTTP</th><th>Last Error</th><th>Replay</th></tr></thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td><code>{d.eventType}</code></td>
                    <td><Badge tone={d.status === "delivered" ? "ok" : d.status === "dead_letter" ? "danger" : "warn"}>{d.status}</Badge></td>
                    <td>{d.attempts}</td>
                    <td>{d.responseStatus ?? "-"}</td>
                    <td>{d.lastError ?? "-"}</td>
                    <td><Button variant="secondary" onClick={() => void act({ action: "replay_delivery", deliveryId: d.id })}>Replay</Button></td>
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

