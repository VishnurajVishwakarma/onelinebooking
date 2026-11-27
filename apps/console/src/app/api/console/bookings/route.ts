import { NextResponse } from "next/server";
import { CONSOLE_ADMIN_ENGINE_CAPS, requireAuthorizedWorkspace } from "@/lib/auth-helper";
import { jsonErrorResponse } from "@/lib/engine";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const tenantParam = url.searchParams.get("tenantId");
    const bookingId = url.searchParams.get("bookingId");
    const statusFilter = url.searchParams.get("status");
    const customerFilter = url.searchParams.get("customerId");

    const ctx = await requireAuthorizedWorkspace({ minRole: "viewer", tenantId: tenantParam });
    if (!ctx.tenantId) {
      return NextResponse.json({ bookings: [], customers: [], history: [] });
    }

    const client = ctx.backend.engine.forTenant({
      tenantId: ctx.tenantId,
      actor: { id: ctx.session.user.id, type: "admin", capabilities: [...CONSOLE_ADMIN_ENGINE_CAPS] },
    });

    if (bookingId) {
      const [booking, history] = await Promise.all([
        client.getBooking(bookingId),
        client.getBookingHistory("booking", bookingId),
      ]);
      return NextResponse.json({ booking, history });
    }

    const [page, customers] = await Promise.all([
      client.listBookings({
        limit: 50,
        ...(statusFilter ? { status: statusFilter } : {}),
        ...(customerFilter ? { externalCustomerId: customerFilter } : {}),
      }),
      ctx.backend.platform.listCustomersSummary(ctx.tenantId, 100),
    ]);

    return NextResponse.json({
      tenantId: ctx.tenantId,
      bookings: page.items,
      nextCursor: page.nextCursor,
      customers,
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action: "cancel" | "complete" | "no_show";
      tenantId?: string;
      bookingId: string;
      reason?: string;
    };
    const ctx = await requireAuthorizedWorkspace({
      req,
      minRole: "developer",
      tenantId: body.tenantId ?? null,
    });
    if (!ctx.tenantId) {
      return NextResponse.json({ error: "No tenant selected" }, { status: 400 });
    }

    const client = ctx.backend.engine.forTenant({
      tenantId: ctx.tenantId,
      actor: { id: ctx.session.user.id, type: "admin", capabilities: [...CONSOLE_ADMIN_ENGINE_CAPS] },
    });

    if (body.action === "cancel") {
      const booking = await client.cancelBooking({
        bookingId: body.bookingId,
        reason: body.reason ?? "Cancelled via Developer Console",
        overrideCancellationPolicy: true,
      });
      return NextResponse.json({ booking });
    }
    if (body.action === "complete") {
      const booking = await client.completeBooking(body.bookingId);
      return NextResponse.json({ booking });
    }
    if (body.action === "no_show") {
      const booking = await client.markNoShow(body.bookingId);
      return NextResponse.json({ booking });
    }
    return NextResponse.json({ error: "Unsupported booking lifecycle action" }, { status: 400 });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

