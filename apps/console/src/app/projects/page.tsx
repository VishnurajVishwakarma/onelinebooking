"use client";

import React, { useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Alert, Badge, Button, Card, Field } from "@/components/ui";

export default function ProjectsPage() {
  const [projName, setProjName] = useState("");
  const [projSlug, setProjSlug] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <ConsoleShell>
      {(ctx, reload) => {
        const submit = async (payload: Record<string, unknown>) => {
          setMsg(null);
          setErr(null);
          const res = await fetch("/api/console/projects", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) {
            setErr(data.error ?? "Failed");
            return;
          }
          setMsg("Created successfully");
          await reload();
        };

        return (
          <>
            <h1 style={{ marginTop: 0 }}>Projects, Environments &amp; Scoped Tenants</h1>
            {err && <Alert tone="danger">{err}</Alert>}
            {msg && <Alert tone="ok">{msg}</Alert>}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
              <Card title="Create Project (Auto-provisions Test & Live)">
                <Field label="Project Name"><input className="input" value={projName} onChange={(e) => setProjName(e.target.value)} /></Field>
                <Field label="Project Slug"><input className="input" value={projSlug} onChange={(e) => setProjSlug(e.target.value)} /></Field>
                <Button onClick={() => void submit({ action: "create_project", name: projName, slug: projSlug })}>Create Project</Button>
              </Card>

              <Card title="Provision Scoped Business Tenant" subtitle={`Active environment: ${ctx.activeEnv?.name ?? "None"} (${ctx.activeEnv?.type ?? "-"})`}>
                <Field label="Tenant Name"><input className="input" value={tenantName} onChange={(e) => setTenantName(e.target.value)} /></Field>
                <Button onClick={() => void submit({ action: "create_tenant", name: tenantName })}>Create Scoped Tenant</Button>
              </Card>
            </div>

            <Card title="Projects in Active Organization">
              <table className="table">
                <thead><tr><th>Project</th><th>Slug</th><th>Environments</th></tr></thead>
                <tbody>
                  {ctx.projects.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td><code>{p.slug}</code></td>
                      <td>{p.environments.map((e) => <span key={e.id} style={{ marginRight: 6 }}><Badge tone={e.type === "live" ? "danger" : "ok"}>{e.type}</Badge></span>)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card title="Business Tenants in Active Environment">
              <table className="table">
                <thead><tr><th>ID</th><th>Name</th><th>Status</th></tr></thead>
                <tbody>
                  {ctx.tenants.map((t) => (
                    <tr key={t.id}>
                      <td><code>{t.id}</code></td>
                      <td>{t.name}</td>
                      <td><Badge tone="ok">{t.status}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        );
      }}
    </ConsoleShell>
  );
}

