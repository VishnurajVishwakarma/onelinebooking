"use client";

import React, { useEffect, useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Badge, Card } from "@/components/ui";

export default function ObservabilityPage() {
  const [data, setData] = useState<{
    usageMetrics: Array<{ metric: string; totalQuantity: number; recordCount: number }>;
    requestLogs: Array<{ id: string; method: string; pathTemplate: string; statusCode: number; durationMs: number; errorCode: string | null; createdAt: string }>;
    auditLogs: Array<{ id: string; action: string; actorId: string; targetType: string; recordedAt: string }>;
    readiness: { ready: boolean; pendingOutboxEvents: number; maxHoldExpirationLagSeconds: number; deadLetterWebhookCount: number; activeConnections: number; maxConnections: number } | null;
  }>({ usageMetrics: [], requestLogs: [], auditLogs: [], readiness: null });

  useEffect(() => {
    void fetch("/api/console/telemetry").then(async (r) => {
      if (r.ok) setData(await r.json());
    });
  }, []);

  return (
    <ConsoleShell>
      {() => (
        <>
          <h1 style={{ marginTop: 0 }}>Usage Analytics, API Logs &amp; Security Audit Trail</h1>

          {data.readiness && (
            <Card title="Platform Readiness Snapshot">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 16 }}>
                <Badge tone={data.readiness.ready ? "ok" : "danger"}>{data.readiness.ready ? "READY" : "DEGRADED"}</Badge>
                <span>DB Connections: {data.readiness.activeConnections}/{data.readiness.maxConnections}</span>
                <span>Pending Outbox: {data.readiness.pendingOutboxEvents}</span>
                <span>Max Hold Lag: {data.readiness.maxHoldExpirationLagSeconds}s</span>
                <span>Webhook DLQ: {data.readiness.deadLetterWebhookCount}</span>
              </div>
            </Card>
          )}

          <Card title="Usage Analytics (Append-Only Deduplicated Ledger)">
            <table className="table">
              <thead><tr><th>Metric</th><th>Total Quantity</th><th>Records</th></tr></thead>
              <tbody>
                {data.usageMetrics.map((m) => (
                  <tr key={m.metric}><td><code>{m.metric}</code></td><td>{m.totalQuantity}</td><td>{m.recordCount}</td></tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Recent API Request Logs (PII & Credentials Redacted)">
            <table className="table">
              <thead><tr><th>Method</th><th>Path</th><th>Status</th><th>Duration</th><th>Error</th><th>Time</th></tr></thead>
              <tbody>
                {data.requestLogs.map((l) => (
                  <tr key={l.id}>
                    <td><code>{l.method}</code></td>
                    <td><code>{l.pathTemplate}</code></td>
                    <td><Badge tone={l.statusCode < 400 ? "ok" : "danger"}>{l.statusCode}</Badge></td>
                    <td>{l.durationMs} ms</td>
                    <td>{l.errorCode ?? "-"}</td>
                    <td>{l.createdAt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="Control-Plane Audit Logs">
            <table className="table">
              <thead><tr><th>Action</th><th>Actor</th><th>Target</th><th>Timestamp</th></tr></thead>
              <tbody>
                {data.auditLogs.map((a) => (
                  <tr key={a.id}>
                    <td><code>{a.action}</code></td>
                    <td>{a.actorId}</td>
                    <td>{a.targetType}</td>
                    <td>{a.recordedAt}</td>
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

