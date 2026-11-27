"use client";

import React, { useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Alert, Badge, Button, Card, Field } from "@/components/ui";

export default function HomePage() {
  const [organizationName, setOrganizationName] = useState("Nexus Gaming");
  const [projectName, setProjectName] = useState("Arena Booking");
  const [venueName, setVenueName] = useState("Downtown Venue");
  const [facilityName, setFacilityName] = useState("VR Pod 01");
  const [timeZone, setTimeZone] = useState("UTC");
  const [wizardResult, setWizardResult] = useState<{ testApiKeyToken: string; facility: { id: string }; tenant: { id: string } } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <ConsoleShell>
      {(ctx, reload) => {
        const runWizard = async (e: React.FormEvent) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const res = await fetch("/api/console/onboarding", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ organizationName, projectName, venueName, facilityName, timeZone }),
            });
            const data = await res.json();
            if (!res.ok) {
              setError(data.error ?? "Wizard failed");
              return;
            }
            setWizardResult(data);
            await reload();
          } finally {
            setBusy(false);
          }
        };

        return (
          <>
            <h1 style={{ marginTop: 0 }}>Workspace Overview &amp; Developer Onboarding Wizard</h1>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
              <Card title="Organizations">
                <div style={{ fontSize: 28, fontWeight: 700 }}>{ctx.organizations.length}</div>
              </Card>
              <Card title="Projects in Org">
                <div style={{ fontSize: 28, fontWeight: 700 }}>{ctx.projects.length}</div>
              </Card>
              <Card title="Active Environment">
                <Badge tone={ctx.activeEnv?.type === "live" ? "danger" : "ok"}>
                  {ctx.activeEnv ? `${ctx.activeEnv.name} (${ctx.activeEnv.type})` : "None"}
                </Badge>
              </Card>
              <Card title="Scoped Tenants">
                <div style={{ fontSize: 28, fontWeight: 700 }}>{ctx.tenants.length}</div>
              </Card>
            </div>

            {error && <Alert tone="danger">{error}</Alert>}
            {wizardResult && (
              <Alert tone="ok">
                Provisioned tenant <code>{wizardResult.tenant.id}</code>, facility <code>{wizardResult.facility.id}</code>, and one-time Test API key: <code>{wizardResult.testApiKeyToken}</code>
              </Alert>
            )}

            <Card
              title="One-Click Onboarding Wizard"
              subtitle="Creates Organization, Project (Test + Live environments), Business Tenant, Facility (schedule + pricing), and a scoped Test API credential."
            >
              <form onSubmit={(e) => void runWizard(e)} style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12 }}>
                <Field label="Organization Name" htmlFor="wiz-org">
                  <input id="wiz-org" className="input" value={organizationName} onChange={(e) => setOrganizationName(e.target.value)} required />
                </Field>
                <Field label="Project Name" htmlFor="wiz-proj">
                  <input id="wiz-proj" className="input" value={projectName} onChange={(e) => setProjectName(e.target.value)} required />
                </Field>
                <Field label="Tenant / Venue Name" htmlFor="wiz-venue">
                  <input id="wiz-venue" className="input" value={venueName} onChange={(e) => setVenueName(e.target.value)} required />
                </Field>
                <Field label="First Facility / Station" htmlFor="wiz-fac">
                  <input id="wiz-fac" className="input" value={facilityName} onChange={(e) => setFacilityName(e.target.value)} required />
                </Field>
                <Field label="Time Zone (IANA)" htmlFor="wiz-tz">
                  <input id="wiz-tz" className="input" value={timeZone} onChange={(e) => setTimeZone(e.target.value)} required />
                </Field>
                <div style={{ alignSelf: "end", marginBottom: 12 }}>
                  <Button type="submit" disabled={busy}>
                    {busy ? "Provisioning..." : "Provision Full Environment"}
                  </Button>
                </div>
              </form>
            </Card>
          </>
        );
      }}
    </ConsoleShell>
  );
}

