import { NextResponse } from "next/server";
import { ALL_PLATFORM_SCOPES, jsonErrorResponse, requireConsoleSession } from "@/lib/engine";

export async function POST(req: Request) {
  try {
    const { backend, session } = await requireConsoleSession(req);
    const body = (await req.json()) as {
      organizationName: string;
      projectName: string;
      venueName: string;
      facilityName: string;
      timeZone?: string;
    };

    const slug = `${body.organizationName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)}-${Date.now().toString(36)}`;
    const { organization } = await backend.platform.createOrganization({
      name: body.organizationName || "My Studio",
      slug,
      ownerEmail: session.user.email,
    });
    const proj = await backend.platform.createProjectWithEnvironments({
      organizationId: organization.id,
      name: body.projectName || "Booking App",
      slug: "default-app",
      actorId: session.user.email,
    });
    const tenant = await backend.platform.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      name: body.venueName || "Flagship Venue",
      actorId: session.user.email,
    });
    await backend.platform.createScopedTenant({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.liveEnvironment.id,
      name: body.venueName || "Flagship Venue",
      actorId: session.user.email,
    });

    const tz = body.timeZone || "UTC";
    const engineClient = backend.engine.forTenant({
      tenantId: tenant.id,
      actor: { id: session.user.id, type: "admin", capabilities: ["facility:write", "schedule:write", "facility:read"] },
    });
    const facility = await engineClient.createFacility({
      name: body.facilityName || "Station 1",
      category: "station",
      timeZone: tz,
    });
    const today = new Date().toISOString().slice(0, 10);
    await engineClient.setSchedule(
      facility.id,
      [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
        weekday,
        opensAt: "09:00",
        closesAt: "21:00",
        endDayOffset: 0 as const,
        effectiveFrom: today,
        effectiveUntil: null,
        breaks: [],
      })),
    );
    await engineClient.setSlotPolicy(facility.id, {
      durationMinutes: 60,
      intervalMinutes: 60,
      minNoticeMinutes: 0,
      maxAdvanceDays: 90,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      maxSlotsPerBooking: 4,
      defaultHoldMinutes: 5,
      maxActiveHoldsPerCustomer: 3,
    });
    await engineClient.setPricing({ facilityId: facility.id, amountMinor: 1500, currency: "USD" });

    const testKey = await backend.platform.createApiKey({
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
      tenantId: tenant.id,
      name: "Onboarding Test Key",
      scopes: ALL_PLATFORM_SCOPES,
      createdBy: session.user.email,
    });

    await backend.auth.switchActiveContext({
      sessionId: session.sessionId,
      userEmail: session.user.email,
      organizationId: organization.id,
      projectId: proj.project.id,
      environmentId: proj.testEnvironment.id,
    });

    return NextResponse.json(
      {
        organization,
        project: proj.project,
        environment: proj.testEnvironment,
        tenant,
        facility,
        testApiKeyToken: testKey.token,
      },
      { status: 201 },
    );
  } catch (err) {
    return jsonErrorResponse(err);
  }
}
