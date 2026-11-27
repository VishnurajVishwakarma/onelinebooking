import { NextResponse } from "next/server";
import { requireAuthorizedWorkspace } from "@/lib/auth-helper";
import { checkPlatformReadiness, jsonErrorResponse } from "@/lib/engine";

export async function GET() {
  try {
    const ctx = await requireAuthorizedWorkspace({ minRole: "viewer" });
    const [usageMetrics, requestLogs, auditLogs, readiness] = await Promise.all([
      ctx.backend.platform.getUsageSummary({ environmentId: ctx.environment.id }),
      ctx.backend.platform.listApiRequestLogs(ctx.environment.id, 100),
      ctx.backend.platform.listAuditLogs(ctx.organization.id, 100),
      checkPlatformReadiness(ctx.backend.pool),
    ]);
    return NextResponse.json({
      environmentId: ctx.environment.id,
      environmentType: ctx.environment.type,
      usageMetrics,
      requestLogs,
      auditLogs,
      readiness,
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}
