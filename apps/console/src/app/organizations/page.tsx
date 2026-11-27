"use client";

import React, { useEffect, useState } from "react";
import { ConsoleShell } from "@/components/ConsoleShell";
import { Alert, Badge, Button, Card, Field } from "@/components/ui";

export default function OrganizationsPage() {
  const [members, setMembers] = useState<Array<{ id: string; email: string; role: string; status: string }>>([]);
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("developer");
  const [acceptToken, setAcceptToken] = useState("");
  const [projEmail, setProjEmail] = useState("");
  const [projRole, setProjRole] = useState("developer");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const loadMembers = async (orgId?: string) => {
    const res = await fetch(`/api/console/organizations${orgId ? `?organizationId=${orgId}` : ""}`);
    if (res.ok) {
      const data = await res.json();
      setMembers(data.members ?? []);
    }
  };

  useEffect(() => {
    void loadMembers();
  }, []);

  return (
    <ConsoleShell>
      {(ctx, reload) => {
        const postAction = async (payload: Record<string, unknown>) => {
          setMsg(null);
          setErr(null);
          const res = await fetch("/api/console/organizations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          const data = await res.json();
          if (!res.ok) {
            setErr(data.error ?? "Action failed");
            return;
          }
          setMsg(JSON.stringify(data));
          await reload();
          await loadMembers(ctx.activeOrg?.id);
        };

        return (
          <>
            <h1 style={{ marginTop: 0 }}>Organizations, Invitations &amp; RBAC</h1>
            {err && <Alert tone="danger">{err}</Alert>}
            {msg && <Alert tone="ok">Updated: <code>{msg}</code></Alert>}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
              <Card title="Create Organization">
                <Field label="Name"><input className="input" value={orgName} onChange={(e) => setOrgName(e.target.value)} /></Field>
                <Field label="Slug"><input className="input" value={orgSlug} onChange={(e) => setOrgSlug(e.target.value)} /></Field>
                <Button onClick={() => void postAction({ action: "create_org", name: orgName, slug: orgSlug })}>Create Organization</Button>
              </Card>

              <Card title="Invite Member (Org RBAC)">
                <Field label="Email"><input className="input" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} /></Field>
                <Field label="Role">
                  <select className="select" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}>
                    <option value="owner">owner</option>
                    <option value="admin">admin</option>
                    <option value="developer">developer</option>
                    <option value="viewer">viewer</option>
                  </select>
                </Field>
                <Button onClick={() => void postAction({ action: "invite_member", organizationId: ctx.activeOrg?.id, email: inviteEmail, role: inviteRole })}>Generate Invite Token</Button>
              </Card>

              <Card title="Assign Project RBAC Override">
                <Field label="Member Email"><input className="input" value={projEmail} onChange={(e) => setProjEmail(e.target.value)} /></Field>
                <Field label="Project Role">
                  <select className="select" value={projRole} onChange={(e) => setProjRole(e.target.value)}>
                    <option value="admin">admin</option>
                    <option value="developer">developer</option>
                    <option value="viewer">viewer</option>
                  </select>
                </Field>
                <Button onClick={() => void postAction({ action: "assign_project_role", organizationId: ctx.activeOrg?.id, projectId: ctx.activeProject?.id, email: projEmail, role: projRole })}>Assign Project Role</Button>
              </Card>

              <Card title="Accept Invitation Token">
                <Field label="Invite Token"><input className="input" value={acceptToken} onChange={(e) => setAcceptToken(e.target.value)} placeholder="olbinv_..." /></Field>
                <Button variant="secondary" onClick={() => void postAction({ action: "accept_invite", inviteToken: acceptToken })}>Accept Invitation</Button>
              </Card>
            </div>

            <Card title="Organization Members">
              <table className="table">
                <thead><tr><th>Email</th><th>Role</th><th>Status</th></tr></thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id}>
                      <td>{m.email}</td>
                      <td><Badge tone="neutral">{m.role}</Badge></td>
                      <td><Badge tone="ok">{m.status}</Badge></td>
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

