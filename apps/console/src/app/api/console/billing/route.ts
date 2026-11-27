import { NextResponse } from "next/server";
import { requireAuthorizedWorkspace } from "@/lib/auth-helper";
import { BillingService, jsonErrorResponse } from "@/lib/engine";

export async function GET() {
  try {
    const ctx = await requireAuthorizedWorkspace({ minRole: "viewer" });
    const billing = new BillingService(ctx.backend.pool);
    const [plansRes, subsRes, invoicesRes, quota] = await Promise.all([
      ctx.backend.pool.query(
        `SELECT pv.*, p.slug, p.name
         FROM billing_plan_versions pv
         JOIN billing_plans p ON p.id = pv.plan_id
         WHERE pv.active = true
         ORDER BY pv.monthly_base_minor ASC, pv.version DESC`,
      ),
      ctx.backend.pool.query(
        `SELECT * FROM billing_subscriptions WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [ctx.organization.id],
      ),
      ctx.backend.pool.query(
        `SELECT * FROM billing_invoices WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [ctx.organization.id],
      ),
      billing.evaluateOrganizationQuota(ctx.organization.id),
    ]);

    return NextResponse.json({
      plans: plansRes.rows,
      subscription: subsRes.rows[0] ?? null,
      invoices: invoicesRes.rows,
      quota,
    });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json()) as {
      action: "create_plan" | "subscribe" | "generate_invoice";
      slug?: string;
      name?: string;
      monthlyBaseMinor?: number;
      includedBookings?: number;
      includedApiRequests?: number;
      overageBookingMinor?: number;
      planVersionId?: string;
      startTrial?: boolean;
      idempotencyKey?: string;
    };
    const ctx = await requireAuthorizedWorkspace({ req, minRole: "admin" });
    const billing = new BillingService(ctx.backend.pool);

    if (body.action === "create_plan") {
      const plan = await billing.createPlanWithVersion({
        slug: body.slug ?? `pro-${Date.now()}`,
        name: body.name ?? "Pro Plan",
        monthlyBaseMinor: body.monthlyBaseMinor ?? 4900,
        includedBookings: body.includedBookings ?? 1000,
        includedApiRequests: body.includedApiRequests ?? 50000,
        overageBookingMinor: body.overageBookingMinor ?? 10,
        overageApiRequest1kMinor: 25,
      });
      return NextResponse.json({ plan }, { status: 201 });
    }

    if (body.action === "subscribe" && body.planVersionId) {
      const subscription = await billing.startSubscription({
        organizationId: ctx.organization.id,
        planVersionId: body.planVersionId,
        startTrial: body.startTrial ?? true,
      });
      return NextResponse.json({ subscription }, { status: 201 });
    }

    if (body.action === "generate_invoice") {
      const result = await billing.generateInvoiceForPeriod({
        organizationId: ctx.organization.id,
        idempotencyKey: body.idempotencyKey ?? `manual-${Date.now()}`,
      });
      return NextResponse.json(result, { status: 201 });
    }

    return NextResponse.json({ error: "Invalid billing action" }, { status: 400 });
  } catch (err) {
    return jsonErrorResponse(err);
  }
}

