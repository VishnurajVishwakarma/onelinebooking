-- Phase 7 schema: Security hardening, console RBAC/auth, encrypted webhook secrets,
-- distributed rate limits, tenant concurrency leases, API request logs, and retention helpers.

-- 1. Webhook endpoints: encrypted secret columns + secret rotation grace period
ALTER TABLE webhook_endpoints
  ALTER COLUMN signing_secret DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS signing_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS previous_signing_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS previous_secret_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS secret_key_version integer NOT NULL DEFAULT 1 CHECK (secret_key_version >= 1),
  ADD COLUMN IF NOT EXISTS secret_hint text;

-- 2. Distributed rate-limiting counters (multi-instance PostgreSQL coordination)
CREATE TABLE IF NOT EXISTS distributed_rate_limit_counters (
  bucket_key text NOT NULL,
  window_start_ms bigint NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (bucket_key, window_start_ms)
);
CREATE INDEX IF NOT EXISTS distributed_rate_limit_expiry_idx
  ON distributed_rate_limit_counters(expires_at);

-- 3. Distributed tenant-level concurrency leases across API processes
CREATE TABLE IF NOT EXISTS distributed_tenant_leases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_scope text NOT NULL,
  instance_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS distributed_tenant_leases_scope_idx
  ON distributed_tenant_leases(tenant_scope, expires_at);

-- 4. Usage records uniqueness scope fix: prevent independent tenants/customers sharing idempotency keys from colliding
ALTER TABLE usage_records
  ADD COLUMN IF NOT EXISTS scope_key text NOT NULL DEFAULT '__env__';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'usage_records'::regclass
      AND conname = 'usage_records_environment_id_metric_idempotency_key_key'
  ) THEN
    ALTER TABLE usage_records DROP CONSTRAINT usage_records_environment_id_metric_idempotency_key_key;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'usage_records'::regclass
      AND conname = 'usage_records_env_scope_metric_idem_key'
  ) THEN
    ALTER TABLE usage_records
      ADD CONSTRAINT usage_records_env_scope_metric_idem_key
      UNIQUE (environment_id, scope_key, metric, idempotency_key);
  END IF;
END $$;

-- 5. Sanitized API request logs (zero raw tokens or customer PII)
CREATE TABLE IF NOT EXISTS api_request_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  tenant_id uuid,
  api_key_id uuid,
  correlation_id text NOT NULL,
  trace_id text,
  method text NOT NULL,
  path_template text NOT NULL,
  status_code integer NOT NULL,
  duration_ms integer NOT NULL CHECK (duration_ms >= 0),
  request_bytes integer NOT NULL DEFAULT 0 CHECK (request_bytes >= 0),
  response_bytes integer NOT NULL DEFAULT 0 CHECK (response_bytes >= 0),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_request_logs_env_time_idx
  ON api_request_logs(environment_id, created_at DESC);

-- 6. Developer Console users, sessions, invitations, and project RBAC
CREATE TABLE IF NOT EXISTS console_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE organization_members
  ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES console_users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email text NOT NULL,
  user_id uuid REFERENCES console_users(id) ON DELETE SET NULL,
  role text NOT NULL CHECK (role IN ('admin', 'developer', 'viewer')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, email)
);

CREATE TABLE IF NOT EXISTS organization_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES console_users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organization_invitations_org_idx
  ON organization_invitations(organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS console_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES console_users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  active_organization_id uuid REFERENCES organizations(id) ON DELETE SET NULL,
  active_project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  active_environment_id uuid REFERENCES environments(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS console_sessions_user_idx
  ON console_sessions(user_id, expires_at DESC);

