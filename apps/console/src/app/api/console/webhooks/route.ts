import { NextResponse } from "next/server";
import { requireAuthorizedWorkspace } from "@/lib/auth-helper";
import { jsonErrorResponse } from "@/lib/engine";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const tenantParam = url.searchParams.get("tenantId");
    const ctx = await requireAuthorizedWorkspace({ minRole: "viewer", tenantId: tenantParam });
    if (!ctx.tenantId) {
      return NextResponse.json({ endpoints: [], deliveries: [] });
    }
    const [endpoints, deliveries] = await Promise.all([
      ctx.backend.platform.listWebhookEndpoints(ctx.environment.id, ctx.tenantId),
      ctx.backend.platform.listWebhookDeliveries({
        environmentId: ctx.environment.id,
        tenantId: ctx.tenantId,
        limit: 50,
      }),
    ]);
    return NextResponse.json({ tenantId: ctx.tenantId, endpoints, deliveries });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action: "create_endpoint" | "rotate_secret" | "disable_endpoint" | "replay_delivery";
      tenantId?: string;
      url?: string;
      description?: string;
      eventTypes?: string[];
      endpointId?: string;
      deliveryId?: string;
    };
    const ctx = await requireAuthorizedWorkspace({
      req,
      minRole: "developer",
      tenantId: body.tenantId ?? null,
    });
    if (!ctx.tenantId) {
      return NextResponse.json({ error: "No tenant selected" }, { status: 400 });
    }

    if (body.action === "create_endpoint") {
      const created = await ctx.backend.platform.createWebhookEndpoint({
        organizationId: ctx.organization.id,
        projectId: ctx.project.id,
        environmentId: ctx.environment.id,
        tenantId: ctx.tenantId,
        url: body.url ?? "",
        description: body.description,
        eventTypes: body.eventTypes,
      });
      return NextResponse.json(created, { status: 201 });
    }
    if (body.action === "rotate_secret" && body.endpointId) {
      const rotated = await ctx.backend.platform.rotateWebhookSecret({
        environmentId: ctx.environment.id,
        tenantId: ctx.tenantId,
        endpointId: body.endpointId,
        actorId: ctx.session.user.email,
      });
      return NextResponse.json(rotated);
    }
    if (body.action === "disable_endpoint" && body.endpointId) {
      const endpoint = await ctx.backend.platform.disableWebhookEndpoint(
        ctx.environment.id,
        ctx.tenantId,
        body.endpointId,
      );
      return NextResponse.json({ endpoint });
    }
    if (body.action === "replay_delivery" && body.deliveryId) {
      const delivery = await ctx.backend.platform.replayWebhookDelivery(
        ctx.environment.id,
        ctx.tenantId,
        body.deliveryId,
      );
      return NextResponse.json({ delivery });
    }

    return NextResponse.json({ error: "Invalid webhook action" }, { status: 400 });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

