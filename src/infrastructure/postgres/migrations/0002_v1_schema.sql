-- V1 schema migration: upgrades 0001_initial to full V1 invariants.

-- 1. Tenants: add archival lifecycle and metadata
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- 2. Facilities: restrict deletes, add configuration_revision & archival timestamp
ALTER TABLE facilities
  DROP CONSTRAINT IF EXISTS facilities_tenant_id_fkey,
  ADD CONSTRAINT facilities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS configuration_revision integer NOT NULL DEFAULT 1 CHECK (configuration_revision >= 1),
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

-- 3. Facility schedules: overnight support (end_day_offset), revisioning, restrict deletes
DO $$
DECLARE
  c_name text;
BEGIN
  FOR c_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'facility_schedules'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%opens_at < closes_at%'
  LOOP
    EXECUTE format('ALTER TABLE facility_schedules DROP CONSTRAINT %I', c_name);
  END LOOP;
END $$;

ALTER TABLE facility_schedules
  DROP CONSTRAINT IF EXISTS facility_schedules_tenant_id_fkey,
  ADD CONSTRAINT facility_schedules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS facility_schedules_tenant_id_facility_id_fkey,
  ADD CONSTRAINT facility_schedules_tenant_id_facility_id_fkey FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS end_day_offset smallint NOT NULL DEFAULT 0 CHECK (end_day_offset IN (0, 1)),
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE facility_schedules
  ADD CONSTRAINT facility_schedules_window_bounds_check
  CHECK ((end_day_offset = 0 AND opens_at < closes_at) OR (end_day_offset = 1 AND closes_at <= opens_at));

-- 4. Schedule breaks: support overnight break offsets
DO $$
DECLARE
  c_name text;
BEGIN
  FOR c_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'schedule_breaks'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%starts_at < ends_at%'
  LOOP
    EXECUTE format('ALTER TABLE schedule_breaks DROP CONSTRAINT %I', c_name);
  END LOOP;
END $$;

ALTER TABLE schedule_breaks
  ADD COLUMN IF NOT EXISTS start_day_offset smallint NOT NULL DEFAULT 0 CHECK (start_day_offset IN (0, 1)),
  ADD COLUMN IF NOT EXISTS end_day_offset smallint NOT NULL DEFAULT 0 CHECK (end_day_offset IN (0, 1));

ALTER TABLE schedule_breaks
  ADD CONSTRAINT schedule_breaks_bounds_check
  CHECK (start_day_offset < end_day_offset OR (start_day_offset = end_day_offset AND starts_at < ends_at));

-- 5. Schedule exceptions (business-date replacements)
CREATE TABLE IF NOT EXISTS schedule_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  facility_id uuid NOT NULL,
  business_date date NOT NULL,
  is_closed boolean NOT NULL DEFAULT false,
  windows jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, business_date),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS schedule_exceptions_lookup_idx
  ON schedule_exceptions(tenant_id, facility_id, business_date);

-- 6. Slot policies: align bounds to V1 (§4.7), decouple pricing into pricing_rules
DO $$
DECLARE
  c_name text;
BEGIN
  FOR c_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'slot_policies'::regclass AND contype = 'c'
  LOOP
    EXECUTE format('ALTER TABLE slot_policies DROP CONSTRAINT %I', c_name);
  END LOOP;
END $$;

ALTER TABLE slot_policies
  DROP CONSTRAINT IF EXISTS slot_policies_tenant_id_fkey,
  ADD CONSTRAINT slot_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS slot_policies_tenant_id_facility_id_fkey,
  ADD CONSTRAINT slot_policies_tenant_id_facility_id_fkey FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT,
  ALTER COLUMN price_minor DROP NOT NULL,
  ALTER COLUMN currency DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS max_slots_per_booking integer NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS default_hold_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS max_active_holds_per_customer integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;

ALTER TABLE slot_policies
  ADD CONSTRAINT slot_policies_duration_check CHECK (duration_minutes BETWEEN 1 AND 1440),
  ADD CONSTRAINT slot_policies_interval_check CHECK (interval_minutes BETWEEN 1 AND 1440),
  ADD CONSTRAINT slot_policies_min_notice_check CHECK (min_notice_minutes >= 0),
  ADD CONSTRAINT slot_policies_max_advance_check CHECK (max_advance_days BETWEEN 1 AND 365),
  ADD CONSTRAINT slot_policies_buffer_before_check CHECK (buffer_before_minutes BETWEEN 0 AND 1440),
  ADD CONSTRAINT slot_policies_buffer_after_check CHECK (buffer_after_minutes BETWEEN 0 AND 1440),
  ADD CONSTRAINT slot_policies_max_slots_check CHECK (max_slots_per_booking BETWEEN 1 AND 24),
  ADD CONSTRAINT slot_policies_default_hold_check CHECK (default_hold_minutes BETWEEN 1 AND 30),
  ADD CONSTRAINT slot_policies_max_holds_check CHECK (max_active_holds_per_customer BETWEEN 1 AND 100),
  ADD CONSTRAINT slot_policies_revision_check CHECK (revision >= 1);

-- 7. Versioned pricing rules
CREATE TABLE IF NOT EXISTS pricing_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  facility_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, revision),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS pricing_rules_active_uidx
  ON pricing_rules(tenant_id, facility_id) WHERE active;

-- Backfill pricing_rules from any existing 0001 slot_policies rows
INSERT INTO pricing_rules (tenant_id, facility_id, revision, amount_minor, currency, active, created_at)
SELECT tenant_id, facility_id, 1, price_minor, currency, true, updated_at
FROM slot_policies
WHERE price_minor IS NOT NULL AND currency IS NOT NULL
ON CONFLICT DO NOTHING;

-- 8. Versioned cancellation policies
CREATE TABLE IF NOT EXISTS cancellation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  facility_id uuid NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  customer_cancellation_allowed boolean NOT NULL DEFAULT true,
  min_notice_minutes integer NOT NULL DEFAULT 0 CHECK (min_notice_minutes >= 0),
  admin_override_allowed boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, facility_id, revision),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS cancellation_policies_active_uidx
  ON cancellation_policies(tenant_id, facility_id) WHERE active;

-- 9. Explicit slot overrides
CREATE TABLE IF NOT EXISTS slot_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  facility_id uuid NOT NULL,
  business_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  action text NOT NULL CHECK (action IN ('add', 'suppress')),
  reason text NOT NULL,
  configuration_revision integer NOT NULL CHECK (configuration_revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  UNIQUE (tenant_id, facility_id, starts_at, ends_at, action),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS slot_overrides_lookup_idx
  ON slot_overrides(tenant_id, facility_id, business_date);

-- 10. Facility blocks (blackouts): restrict deletes, add audit metadata
ALTER TABLE facility_blocks
  DROP CONSTRAINT IF EXISTS facility_blocks_tenant_id_fkey,
  ADD CONSTRAINT facility_blocks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS facility_blocks_tenant_id_facility_id_fkey,
  ADD CONSTRAINT facility_blocks_tenant_id_facility_id_fkey FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS removed_at timestamptz,
  ADD COLUMN IF NOT EXISTS created_by_actor jsonb;

-- 11. Standalone holds and hold_items
CREATE TABLE IF NOT EXISTS holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  facility_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('active', 'converted', 'released', 'expired')),
  expires_at timestamptz NOT NULL,
  expired_recorded_at timestamptz,
  converted_booking_id uuid,
  external_customer_id text,
  actor_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  facility_time_zone text NOT NULL,
  configuration_revision integer NOT NULL CHECK (configuration_revision >= 1),
  pricing_revision integer NOT NULL CHECK (pricing_revision >= 1),
  cancellation_policy_snapshot jsonb NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  quote_created_at timestamptz NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  occupied_from timestamptz NOT NULL,
  occupied_until timestamptz NOT NULL,
  sequence integer NOT NULL DEFAULT 1 CHECK (sequence >= 1),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK (occupied_from <= starts_at AND occupied_until >= ends_at),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, facility_id, id),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS holds_expiry_idx ON holds(tenant_id, expires_at) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS holds_customer_active_idx ON holds(tenant_id, facility_id, external_customer_id) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS hold_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  facility_id uuid NOT NULL,
  hold_id uuid NOT NULL,
  slot_ref text NOT NULL,
  business_date date NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  local_start text NOT NULL,
  local_end text NOT NULL,
  local_offset text NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  CHECK (starts_at < ends_at),
  FOREIGN KEY (tenant_id, facility_id, hold_id) REFERENCES holds(tenant_id, facility_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS hold_items_hold_idx ON hold_items(tenant_id, hold_id, starts_at);

-- 12. Bookings & booking_items: remove pending/expired statuses, restrict deletes, add snapshots & lifecycle fields
DO $$
DECLARE
  c_name text;
BEGIN
  FOR c_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'bookings'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE bookings DROP CONSTRAINT %I', c_name);
  END LOOP;
END $$;

ALTER TABLE bookings
  DROP CONSTRAINT IF EXISTS bookings_tenant_id_fkey,
  ADD CONSTRAINT bookings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS bookings_tenant_id_facility_id_fkey,
  ADD CONSTRAINT bookings_tenant_id_facility_id_fkey FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS source_hold_id uuid,
  ADD COLUMN IF NOT EXISTS external_customer_id text,
  ADD COLUMN IF NOT EXISTS external_payment_ref text,
  ADD COLUMN IF NOT EXISTS actor_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS facility_time_zone text NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS configuration_revision integer NOT NULL DEFAULT 1 CHECK (configuration_revision >= 1),
  ADD COLUMN IF NOT EXISTS pricing_revision integer NOT NULL DEFAULT 1 CHECK (pricing_revision >= 1),
  ADD COLUMN IF NOT EXISTS cancellation_policy_snapshot jsonb NOT NULL DEFAULT '{"customerCancellationAllowed":true,"minNoticeMinutes":0,"adminOverrideAllowed":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS occupied_from timestamptz,
  ADD COLUMN IF NOT EXISTS occupied_until timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancellation_reason text,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_at timestamptz,
  ADD COLUMN IF NOT EXISTS sequence integer NOT NULL DEFAULT 1 CHECK (sequence >= 1),
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Backfill occupied_from/occupied_until and facility_time_zone for any existing bookings
UPDATE bookings b
SET
  facility_time_zone = COALESCE((SELECT f.time_zone FROM facilities f WHERE f.id = b.facility_id), b.facility_time_zone),
  occupied_from = COALESCE(b.occupied_from, (SELECT a.reserved_from FROM booking_allocations a WHERE a.booking_id = b.id), b.starts_at),
  occupied_until = COALESCE(b.occupied_until, (SELECT a.reserved_until FROM booking_allocations a WHERE a.booking_id = b.id), b.ends_at)
WHERE b.occupied_from IS NULL OR b.occupied_until IS NULL;

-- Migrate any M1 pending/expired bookings into holds (preserving IDs) before tightening bookings.status
INSERT INTO holds (
  id, tenant_id, facility_id, state, expires_at, converted_booking_id,
  facility_time_zone, configuration_revision, pricing_revision, cancellation_policy_snapshot,
  total_minor, currency, quote_created_at, starts_at, ends_at, occupied_from, occupied_until, created_at, updated_at
)
SELECT
  bh.id, b.tenant_id, b.facility_id, bh.state, bh.expires_at,
  CASE WHEN b.status IN ('confirmed', 'cancelled') THEN b.id ELSE NULL END,
  b.facility_time_zone, b.configuration_revision, b.pricing_revision, b.cancellation_policy_snapshot,
  b.total_minor, b.currency, b.created_at, b.starts_at, b.ends_at,
  COALESCE(b.occupied_from, b.starts_at), COALESCE(b.occupied_until, b.ends_at), b.created_at, b.updated_at
FROM booking_holds bh
JOIN bookings b ON b.id = bh.booking_id
ON CONFLICT DO NOTHING;

UPDATE bookings b
SET source_hold_id = bh.id
FROM booking_holds bh
WHERE bh.booking_id = b.id AND b.status IN ('confirmed', 'cancelled') AND b.source_hold_id IS NULL;

-- Delete any orphaned M1 pending/expired booking rows after migrating them to holds
DELETE FROM booking_items bi
USING bookings b
WHERE bi.booking_id = b.id AND b.status IN ('pending', 'expired');

DELETE FROM booking_allocations ba
USING bookings b
WHERE ba.booking_id = b.id AND b.status IN ('pending', 'expired');

DELETE FROM booking_holds bh
USING bookings b
WHERE bh.booking_id = b.id AND b.status IN ('pending', 'expired');

DELETE FROM bookings WHERE status IN ('pending', 'expired');

ALTER TABLE bookings
  ALTER COLUMN occupied_from SET NOT NULL,
  ALTER COLUMN occupied_until SET NOT NULL,
  ADD CONSTRAINT bookings_status_v1_check CHECK (status IN ('confirmed', 'cancelled', 'completed', 'no_show')),
  ADD CONSTRAINT bookings_occupied_bounds_check CHECK (occupied_from <= starts_at AND occupied_until >= ends_at),
  ADD CONSTRAINT bookings_tenant_facility_id_unique UNIQUE (tenant_id, facility_id, id),
  ADD CONSTRAINT bookings_source_hold_unique UNIQUE (tenant_id, source_hold_id),
  ADD CONSTRAINT bookings_source_hold_fkey FOREIGN KEY (tenant_id, facility_id, source_hold_id) REFERENCES holds(tenant_id, facility_id, id) ON DELETE RESTRICT;

ALTER TABLE holds
  ADD CONSTRAINT holds_converted_booking_unique UNIQUE (tenant_id, converted_booking_id),
  ADD CONSTRAINT holds_converted_booking_fkey FOREIGN KEY (tenant_id, facility_id, converted_booking_id) REFERENCES bookings(tenant_id, facility_id, id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS bookings_cursor_idx ON bookings(tenant_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS bookings_customer_idx ON bookings(tenant_id, external_customer_id, created_at DESC);

-- Upgrade booking_items
ALTER TABLE booking_items
  DROP CONSTRAINT IF EXISTS booking_items_tenant_id_fkey,
  ADD CONSTRAINT booking_items_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  DROP CONSTRAINT IF EXISTS booking_items_tenant_id_booking_id_fkey,
  ADD COLUMN IF NOT EXISTS facility_id uuid,
  ADD COLUMN IF NOT EXISTS slot_ref text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS business_date date,
  ADD COLUMN IF NOT EXISTS local_start text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS local_end text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS local_offset text NOT NULL DEFAULT '+00:00';

UPDATE booking_items bi
SET
  facility_id = b.facility_id,
  business_date = COALESCE(bi.business_date, (bi.starts_at AT TIME ZONE b.facility_time_zone)::date)
FROM bookings b
WHERE bi.booking_id = b.id AND bi.facility_id IS NULL;

ALTER TABLE booking_items
  ALTER COLUMN facility_id SET NOT NULL,
  ALTER COLUMN business_date SET NOT NULL,
  ADD CONSTRAINT booking_items_booking_fkey FOREIGN KEY (tenant_id, facility_id, booking_id) REFERENCES bookings(tenant_id, facility_id, id) ON DELETE RESTRICT;

-- 13. Authoritative XOR allocations table
CREATE TABLE IF NOT EXISTS allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  facility_id uuid NOT NULL,
  hold_id uuid,
  booking_id uuid,
  service_start timestamptz NOT NULL,
  service_end timestamptz NOT NULL,
  occupied_start timestamptz NOT NULL,
  occupied_end timestamptz NOT NULL,
  occupied_range tstzrange GENERATED ALWAYS AS (tstzrange(occupied_start, occupied_end, '[)')) STORED,
  status text NOT NULL CHECK (status IN ('held', 'reserved', 'released')),
  expires_at timestamptz,
  released_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (service_start < service_end),
  CHECK (occupied_start <= service_start AND occupied_end >= service_end),
  CHECK ((hold_id IS NOT NULL) <> (booking_id IS NOT NULL)),
  CHECK (
    (status = 'held' AND hold_id IS NOT NULL AND booking_id IS NULL AND expires_at IS NOT NULL)
    OR (status = 'reserved' AND booking_id IS NOT NULL AND hold_id IS NULL AND expires_at IS NULL)
    OR (status = 'released' AND expires_at IS NULL)
  ),
  UNIQUE (hold_id),
  UNIQUE (booking_id),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, facility_id, hold_id) REFERENCES holds(tenant_id, facility_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id, facility_id, booking_id) REFERENCES bookings(tenant_id, facility_id, id) ON DELETE RESTRICT,
  EXCLUDE USING gist (tenant_id WITH =, facility_id WITH =, occupied_range WITH &&)
    WHERE (status IN ('held', 'reserved'))
);
CREATE INDEX IF NOT EXISTS allocations_expiry_idx ON allocations(tenant_id, facility_id, expires_at) WHERE status = 'held';
CREATE INDEX IF NOT EXISTS allocations_lookup_idx ON allocations(tenant_id, facility_id, occupied_start, occupied_end) WHERE status IN ('held', 'reserved');

-- Migrate any remaining M1 booking_allocations rows into allocations
INSERT INTO allocations (
  id, tenant_id, facility_id, booking_id, service_start, service_end,
  occupied_start, occupied_end, status, expires_at, released_at, created_at, updated_at
)
SELECT
  ba.id, ba.tenant_id, ba.facility_id, ba.booking_id, ba.starts_at, ba.ends_at,
  ba.reserved_from, ba.reserved_until,
  CASE WHEN ba.status = 'confirmed' THEN 'reserved' ELSE 'released' END,
  NULL,
  CASE WHEN ba.status = 'cancelled' THEN ba.updated_at ELSE NULL END,
  ba.created_at, ba.updated_at
FROM booking_allocations ba
JOIN bookings b ON b.id = ba.booking_id
ON CONFLICT DO NOTHING;

DROP TABLE IF EXISTS booking_allocations;
DROP TABLE IF EXISTS booking_holds;

-- 14. Scoped idempotency records with retention deadline
ALTER TABLE idempotency_records
  DROP CONSTRAINT IF EXISTS idempotency_records_pkey,
  DROP CONSTRAINT IF EXISTS idempotency_records_tenant_id_fkey,
  ADD CONSTRAINT idempotency_records_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS caller_namespace text NOT NULL DEFAULT 'default',
  ADD COLUMN IF NOT EXISTS status_code text NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days');

ALTER TABLE idempotency_records
  ADD PRIMARY KEY (tenant_id, caller_namespace, operation, idempotency_key);
CREATE INDEX IF NOT EXISTS idempotency_records_expiry_idx ON idempotency_records(expires_at);

-- 15. Append-only audit log
CREATE TABLE IF NOT EXISTS booking_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  facility_id uuid,
  action text NOT NULL,
  actor_json jsonb NOT NULL,
  prior_state text,
  new_state text,
  diff_json jsonb,
  reason text,
  correlation_id text,
  decision_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS booking_history_aggregate_idx
  ON booking_history(tenant_id, aggregate_type, aggregate_id, recorded_at ASC);

-- 16. Durable outbox events with lease claiming and bounded retries
CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  aggregate_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  aggregate_sequence integer NOT NULL CHECK (aggregate_sequence >= 1),
  event_type text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  payload jsonb NOT NULL,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'failed', 'delivered')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  last_error text,
  delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_events_claim_idx
  ON outbox_events(status, next_attempt_at, lease_expires_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS outbox_events_aggregate_idx
  ON outbox_events(tenant_id, aggregate_id, aggregate_sequence);

DROP TABLE IF EXISTS booking_outbox;

