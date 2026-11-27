import { NextResponse } from "next/server";
import { CONSOLE_ADMIN_ENGINE_CAPS, requireAuthorizedWorkspace } from "@/lib/auth-helper";
import { jsonErrorResponse } from "@/lib/engine";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const tenantParam = url.searchParams.get("tenantId");
    const facilityId = url.searchParams.get("facilityId");
    const fromDate = url.searchParams.get("fromDate");
    const toDate = url.searchParams.get("toDate") ?? fromDate;

    const ctx = await requireAuthorizedWorkspace({ minRole: "viewer", tenantId: tenantParam });
    if (!ctx.tenantId) {
      return NextResponse.json({ facilities: [], locations: [], availability: null });
    }

    const client = ctx.backend.engine.forTenant({
      tenantId: ctx.tenantId,
      actor: { id: ctx.session.user.id, type: "admin", capabilities: [...CONSOLE_ADMIN_ENGINE_CAPS] },
    });

    if (facilityId && fromDate) {
      const availability = await client.getAvailability({
        facilityIds: [facilityId],
        fromDate,
        toDate: toDate ?? fromDate,
      });
      return NextResponse.json({ availability });
    }

    const [facilities, locations] = await Promise.all([
      client.listFacilities({ includeInactive: true }),
      ctx.backend.platform.listLocations(ctx.tenantId),
    ]);
    return NextResponse.json({ tenantId: ctx.tenantId, facilities, locations });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action:
        | "create_facility"
        | "create_location"
        | "set_schedule"
        | "set_slot_policy"
        | "set_pricing"
        | "set_cancellation_policy"
        | "create_blackout";
      tenantId?: string;
      facilityId?: string;
      payload?: Record<string, unknown>;
    };

    const ctx = await requireAuthorizedWorkspace({
      minRole: "developer",
      tenantId: body.tenantId ?? null,
    });
    if (!ctx.tenantId) {
      return NextResponse.json({ error: "Create a tenant first" }, { status: 400 });
    }

    const client = ctx.backend.engine.forTenant({
      tenantId: ctx.tenantId,
      actor: { id: ctx.session.user.id, type: "admin", capabilities: [...CONSOLE_ADMIN_ENGINE_CAPS] },
    });
    const p = body.payload ?? {};

    if (body.action === "create_location") {
      const location = await ctx.backend.platform.createLocation({
        tenantId: ctx.tenantId,
        name: String(p.name ?? ""),
        timeZone: String(p.timeZone ?? "UTC"),
        city: typeof p.city === "string" ? p.city : undefined,
        country: typeof p.country === "string" ? p.country : undefined,
      });
      return NextResponse.json({ location }, { status: 201 });
    }

    if (body.action === "create_facility") {
      const facility = await client.createFacility(p);
      return NextResponse.json({ facility }, { status: 201 });
    }
    if (body.action === "set_schedule" && body.facilityId) {
      const result = await client.setSchedule(body.facilityId, (p.windows as unknown[]) ?? []);
      return NextResponse.json(result);
    }
    if (body.action === "set_slot_policy" && body.facilityId) {
      const result = await client.setSlotPolicy(body.facilityId, p);
      return NextResponse.json(result);
    }
    if (body.action === "set_pricing" && body.facilityId) {
      const result = await client.setPricing({ facilityId: body.facilityId, ...p });
      return NextResponse.json(result);
    }
    if (body.action === "set_cancellation_policy" && body.facilityId) {
      const result = await client.setCancellationPolicy({ facilityId: body.facilityId, ...p });
      return NextResponse.json(result);
    }
    if (body.action === "create_blackout" && body.facilityId) {
      const result = await client.createBlackout({ facilityId: body.facilityId, ...p });
      return NextResponse.json(result, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid facility action" }, { status: 400 });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

