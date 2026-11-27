import { NextResponse } from "next/server";
import { requireAuthorizedWorkspace } from "@/lib/auth-helper";
import { jsonErrorResponse, type PlatformScope } from "@/lib/engine";

export async function GET() {
  try {
    const ctx = await requireAuthorizedWorkspace({ minRole: "viewer" });
    const keys = await ctx.backend.platform.listApiKeys(ctx.organization.id, ctx.environment.id);
    return NextResponse.json({ keys });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action: "create" | "rotate" | "revoke";
      tenantId?: string | null;
      name?: string;
      scopes?: PlatformScope[];
      keyId?: string;
    };
    const ctx = await requireAuthorizedWorkspace({
      minRole: "developer",
      tenantId: body.tenantId ?? null,
    });

    if (body.action === "create") {
      const issued = await ctx.backend.platform.createApiKey({
        organizationId: ctx.organization.id,
        projectId: ctx.project.id,
        environmentId: ctx.environment.id,
        tenantId: body.tenantId ?? ctx.tenantId,
        name: body.name ?? "API Key",
        scopes: body.scopes && body.scopes.length > 0 ? body.scopes : ["facilities:read", "availability:read", "holds:write", "bookings:write"],
        createdBy: ctx.session.user.email,
      });
      return NextResponse.json(issued, { status: 201 });
    }

    if (body.action === "rotate" && body.keyId) {
      const rotated = await ctx.backend.platform.rotateApiKey({
        organizationId: ctx.organization.id,
        keyId: body.keyId,
        revokePrevious: true,
        actorId: ctx.session.user.email,
      });
      return NextResponse.json(rotated);
    }

    if (body.action === "revoke" && body.keyId) {
      const revoked = await ctx.backend.platform.revokeApiKey({
        organizationId: ctx.organization.id,
        keyId: body.keyId,
        actorId: ctx.session.user.email,
      });
      return NextResponse.json({ apiKey: revoked });
    }

    return NextResponse.json({ error: "Invalid credentials action" }, { status: 400 });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}
