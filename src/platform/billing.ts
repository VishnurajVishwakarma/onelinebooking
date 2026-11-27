import { createHmac, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import { BookingError } from "../domain/errors.js";

export type OveragePolicy = "allow_and_bill" | "hard_cap";
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "canceled";
export type LedgerEntryType = "base_charge" | "usage_overage" | "credit" | "refund" | "invoice_payment";

export interface BillingPlanVersion {
  id: string;
  planId: string;
  planSlug: string;
  planName: string;
  version: number;
  currency: string;
  monthlyBaseMinor: number;
  includedBookings: number;
  includedApiRequests: number;
  overageBookingMinor: number;
  overageApiRequest1kMinor: number;
  trialDays: number;
  overagePolicy: OveragePolicy;
  features: Record<string, unknown>;
}

export interface BillingSubscription {
  id: string;
  organizationId: string;
  planVersionId: string;
  status: SubscriptionStatus;
  trialEndsAt: string | null;
  currentPeriodStart: string;
  currentPeriodEnd: string;
  provider: string;
  providerCustomerId: string | null;
  providerSubscriptionId: string | null;
}

export interface BillingInvoice {
  id: string;
  organizationId: string;
  subscriptionId: string;
  periodStart: string;
  periodEnd: string;
  subtotalMinor: number;
  overageMinor: number;
  totalMinor: number;
  currency: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  providerInvoiceId: string | null;
  lineItems: Array<{ description: string; amountMinor: number; quantity: number }>;
  createdAt: string;
  paidAt: string | null;
}

export interface PaymentProviderAdapter {
  readonly providerName: string;
  createCustomerSubscription(input: {
    organizationId: string;
    planSlug: string;
    currency: string;
  }): Promise<{ providerCustomerId: string; providerSubscriptionId: string }>;
  finalizeInvoice(input: {
    organizationId: string;
    invoiceId: string;
    totalMinor: number;
    currency: string;
  }): Promise<{ providerInvoiceId: string; paidImmediately: boolean }>;
}

export class ManualInvoicingProvider implements PaymentProviderAdapter {
  readonly providerName = "manual";
  async createCustomerSubscription(input: { organizationId: string; planSlug: string }) {
    return {
      providerCustomerId: `cus_${input.organizationId.slice(0, 8)}`,
      providerSubscriptionId: `sub_${input.planSlug}_${input.organizationId.slice(0, 8)}`,
    };
  }
  async finalizeInvoice(input: { invoiceId: string }) {
    return {
      providerInvoiceId: `inv_man_${input.invoiceId.slice(0, 8)}`,
      paidImmediately: false,
    };
  }
}

/**
 * Stripe-compatible Sandbox Payment Provider Adapter for commercial billing verification.
 * Supports simulated card settlement, intentional declines (for failed-payment recovery tests),
 * invoice payment retries, refunds, and HMAC-SHA256 webhook signature creation/verification.
 */
export class SandboxStripePaymentProvider implements PaymentProviderAdapter {
  readonly providerName = "stripe_sandbox";
  readonly declineOrganizationIds = new Set<string>();
  readonly webhookSecret: string;

  constructor(options?: { webhookSecret?: string; declineOrganizationIds?: string[] }) {
    this.webhookSecret = options?.webhookSecret ?? "whsec_sandbox_test_key";
    if (options?.declineOrganizationIds) {
      for (const id of options.declineOrganizationIds) this.declineOrganizationIds.add(id);
    }
  }

  async createCustomerSubscription(input: { organizationId: string; planSlug: string; currency: string }) {
    return {
      providerCustomerId: `cus_sbx_${input.organizationId.slice(0, 8)}`,
      providerSubscriptionId: `sub_sbx_${input.planSlug}_${input.organizationId.slice(0, 8)}`,
    };
  }

  async finalizeInvoice(input: {
    organizationId: string;
    invoiceId: string;
    totalMinor: number;
    currency: string;
  }) {
    const declined = this.declineOrganizationIds.has(input.organizationId);
    return {
      providerInvoiceId: `in_sbx_${input.invoiceId.slice(0, 8)}`,
      paidImmediately: !declined,
    };
  }

  signWebhookPayload(payloadJson: string, timestampSec = Math.floor(Date.now() / 1000)): string {
    const sig = createHmac("sha256", this.webhookSecret)
      .update(`${timestampSec}.${payloadJson}`, "utf8")
      .digest("hex");
    return `t=${timestampSec},v1=${sig}`;
  }

  verifyWebhookSignature(payloadJson: string, header: string, toleranceSec = 300): boolean {
    const parts = Object.fromEntries(header.split(",").map((kv) => kv.split("=")));
    const ts = Number(parts.t);
    const sig = parts.v1;
    if (!Number.isFinite(ts) || !sig) return false;
    if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSec) return false;
    const expected = createHmac("sha256", this.webhookSecret)
      .update(`${ts}.${payloadJson}`, "utf8")
      .digest("hex");
    const a = Buffer.from(expected, "hex");
    const b = Buffer.from(sig, "hex");
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

/**
 * Commercial billing, quota entitlement, append-only ledger, invoice, and payment reconciliation service.
 * Completely decoupled from PostgreSQL booking transactions so billing outages or plan changes
 * never compromise reservation correctness.
 */
export class BillingService {
  private readonly provider: PaymentProviderAdapter;

  constructor(
    private readonly pool: Pool,
    provider?: PaymentProviderAdapter,
  ) {
    this.provider = provider ?? new ManualInvoicingProvider();
  }

  async createPlanWithVersion(input: {
    slug: string;
    name: string;
    currency?: string;
    monthlyBaseMinor: number;
    includedBookings: number;
    includedApiRequests: number;
    overageBookingMinor: number;
    overageApiRequest1kMinor: number;
    trialDays?: number;
    overagePolicy?: OveragePolicy;
    features?: Record<string, unknown>;
  }): Promise<BillingPlanVersion> {
    const slug = input.slug.trim().toLowerCase();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const planRes = await client.query<{ id: string; slug: string; name: string }>(
        `INSERT INTO billing_plans (slug, name)
         VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING id, slug, name`,
        [slug, input.name.trim()],
      );
      const plan = planRes.rows[0]!;
      const maxVerRes = await client.query<{ next_ver: number }>(
        `SELECT COALESCE(MAX(version), 0)::int + 1 AS next_ver FROM billing_plan_versions WHERE plan_id = $1`,
        [plan.id],
      );
      const ver = maxVerRes.rows[0]!.next_ver;
      const pvRes = await client.query<Record<string, unknown>>(
        `INSERT INTO billing_plan_versions (
          plan_id, version, currency, monthly_base_minor,
          included_bookings, included_api_requests,
          overage_booking_minor, overage_api_request_1k_minor,
          trial_days, overage_policy, features
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        RETURNING *`,
        [
          plan.id,
          ver,
          (input.currency ?? "USD").toUpperCase(),
          input.monthlyBaseMinor,
          input.includedBookings,
          input.includedApiRequests,
          input.overageBookingMinor,
          input.overageApiRequest1kMinor,
          input.trialDays ?? 14,
          input.overagePolicy ?? "allow_and_bill",
          JSON.stringify(input.features ?? {}),
        ],
      );
      const r = pvRes.rows[0]!;
      await client.query("COMMIT");
      return {
        id: String(r.id),
        planId: plan.id,
        planSlug: plan.slug,
        planName: plan.name,
        version: Number(r.version),
        currency: String(r.currency),
        monthlyBaseMinor: Number(r.monthly_base_minor),
        includedBookings: Number(r.included_bookings),
        includedApiRequests: Number(r.included_api_requests),
        overageBookingMinor: Number(r.overage_booking_minor),
        overageApiRequest1kMinor: Number(r.overage_api_request_1k_minor),
        trialDays: Number(r.trial_days),
        overagePolicy: r.overage_policy as OveragePolicy,
        features: (r.features as Record<string, unknown>) ?? {},
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async startSubscription(input: {
    organizationId: string;
    planVersionId: string;
    startTrial?: boolean;
  }): Promise<BillingSubscription> {
    const pvRes = await this.pool.query<{
      id: string;
      slug: string;
      currency: string;
      trial_days: number;
    }>(
      `SELECT pv.id, p.slug, pv.currency, pv.trial_days
       FROM billing_plan_versions pv
       JOIN billing_plans p ON p.id = pv.plan_id
       WHERE pv.id = $1 AND pv.active = true`,
      [input.planVersionId],
    );
    if (pvRes.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "Billing plan version not found");
    }
    const pv = pvRes.rows[0]!;
    const now = new Date();
    const useTrial = (input.startTrial ?? true) && pv.trial_days > 0;
    const trialEnds = useTrial ? new Date(now.getTime() + pv.trial_days * 86_400_000) : null;
    const periodEnd = new Date(now.getTime() + 30 * 86_400_000);

    const ext = await this.provider.createCustomerSubscription({
      organizationId: input.organizationId,
      planSlug: pv.slug,
      currency: pv.currency,
    });

    const res = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO billing_subscriptions (
        organization_id, plan_version_id, status, trial_ends_at,
        current_period_start, current_period_end,
        provider, provider_customer_id, provider_subscription_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        input.organizationId,
        pv.id,
        useTrial ? "trialing" : "active",
        trialEnds,
        now,
        periodEnd,
        this.provider.providerName,
        ext.providerCustomerId,
        ext.providerSubscriptionId,
      ],
    );
    const r = res.rows[0]!;
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      planVersionId: String(r.plan_version_id),
      status: r.status as SubscriptionStatus,
      trialEndsAt: r.trial_ends_at ? new Date(String(r.trial_ends_at)).toISOString() : null,
      currentPeriodStart: new Date(String(r.current_period_start)).toISOString(),
      currentPeriodEnd: new Date(String(r.current_period_end)).toISOString(),
      provider: String(r.provider),
      providerCustomerId: r.provider_customer_id != null ? String(r.provider_customer_id) : null,
      providerSubscriptionId: r.provider_subscription_id != null ? String(r.provider_subscription_id) : null,
    };
  }

  /**
   * Checks quota entitlement from append-only `usage_records` against current subscription plan.
   */
  async evaluateOrganizationQuota(organizationId: string): Promise<{
    allowed: boolean;
    reason?: string;
    status: SubscriptionStatus | "no_subscription";
    bookingsUsed: number;
    bookingsQuota: number;
    apiRequestsUsed: number;
    apiRequestsQuota: number;
  }> {
    const subRes = await this.pool.query<Record<string, unknown>>(
      `SELECT s.*, pv.included_bookings, pv.included_api_requests, pv.overage_policy
       FROM billing_subscriptions s
       JOIN billing_plan_versions pv ON pv.id = s.plan_version_id
       WHERE s.organization_id = $1 AND s.status IN ('trialing', 'active', 'past_due')
       ORDER BY s.created_at DESC
       LIMIT 1`,
      [organizationId],
    );
    if (subRes.rowCount === 0) {
      return {
        allowed: true,
        status: "no_subscription",
        bookingsUsed: 0,
        bookingsQuota: 0,
        apiRequestsUsed: 0,
        apiRequestsQuota: 0,
      };
    }
    const sub = subRes.rows[0]!;
    const usageRes = await this.pool.query<{ metric: string; qty: string }>(
      `SELECT metric, COALESCE(SUM(quantity), 0)::bigint AS qty
       FROM usage_records
       WHERE organization_id = $1
         AND recorded_at >= $2::timestamptz
         AND recorded_at <= $3::timestamptz
       GROUP BY metric`,
      [organizationId, sub.current_period_start, sub.current_period_end],
    );
    let bookingsUsed = 0;
    let apiRequestsUsed = 0;
    for (const row of usageRes.rows) {
      if (row.metric === "booking_confirmed") bookingsUsed = Number(row.qty);
      if (row.metric === "api_request") apiRequestsUsed = Number(row.qty);
    }

    const bookingsQuota = Number(sub.included_bookings);
    const apiRequestsQuota = Number(sub.included_api_requests);
    const policy = sub.overage_policy as OveragePolicy;

    if (sub.status === "past_due") {
      return {
        allowed: false,
        reason: "Subscription is past_due",
        status: "past_due",
        bookingsUsed,
        bookingsQuota,
        apiRequestsUsed,
        apiRequestsQuota,
      };
    }

    if (policy === "hard_cap" && bookingsUsed >= bookingsQuota) {
      return {
        allowed: false,
        reason: "Monthly included booking quota reached (hard_cap)",
        status: sub.status as SubscriptionStatus,
        bookingsUsed,
        bookingsQuota,
        apiRequestsUsed,
        apiRequestsQuota,
      };
    }

    return {
      allowed: true,
      status: sub.status as SubscriptionStatus,
      bookingsUsed,
      bookingsQuota,
      apiRequestsUsed,
      apiRequestsQuota,
    };
  }

  /**
   * Appends an immutable entry to `billing_ledger_entries` idempotently by `(organizationId, idempotencyKey)`.
   */
  async appendLedgerEntry(input: {
    organizationId: string;
    subscriptionId: string;
    entryType: LedgerEntryType;
    amountMinor: number;
    currency: string;
    idempotencyKey: string;
    referenceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ inserted: boolean; entryId: string | null }> {
    const res = await this.pool.query<{ id: string }>(
      `INSERT INTO billing_ledger_entries (
        organization_id, subscription_id, entry_type, amount_minor, currency,
        idempotency_key, reference_id, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (organization_id, idempotency_key) DO NOTHING
      RETURNING id`,
      [
        input.organizationId,
        input.subscriptionId,
        input.entryType,
        input.amountMinor,
        input.currency.toUpperCase(),
        input.idempotencyKey,
        input.referenceId ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    return {
      inserted: (res.rowCount ?? 0) > 0,
      entryId: res.rows[0]?.id ?? null,
    };
  }

  /**
   * Generates a period invoice idempotently from `billing_subscriptions` + deduplicated `usage_records`.
   */
  async generateInvoiceForPeriod(input: {
    organizationId: string;
    idempotencyKey: string;
  }): Promise<{ invoice: BillingInvoice; deduplicated: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const subRes = await client.query<Record<string, unknown>>(
        `SELECT s.*, pv.monthly_base_minor, pv.included_bookings, pv.included_api_requests,
                pv.overage_booking_minor, pv.overage_api_request_1k_minor, pv.currency
         FROM billing_subscriptions s
         JOIN billing_plan_versions pv ON pv.id = s.plan_version_id
         WHERE s.organization_id = $1 AND s.status IN ('trialing', 'active', 'past_due')
         ORDER BY s.created_at DESC
         LIMIT 1
         FOR UPDATE OF s`,
        [input.organizationId],
      );
      if (subRes.rowCount === 0) {
        throw new BookingError("NOT_FOUND", "No active subscription found for organization");
      }
      const existingRes = await client.query<Record<string, unknown>>(
        `SELECT * FROM billing_invoices WHERE organization_id = $1 AND idempotency_key = $2`,
        [input.organizationId, input.idempotencyKey],
      );
      if ((existingRes.rowCount ?? 0) > 0) {
        await client.query("COMMIT");
        return {
          invoice: this.mapInvoice(existingRes.rows[0]!),
          deduplicated: true,
        };
      }
      const sub = subRes.rows[0]!;

      const usageRes = await client.query<{ metric: string; qty: string }>(
        `SELECT metric, COALESCE(SUM(quantity), 0)::bigint AS qty
         FROM usage_records
         WHERE organization_id = $1
           AND recorded_at >= $2::timestamptz
           AND recorded_at <= $3::timestamptz
         GROUP BY metric`,
        [input.organizationId, sub.current_period_start, sub.current_period_end],
      );

      let confirmedBookings = 0;
      let apiRequests = 0;
      for (const r of usageRes.rows) {
        if (r.metric === "booking_confirmed") confirmedBookings = Number(r.qty);
        if (r.metric === "api_request") apiRequests = Number(r.qty);
      }

      const baseMinor = sub.status === "trialing" ? 0 : Number(sub.monthly_base_minor);
      const excessBookings = Math.max(0, confirmedBookings - Number(sub.included_bookings));
      const excessApiThousands = Math.ceil(
        Math.max(0, apiRequests - Number(sub.included_api_requests)) / 1000,
      );

      const bookingOverageMinor = excessBookings * Number(sub.overage_booking_minor);
      const apiOverageMinor = excessApiThousands * Number(sub.overage_api_request_1k_minor);
      const overageMinor = bookingOverageMinor + apiOverageMinor;
      const totalMinor = baseMinor + overageMinor;
      const currency = String(sub.currency);

      const lineItems = [
        { description: sub.status === "trialing" ? "Trial Base Plan" : "Monthly Base Plan", quantity: 1, amountMinor: baseMinor },
        ...(excessBookings > 0
          ? [{ description: `Booking Overage (${excessBookings} bookings)`, quantity: excessBookings, amountMinor: bookingOverageMinor }]
          : []),
        ...(excessApiThousands > 0
          ? [{ description: `API Overage (${excessApiThousands}k reqs)`, quantity: excessApiThousands, amountMinor: apiOverageMinor }]
          : []),
      ];

      const insRes = await client.query<Record<string, unknown>>(
        `INSERT INTO billing_invoices (
          organization_id, subscription_id, period_start, period_end,
          subtotal_minor, overage_minor, total_minor, currency,
          status, idempotency_key, line_items
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9, $10::jsonb)
        RETURNING *`,
        [
          input.organizationId,
          sub.id,
          sub.current_period_start,
          sub.current_period_end,
          baseMinor,
          overageMinor,
          totalMinor,
          currency,
          input.idempotencyKey,
          JSON.stringify(lineItems),
        ],
      );
      const invoiceRow = insRes.rows[0]!;
      const invId = String(invoiceRow.id);

      if (baseMinor > 0) {
        await client.query(
          `INSERT INTO billing_ledger_entries (
            organization_id, subscription_id, entry_type, amount_minor, currency, idempotency_key, reference_id
          ) VALUES ($1, $2, 'base_charge', $3, $4, $5, $6)
          ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
          [input.organizationId, sub.id, baseMinor, currency, `inv:${input.idempotencyKey}:base`, invId],
        );
      }
      if (overageMinor > 0) {
        await client.query(
          `INSERT INTO billing_ledger_entries (
            organization_id, subscription_id, entry_type, amount_minor, currency, idempotency_key, reference_id
          ) VALUES ($1, $2, 'usage_overage', $3, $4, $5, $6)
          ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
          [input.organizationId, sub.id, overageMinor, currency, `inv:${input.idempotencyKey}:overage`, invId],
        );
      }

      const finalized = await this.provider.finalizeInvoice({
        organizationId: input.organizationId,
        invoiceId: invId,
        totalMinor,
        currency,
      });

      const updRes = await client.query<Record<string, unknown>>(
        `UPDATE billing_invoices
         SET provider_invoice_id = $2,
             status = $3,
             paid_at = CASE WHEN $3 = 'paid' THEN now() ELSE paid_at END
         WHERE id = $1
         RETURNING *`,
        [invId, finalized.providerInvoiceId, finalized.paidImmediately ? "paid" : "open"],
      );
      await client.query("COMMIT");
      return { invoice: this.mapInvoice(updRes.rows[0]!), deduplicated: false };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Idempotent billing provider webhook handler: replays identical `providerEventId` without double-charging ledger.
   */
  async reconcileProviderWebhook(input: {
    provider: string;
    providerEventId: string;
    eventType: "invoice.paid" | "invoice.payment_failed" | "subscription.canceled";
    organizationId: string;
    invoiceId?: string;
    subscriptionId?: string;
    amountPaidMinor?: number;
    currency?: string;
  }): Promise<{ processed: boolean; duplicate: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const evtRes = await client.query<{ id: string }>(
        `INSERT INTO billing_webhook_events (provider, provider_event_id, event_type, payload)
         VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [input.provider, input.providerEventId, input.eventType, JSON.stringify(input)],
      );
      if (evtRes.rowCount === 0) {
        await client.query("COMMIT");
        return { processed: false, duplicate: true };
      }

      if (input.eventType === "invoice.paid" && input.invoiceId) {
        const invRes = await client.query<{ subscription_id: string; total_minor: string; currency: string }>(
          `UPDATE billing_invoices
           SET status = 'paid', paid_at = COALESCE(paid_at, now())
           WHERE id = $1 AND organization_id = $2
           RETURNING subscription_id, total_minor, currency`,
          [input.invoiceId, input.organizationId],
        );
        if ((invRes.rowCount ?? 0) > 0) {
          const inv = invRes.rows[0]!;
          await client.query(
            `UPDATE billing_subscriptions
             SET status = 'active', updated_at = now()
             WHERE id = $1 AND status IN ('trialing', 'past_due')`,
            [inv.subscription_id],
          );
          await client.query(
            `INSERT INTO billing_ledger_entries (
              organization_id, subscription_id, entry_type, amount_minor, currency, idempotency_key, reference_id
            ) VALUES ($1, $2, 'invoice_payment', $3, $4, $5, $6)
            ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
            [
              input.organizationId,
              inv.subscription_id,
              -(input.amountPaidMinor ?? Number(inv.total_minor)),
              input.currency ?? inv.currency,
              `pay:${input.provider}:${input.providerEventId}`,
              input.invoiceId,
            ],
          );
        }
      } else if (input.eventType === "invoice.payment_failed" && input.subscriptionId) {
        await client.query(
          `UPDATE billing_subscriptions SET status = 'past_due', updated_at = now()
           WHERE id = $1 AND organization_id = $2`,
          [input.subscriptionId, input.organizationId],
        );
      } else if (input.eventType === "subscription.canceled" && input.subscriptionId) {
        await client.query(
          `UPDATE billing_subscriptions SET status = 'canceled', canceled_at = now(), updated_at = now()
           WHERE id = $1 AND organization_id = $2`,
          [input.subscriptionId, input.organizationId],
        );
      }

      await client.query("COMMIT");
      return { processed: true, duplicate: false };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Advances a subscription to `active` for its next 30-day billing period.
   */
  async renewSubscriptionPeriod(input: {
    organizationId: string;
  }): Promise<BillingSubscription> {
    const res = await this.pool.query<Record<string, unknown>>(
      `UPDATE billing_subscriptions
       SET status = 'active',
           current_period_start = current_period_end,
           current_period_end = current_period_end + interval '30 days',
           updated_at = now()
       WHERE organization_id = $1 AND status IN ('trialing', 'active')
       RETURNING *`,
      [input.organizationId],
    );
    if (res.rowCount === 0) {
      throw new BookingError("NOT_FOUND", "No active/trialing subscription eligible for renewal");
    }
    const r = res.rows[0]!;
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      planVersionId: String(r.plan_version_id),
      status: r.status as SubscriptionStatus,
      trialEndsAt: r.trial_ends_at ? new Date(String(r.trial_ends_at)).toISOString() : null,
      currentPeriodStart: new Date(String(r.current_period_start)).toISOString(),
      currentPeriodEnd: new Date(String(r.current_period_end)).toISOString(),
      provider: String(r.provider),
      providerCustomerId: r.provider_customer_id != null ? String(r.provider_customer_id) : null,
      providerSubscriptionId: r.provider_subscription_id != null ? String(r.provider_subscription_id) : null,
    };
  }

  /**
   * Recovers a failed invoice / `past_due` subscription by re-attempting settlement through the provider adapter.
   */
  async retryFailedPayment(input: {
    organizationId: string;
    invoiceId: string;
    idempotencyKey: string;
  }): Promise<{ recovered: boolean; invoice: BillingInvoice }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const invRes = await client.query<Record<string, unknown>>(
        `SELECT * FROM billing_invoices WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
        [input.invoiceId, input.organizationId],
      );
      if (invRes.rowCount === 0) {
        throw new BookingError("NOT_FOUND", "Invoice not found");
      }
      const inv = invRes.rows[0]!;
      if (inv.status === "paid") {
        await client.query("COMMIT");
        return { recovered: true, invoice: this.mapInvoice(inv) };
      }

      const attempt = await this.provider.finalizeInvoice({
        organizationId: input.organizationId,
        invoiceId: input.invoiceId,
        totalMinor: Number(inv.total_minor),
        currency: String(inv.currency),
      });
      if (!attempt.paidImmediately) {
        await client.query("COMMIT");
        return { recovered: false, invoice: this.mapInvoice(inv) };
      }

      const paidRes = await client.query<Record<string, unknown>>(
        `UPDATE billing_invoices
         SET status = 'paid', paid_at = COALESCE(paid_at, now())
         WHERE id = $1
         RETURNING *`,
        [input.invoiceId],
      );
      await client.query(
        `UPDATE billing_subscriptions
         SET status = 'active', updated_at = now()
         WHERE id = $1 AND status IN ('past_due', 'trialing')`,
        [inv.subscription_id],
      );
      await client.query(
        `INSERT INTO billing_ledger_entries (
          organization_id, subscription_id, entry_type, amount_minor, currency, idempotency_key, reference_id
        ) VALUES ($1, $2, 'invoice_payment', $3, $4, $5, $6)
        ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
        [
          input.organizationId,
          inv.subscription_id,
          -Number(inv.total_minor),
          inv.currency,
          `retry_pay:${input.idempotencyKey}`,
          input.invoiceId,
        ],
      );
      await client.query("COMMIT");
      return { recovered: true, invoice: this.mapInvoice(paidRes.rows[0]!) };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Reconciles a refund against a paid invoice idempotently while preventing over-refunds.
   */
  async reconcileRefund(input: {
    provider: string;
    providerEventId: string;
    organizationId: string;
    invoiceId: string;
    amountMinor: number;
    reason?: string;
  }): Promise<{ refunded: boolean; duplicate: boolean; totalRefundedMinor: number }> {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new BookingError("INVALID_INPUT", "Refund amountMinor must be a positive integer");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const evtRes = await client.query<{ id: string }>(
        `INSERT INTO billing_webhook_events (provider, provider_event_id, event_type, payload)
         VALUES ($1, $2, 'charge.refunded', $3::jsonb)
         ON CONFLICT (provider, provider_event_id) DO NOTHING
         RETURNING id`,
        [input.provider, input.providerEventId, JSON.stringify(input)],
      );
      if (evtRes.rowCount === 0) {
        const sumRes = await client.query<{ refunded_sum: string }>(
          `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS refunded_sum
           FROM billing_ledger_entries
           WHERE organization_id = $1 AND reference_id = $2 AND entry_type = 'refund'`,
          [input.organizationId, input.invoiceId],
        );
        await client.query("COMMIT");
        return {
          refunded: false,
          duplicate: true,
          totalRefundedMinor: Number(sumRes.rows[0]?.refunded_sum ?? 0),
        };
      }

      const invRes = await client.query<{ id: string; subscription_id: string; total_minor: string; currency: string; status: string }>(
        `SELECT id, subscription_id, total_minor, currency, status
         FROM billing_invoices
         WHERE id = $1 AND organization_id = $2
         FOR UPDATE`,
        [input.invoiceId, input.organizationId],
      );
      if (invRes.rowCount === 0) {
        throw new BookingError("NOT_FOUND", "Invoice not found for refund");
      }
      const inv = invRes.rows[0]!;
      if (inv.status !== "paid") {
        throw new BookingError("INVALID_STATE_TRANSITION", "Only paid invoices can be refunded");
      }

      const existingRefundRes = await client.query<{ refunded_sum: string }>(
        `SELECT COALESCE(SUM(amount_minor), 0)::bigint AS refunded_sum
         FROM billing_ledger_entries
         WHERE organization_id = $1 AND reference_id = $2 AND entry_type = 'refund'`,
        [input.organizationId, input.invoiceId],
      );
      const priorRefunded = Number(existingRefundRes.rows[0]?.refunded_sum ?? 0);
      const nextRefunded = priorRefunded + input.amountMinor;
      if (nextRefunded > Number(inv.total_minor)) {
        throw new BookingError("INVALID_STATE_TRANSITION", "Cumulative refund amount exceeds paid invoice total");
      }

      await client.query(
        `INSERT INTO billing_ledger_entries (
          organization_id, subscription_id, entry_type, amount_minor, currency, idempotency_key, reference_id, metadata
        ) VALUES ($1, $2, 'refund', $3, $4, $5, $6, $7::jsonb)
        ON CONFLICT (organization_id, idempotency_key) DO NOTHING`,
        [
          input.organizationId,
          inv.subscription_id,
          input.amountMinor,
          inv.currency,
          `refund:${input.provider}:${input.providerEventId}`,
          input.invoiceId,
          JSON.stringify({ reason: input.reason ?? "customer_refund" }),
        ],
      );

      await client.query("COMMIT");
      return {
        refunded: true,
        duplicate: false,
        totalRefundedMinor: nextRefunded,
      };
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private mapInvoice(r: Record<string, unknown>): BillingInvoice {
    return {
      id: String(r.id),
      organizationId: String(r.organization_id),
      subscriptionId: String(r.subscription_id),
      periodStart: new Date(String(r.period_start)).toISOString(),
      periodEnd: new Date(String(r.period_end)).toISOString(),
      subtotalMinor: Number(r.subtotal_minor),
      overageMinor: Number(r.overage_minor),
      totalMinor: Number(r.total_minor),
      currency: String(r.currency),
      status: r.status as BillingInvoice["status"],
      providerInvoiceId: r.provider_invoice_id != null ? String(r.provider_invoice_id) : null,
      lineItems: (r.line_items as BillingInvoice["lineItems"]) ?? [],
      createdAt: new Date(String(r.created_at)).toISOString(),
      paidAt: r.paid_at ? new Date(String(r.paid_at)).toISOString() : null,
    };
  }
}

