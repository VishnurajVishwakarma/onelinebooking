import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { CONSOLE_ADMIN_ENGINE_CAPS, requireAuthorizedWorkspace } from "@/lib/auth-helper";
import { jsonErrorResponse } from "@/lib/engine";

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      operation: "getAvailability" | "createHold" | "convertHold" | "listBookings";
      tenantId?: string;
      params?: Record<string, unknown>;
    };

    // Strict security rule: Interactive API Playground NEVER runs in live environments
    const ctx = await requireAuthorizedWorkspace({
      minRole: "developer",
      tenantId: body.tenantId ?? null,
      requireTestEnvironment: true,
    });
    if (!ctx.tenantId) {
      return NextResponse.json({ error: "No test tenant found" }, { status: 400 });
    }

    const client = ctx.backend.engine.forTenant({
      tenantId: ctx.tenantId,
      correlationId: `pg_${randomUUID()}`,
      actor: { id: `playground:${ctx.session.user.id}`, type: "admin", capabilities: [...CONSOLE_ADMIN_ENGINE_CAPS] },
    });
    const p = body.params ?? {};

    let result: unknown;
    if (body.operation === "getAvailability") {
      result = await client.getAvailability(p);
    } else if (body.operation === "createHold") {
      result = await client.createHold(p, {
        idempotencyKey: String(p.idempotencyKey ?? `pg-hold-${randomUUID()}`),
      });
    } else if (body.operation === "convertHold") {
      result = await client.convertHoldToBooking(p, {
        idempotencyKey: String(p.idempotencyKey ?? `pg-conv-${randomUUID()}`),
      });
    } else if (body.operation === "listBookings") {
      result = await client.listBookings(p);
    } else {
      return NextResponse.json({ error: "Unsupported playground operation" }, { status: 400 });
    }

    await ctx.backend.platform.recordUsage({
      organizationId: ctx.organization.id,
      projectId: ctx.project.id,
      environmentId: ctx.environment.id,
      tenantId: ctx.tenantId,
      metric: "api_request",
      idempotencyKey: `playground:${randomUUID()}`,
      metadata: { operation: body.operation, source: "console_playground" },
    });

    return NextResponse.json({ environmentType: ctx.environment.type, result });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

