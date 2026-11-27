-- Phase 6 platform schema: multi-tenant control plane, API credentials, locations, webhooks, usage metering, audit logs.
-- Preserves full backward compatibility with V1 standalone tenants and facilities.

-- 1. Developer organizations & members
CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'invited', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email)
);
CREATE INDEX IF NOT EXISTS organization_members_org_idx
  ON organization_members(organization_id, role, status);

-- 2. Projects & test/live environments
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  name text NOT NULL,
  slug text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug),
  UNIQUE (organization_id, id)
);

CREATE TABLE IF NOT EXISTS environments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('test', 'live')),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, type),
  UNIQUE (organization_id, project_id, id),
  FOREIGN KEY (organization_id, project_id) REFERENCES projects(organization_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS environments_project_idx ON environments(project_id, type);

-- 3. Extend tenants cleanly (nullable platform links preserve V1 compatibility)
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS project_id uuid,
  ADD COLUMN IF NOT EXISTS environment_id uuid,
  ADD COLUMN IF NOT EXISTS environment_type text CHECK (environment_type IS NULL OR environment_type IN ('test', 'live'));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_platform_tuple_consistency_check'
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_platform_tuple_consistency_check
      CHECK (
        (organization_id IS NULL AND project_id IS NULL AND environment_id IS NULL AND environment_type IS NULL)
        OR (organization_id IS NOT NULL AND project_id IS NOT NULL AND environment_id IS NOT NULL AND environment_type IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_platform_env_fkey'
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_platform_env_fkey
      FOREIGN KEY (organization_id, project_id, environment_id)
      REFERENCES environments(organization_id, project_id, id)
      ON DELETE RESTRICT;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tenants_environment_id_unique'
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT tenants_environment_id_unique UNIQUE (environment_id, id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS tenants_environment_idx
  ON tenants(environment_id, status, created_at DESC)
  WHERE environment_id IS NOT NULL;

-- 4. Business locations & link from facilities (resources)
CREATE TABLE IF NOT EXISTS locations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  name text NOT NULL,
  address_line1 text,
  city text,
  region text,
  postal_code text,
  country char(2),
  time_zone text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS locations_tenant_idx ON locations(tenant_id, active, name);

ALTER TABLE facilities
  ADD COLUMN IF NOT EXISTS location_id uuid,
  ADD COLUMN IF NOT EXISTS resource_kind text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'facilities_tenant_location_fkey'
  ) THEN
    ALTER TABLE facilities
      ADD CONSTRAINT facilities_tenant_location_fkey
      FOREIGN KEY (tenant_id, location_id)
      REFERENCES locations(tenant_id, id)
      ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS facilities_location_idx
  ON facilities(tenant_id, location_id)
  WHERE location_id IS NOT NULL;

-- 5. Cryptographic API credentials (hash-only storage)
CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  environment_type text NOT NULL CHECK (environment_type IN ('test', 'live')),
  tenant_id uuid,
  name text NOT NULL,
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  scopes text[] NOT NULL CHECK (cardinality(scopes) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'rotated', 'revoked')),
  rotated_from_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (organization_id, project_id, environment_id)
    REFERENCES environments(organization_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (environment_id, tenant_id)
    REFERENCES tenants(environment_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS api_keys_env_status_idx
  ON api_keys(environment_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS api_keys_tenant_idx
  ON api_keys(tenant_id, status)
  WHERE tenant_id IS NOT NULL;

-- 6. Webhook endpoints & durable per-endpoint delivery tracking
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  url text NOT NULL,
  description text,
  event_types text[] NOT NULL DEFAULT '{}'::text[],
  signing_secret text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  disabled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (organization_id, project_id, environment_id)
    REFERENCES environments(organization_id, project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (environment_id, tenant_id)
    REFERENCES tenants(environment_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_tenant_active_idx
  ON webhook_endpoints(tenant_id, active)
  WHERE active;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  outbox_event_id uuid NOT NULL REFERENCES outbox_events(id) ON DELETE CASCADE,
  endpoint_id uuid NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'retrying', 'delivered', 'dead_letter')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  response_status integer,
  response_body_excerpt text,
  last_error text,
  delivered_at timestamptz,
  dead_lettered_at timestamptz,
  replayed_count integer NOT NULL DEFAULT 0 CHECK (replayed_count >= 0),
  last_attempt_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (outbox_event_id, endpoint_id),
  FOREIGN KEY (tenant_id, endpoint_id) REFERENCES webhook_endpoints(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_poll_idx
  ON webhook_deliveries(status, next_attempt_at)
  WHERE status IN ('pending', 'retrying');
CREATE INDEX IF NOT EXISTS webhook_deliveries_tenant_idx
  ON webhook_deliveries(tenant_id, endpoint_id, created_at DESC);

-- 7. Append-only idempotent usage metering records
CREATE TABLE IF NOT EXISTS usage_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL,
  environment_id uuid NOT NULL,
  tenant_id uuid,
  metric text NOT NULL CHECK (metric IN ('api_request', 'hold_created', 'booking_confirmed', 'booking_cancelled', 'webhook_delivered')),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity >= 1),
  idempotency_key text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (environment_id, metric, idempotency_key),
  FOREIGN KEY (organization_id, project_id, environment_id)
    REFERENCES environments(organization_id, project_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS usage_records_env_metric_time_idx
  ON usage_records(environment_id, metric, recorded_at DESC);
CREATE INDEX IF NOT EXISTS usage_records_org_time_idx
  ON usage_records(organization_id, recorded_at DESC);

-- 8. Control-plane & security audit log
CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid,
  environment_id uuid,
  tenant_id uuid,
  actor_type text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS platform_audit_logs_org_time_idx
  ON platform_audit_logs(organization_id, recorded_at DESC);

-- 9. HTTP API idempotency response cache (pairs with engine idempotency_records)
CREATE TABLE IF NOT EXISTS api_idempotency_records (
  environment_id uuid NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  tenant_scope text NOT NULL,
  method text NOT NULL,
  path_template text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  PRIMARY KEY (environment_id, tenant_scope, method, path_template, idempotency_key)
);
CREATE INDEX IF NOT EXISTS api_idempotency_records_expiry_idx
  ON api_idempotency_records(expires_at);

