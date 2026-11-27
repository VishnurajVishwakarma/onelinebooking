import { NextResponse } from "next/server";
import { jsonErrorResponse, requireConsoleSession } from "@/lib/engine";

export async function GET() {
  try {
    const { backend, session } = await requireConsoleSession();
    const organizations = await backend.platform.listOrganizationsForUser(session.user.email);
    const activeOrg =
      organizations.find((o) => o.id === session.activeOrganizationId) ?? organizations[0] ?? null;

    const projects = activeOrg
      ? await backend.platform.listProjectsForOrganization(activeOrg.id)
      : [];
    const activeProject =
      projects.find((p) => p.id === session.activeProjectId) ?? projects[0] ?? null;

    const activeEnv =
      activeProject?.environments.find((e) => e.id === session.activeEnvironmentId) ??
      activeProject?.environments.find((e) => e.type === "test") ??
      activeProject?.environments[0] ??
      null;

    const tenants = activeEnv
      ? await backend.platform.listScopedTenants(activeEnv.id, 100)
      : [];

    const projectRole =
      activeOrg && activeProject
        ? await backend.auth.requireProjectRole(
            session.user.email,
            activeOrg.id,
            activeProject.id,
            "viewer",
          )
        : activeOrg?.role ?? null;

    return NextResponse.json({
      user: session.user,
      organizations,
      activeOrg,
      projects,
      activeProject,
      activeEnv,
      projectRole,
      tenants,
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { backend, session } = await requireConsoleSession(req);
    const body = (await req.json()) as {
      organizationId?: string | null;
      projectId?: string | null;
      environmentId?: string | null;
    };
    await backend.auth.switchActiveContext({
      sessionId: session.sessionId,
      userEmail: session.user.email,
      organizationId: body.organizationId ?? null,
      projectId: body.projectId ?? null,
      environmentId: body.environmentId ?? null,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

