"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Badge, Button } from "./ui";

export interface ConsoleContextState {
  user: { id: string; email: string; name: string };
  organizations: Array<{ id: string; name: string; slug: string; role: string }>;
  activeOrg: { id: string; name: string; role: string } | null;
  projects: Array<{ id: string; name: string; slug: string; environments: Array<{ id: string; type: "test" | "live"; name: string }> }>;
  activeProject: { id: string; name: string; environments: Array<{ id: string; type: "test" | "live"; name: string }> } | null;
  activeEnv: { id: string; type: "test" | "live"; name: string } | null;
  projectRole: string | null;
  tenants: Array<{ id: string; name: string; status: string }>;
}

const NAV_ITEMS = [
  { href: "/", label: "Overview & Wizard" },
  { href: "/organizations", label: "Organizations & RBAC" },
  { href: "/projects", label: "Projects & Tenants" },
  { href: "/credentials", label: "API Credentials" },
  { href: "/facilities", label: "Facilities & Availability" },
  { href: "/bookings", label: "Bookings & Customers" },
  { href: "/webhooks", label: "Webhooks" },
  { href: "/observability", label: "Usage & Logs" },
  { href: "/playground", label: "Playground & SDK" },
];

export function ConsoleShell({
  children,
}: {
  children: (ctx: ConsoleContextState, reload: () => Promise<void>) => React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [ctx, setCtx] = useState<ConsoleContextState | null>(null);
  const [loading, setLoading] = useState(true);

  const loadContext = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/console/context");
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      if (res.ok) {
        setCtx((await res.json()) as ConsoleContextState);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadContext();
  }, []);

  const switchContext = async (next: {
    organizationId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  }) => {
    await fetch("/api/console/context", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    });
    await loadContext();
  };

  const logout = async () => {
    await fetch("/api/console/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "logout" }),
    });
    router.push("/login");
  };

  if (loading && !ctx) {
    return (
      <main style={{ padding: 48, maxWidth: 640, margin: "0 auto" }}>
        <p>Loading developer workspace...</p>
      </main>
    );
  }

  if (!ctx) return null;

  return (
    <div className="layout-shell">
      <aside className="sidebar" aria-label="Console Navigation">
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fff" }}>OneLineBooking</div>
          <div style={{ fontSize: 12, color: "#94a3b8" }}>Infrastructure Console</div>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-link${pathname === item.href ? " active" : ""}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div style={{ marginTop: "auto", fontSize: 12, color: "#94a3b8" }}>
          Signed in as <strong style={{ color: "#e2e8f0" }}>{ctx.user.email}</strong>
        </div>
      </aside>

      <div>
        <header className="topbar">
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 10 }}>
            <label style={{ fontSize: 12, fontWeight: 600 }}>
              Org{" "}
              <select
                aria-label="Active Organization"
                className="select"
                style={{ width: "auto", display: "inline-block", marginLeft: 4 }}
                value={ctx.activeOrg?.id ?? ""}
                onChange={(e) =>
                  void switchContext({ organizationId: e.target.value, projectId: null, environmentId: null })
                }
              >
                {ctx.organizations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name} ({o.role})
                  </option>
                ))}
              </select>
            </label>

            <label style={{ fontSize: 12, fontWeight: 600 }}>
              Project{" "}
              <select
                aria-label="Active Project"
                className="select"
                style={{ width: "auto", display: "inline-block", marginLeft: 4 }}
                value={ctx.activeProject?.id ?? ""}
                onChange={(e) =>
                  void switchContext({
                    organizationId: ctx.activeOrg?.id ?? null,
                    projectId: e.target.value,
                    environmentId: null,
                  })
                }
              >
                {ctx.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ fontSize: 12, fontWeight: 600 }}>
              Env{" "}
              <select
                aria-label="Active Environment"
                className="select"
                style={{ width: "auto", display: "inline-block", marginLeft: 4 }}
                value={ctx.activeEnv?.id ?? ""}
                onChange={(e) =>
                  void switchContext({
                    organizationId: ctx.activeOrg?.id ?? null,
                    projectId: ctx.activeProject?.id ?? null,
                    environmentId: e.target.value,
                  })
                }
              >
                {(ctx.activeProject?.environments ?? []).map((env) => (
                  <option key={env.id} value={env.id}>
                    {env.name} ({env.type.toUpperCase()})
                  </option>
                ))}
              </select>
            </label>

            {ctx.activeEnv && (
              <Badge tone={ctx.activeEnv.type === "live" ? "danger" : "ok"}>
                {ctx.activeEnv.type.toUpperCase()} MODE
              </Badge>
            )}
            {ctx.projectRole && <Badge tone="neutral">Role: {ctx.projectRole}</Badge>}
          </div>

          <Button variant="secondary" onClick={() => void logout()}>
            Sign Out
          </Button>
        </header>

        <main className="main-content">{children(ctx, loadContext)}</main>
      </div>
    </div>
  );
}

