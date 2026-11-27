import { NextResponse } from "next/server";
import { jsonErrorResponse, requireConsoleSession } from "@/lib/engine";

export async function GET(req: Request) {
  try {
    const { backend, session } = await requireConsoleSession();
    const url = new URL(req.url);
    const orgId = url.searchParams.get("organizationId") ?? session.activeOrganizationId;
    const organizations = await backend.platform.listOrganizationsForUser(session.user.email);
    const members = orgId
      ? await (async () => {
          await backend.auth.requireOrganizationRole(session.user.email, orgId, "viewer");
          return backend.platform.listOrganizationMembers(orgId);
        })()
      : [];
    return NextResponse.json({ organizations, members });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const { backend, session } = await requireConsoleSession(req);
    const body = (await req.json()) as {
      action: "create_org" | "invite_member" | "accept_invite" | "assign_project_role";
      name?: string;
      slug?: string;
      organizationId?: string;
      projectId?: string;
      email?: string;
      role?: "owner" | "admin" | "developer" | "viewer";
      inviteToken?: string;
    };

    if (body.action === "create_org") {
      const created = await backend.platform.createOrganization({
        name: body.name ?? "",
        slug: body.slug ?? "",
        ownerEmail: session.user.email,
      });
      await backend.auth.switchActiveContext({
        sessionId: session.sessionId,
        userEmail: session.user.email,
        organizationId: created.organization.id,
        projectId: null,
        environmentId: null,
      });
      return NextResponse.json(created, { status: 201 });
    }

    if (body.action === "invite_member") {
      const orgId = body.organizationId ?? session.activeOrganizationId ?? "";
      const invite = await backend.auth.createOrganizationInvitation({
        organizationId: orgId,
        email: body.email ?? "",
        role: body.role ?? "developer",
        invitedByUserId: session.user.id,
        invitedByEmail: session.user.email,
      });
      return NextResponse.json(invite, { status: 201 });
    }

    if (body.action === "accept_invite") {
      const accepted = await backend.auth.acceptOrganizationInvitation({
        inviteToken: body.inviteToken ?? "",
        userId: session.user.id,
        userEmail: session.user.email,
      });
      return NextResponse.json(accepted);
    }

    if (body.action === "assign_project_role") {
      const orgId = body.organizationId ?? session.activeOrganizationId ?? "";
      const projId = body.projectId ?? session.activeProjectId ?? "";
      await backend.auth.assignProjectRole({
        organizationId: orgId,
        projectId: projId,
        actorEmail: session.user.email,
        targetEmail: body.email ?? "",
        role: (body.role === "owner" ? "admin" : body.role) ?? "developer",
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

