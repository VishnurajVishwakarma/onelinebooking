-- Phase 8 schema: Email verification, password resets, and isolated commercial billing infrastructure.
-- Commercial/billing tables remain strictly decoupled from V1 booking engine invariants.

-- 1. Email verification & password reset tokens for Developer Console
ALTER TABLE console_users
  ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS console_email_verifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  email text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS console_email_verif_user_idx
  ON console_email_verifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS console_password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS console_pw_reset_user_idx
  ON console_password_resets(user_id, created_at DESC);

-- 2. Commercial Plans & Plan Versions (admin-configurable, never hardcoded in booking domain)
CREATE TABLE IF NOT EXISTS billing_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES billing_plans(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1),
  currency char(3) NOT NULL DEFAULT 'USD',
  monthly_base_minor bigint NOT NULL CHECK (monthly_base_minor >= 0),
  included_bookings integer NOT NULL CHECK (included_bookings >= 0),
  included_api_requests integer NOT NULL CHECK (included_api_requests >= 0),
  overage_booking_minor bigint NOT NULL CHECK (overage_booking_minor >= 0),
  overage_api_request_1k_minor bigint NOT NULL CHECK (overage_api_request_1k_minor >= 0),
  trial_days integer NOT NULL DEFAULT 14 CHECK (trial_days >= 0),
  overage_policy text NOT NULL DEFAULT 'allow_and_bill' CHECK (overage_policy IN ('allow_and_bill', 'hard_cap')),
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version)
);

-- 3. Subscriptions & Trial Lifecycle
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  plan_version_id uuid NOT NULL REFERENCES billing_plan_versions(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled')),
  trial_ends_at timestamptz,
  current_period_start timestamptz NOT NULL,
  current_period_end timestamptz NOT NULL,
  provider text NOT NULL DEFAULT 'manual',
  provider_customer_id text,
  provider_subscription_id text,
  canceled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (current_period_end > current_period_start)
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_org_active_uidx
  ON billing_subscriptions(organization_id)
  WHERE status IN ('trialing', 'active', 'past_due');

-- 4. Append-only Immutable Billing Ledger (idempotent against retries)
CREATE TABLE IF NOT EXISTS billing_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  entry_type text NOT NULL CHECK (entry_type IN ('base_charge', 'usage_overage', 'credit', 'refund', 'invoice_payment')),
  amount_minor bigint NOT NULL,
  currency char(3) NOT NULL,
  idempotency_key text NOT NULL,
  reference_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS billing_ledger_org_time_idx
  ON billing_ledger_entries(organization_id, recorded_at DESC);

-- 5. Invoices & Payment Provider Webhook Reconciliation
CREATE TABLE IF NOT EXISTS billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  subscription_id uuid NOT NULL REFERENCES billing_subscriptions(id) ON DELETE RESTRICT,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  overage_minor bigint NOT NULL CHECK (overage_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL CHECK (status IN ('draft', 'open', 'paid', 'void', 'uncollectible')),
  idempotency_key text NOT NULL,
  provider_invoice_id text,
  line_items jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE (organization_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS billing_invoices_org_idx
  ON billing_invoices(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_id)
);

