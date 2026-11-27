import { NextResponse } from "next/server";
import { jsonErrorResponse, requireConsoleSession } from "@/lib/engine";

export async function POST(req: Request) {
  try {
    const { backend, session } = await requireConsoleSession(req);
    const body = (await req.json()) as {
      action: "create_project" | "create_tenant";
      organizationId?: string;
      projectId?: string;
      environmentId?: string;
      name: string;
      slug?: string;
    };

    const orgId = body.organizationId ?? session.activeOrganizationId ?? "";
    if (body.action === "create_project") {
      await backend.auth.requireOrganizationRole(session.user.email, orgId, "admin");
      const created = await backend.platform.createProjectWithEnvironments({
        organizationId: orgId,
        name: body.name,
        slug: body.slug ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        actorId: session.user.email,
      });
      await backend.auth.switchActiveContext({
        sessionId: session.sessionId,
        userEmail: session.user.email,
        organizationId: orgId,
        projectId: created.project.id,
        environmentId: created.testEnvironment.id,
      });
      return NextResponse.json(created, { status: 201 });
    }

    const projId = body.projectId ?? session.activeProjectId ?? "";
    const envId = body.environmentId ?? session.activeEnvironmentId ?? "";
    await backend.auth.requireProjectRole(session.user.email, orgId, projId, "developer");
    const tenant = await backend.platform.createScopedTenant({
      organizationId: orgId,
      projectId: projId,
      environmentId: envId,
      name: body.name,
      actorId: session.user.email,
    });
    return NextResponse.json({ tenant }, { status: 201 });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

