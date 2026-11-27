"use client";

import React, { useEffect, useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Alert, Badge, Button, Card, Field } from "@/components/ui";

const ALL_SCOPES = [
  "tenants:read", "tenants:write", "facilities:read", "facilities:write",
  "availability:read", "holds:read", "holds:write", "bookings:read",
  "bookings:write", "webhooks:read", "webhooks:write", "usage:read",
];

export default function CredentialsPage() {
  const [keys, setKeys] = useState<Array<{ id: string; name: string; keyPrefix: string; status: string; environmentType: string; scopes: string[]; lastUsedAt: string | null }>>([]);
  const [name, setName] = useState("Backend Key");
  const [selectedScopes, setSelectedScopes] = useState<string[]>(["facilities:read", "availability:read", "holds:write", "bookings:write"]);
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadKeys = async () => {
    const res = await fetch("/api/console/credentials");
    if (res.ok) setKeys((await res.json()).keys ?? []);
  };

  useEffect(() => {
    void loadKeys();
  }, []);

  const act = async (payload: Record<string, unknown>) => {
    setErr(null);
    setRevealedToken(null);
    const res = await fetch("/api/console/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) {
      setErr(data.error ?? "Credential operation failed");
      return;
    }
    if (data.token) setRevealedToken(data.token);
    await loadKeys();
  };

  const toggleScope = (s: string) => {
    setSelectedScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  };

  return (
    <ConsoleShell>
      {(ctx) => (
        <>
          <h1 style={{ marginTop: 0 }}>API Credentials ({ctx.activeEnv?.type.toUpperCase()})</h1>
          {err && <Alert tone="danger">{err}</Alert>}
          {revealedToken && (
            <Alert tone="ok">
              Copy this one-time secret token now (never stored in plaintext): <code>{revealedToken}</code>
            </Alert>
          )}

          <Card title="Issue Scoped API Credential">
            <Field label="Key Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 14 }}>
              {ALL_SCOPES.map((s) => (
                <label key={s} style={{ fontSize: 13, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <input type="checkbox" checked={selectedScopes.includes(s)} onChange={() => toggleScope(s)} />
                  <code>{s}</code>
                </label>
              ))}
            </div>
            <Button onClick={() => void act({ action: "create", name, scopes: selectedScopes })}>Generate API Key</Button>
          </Card>

          <Card title="Active & Historical Keys">
            <table className="table">
              <thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Status</th><th>Last Used</th><th>Actions</th></tr></thead>
              <tbody>
                {keys.map((k) => (
                  <tr key={k.id}>
                    <td>{k.name}</td>
                    <td><code>{k.keyPrefix}</code></td>
                    <td>{k.scopes.join(", ")}</td>
                    <td><Badge tone={k.status === "active" ? "ok" : "danger"}>{k.status}</Badge></td>
                    <td>{k.lastUsedAt ?? "Never"}</td>
                    <td style={{ display: "flex", gap: 6 }}>
                      {k.status === "active" && (
                        <>
                          <Button variant="secondary" onClick={() => void act({ action: "rotate", keyId: k.id })}>Rotate</Button>
                          <Button variant="danger" onClick={() => void act({ action: "revoke", keyId: k.id })}>Revoke</Button>
                        </>
                      )}
                    </td>
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

