CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE facilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL,
  time_zone text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id)
);
CREATE INDEX facilities_tenant_idx ON facilities(tenant_id, active);

CREATE TABLE facility_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id uuid NOT NULL,
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  opens_at time NOT NULL,
  closes_at time NOT NULL,
  effective_from date NOT NULL,
  effective_until date,
  CHECK (opens_at < closes_at),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX facility_schedules_lookup_idx ON facility_schedules(tenant_id, facility_id, weekday, effective_from, effective_until);

CREATE TABLE schedule_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES facility_schedules(id) ON DELETE CASCADE,
  starts_at time NOT NULL,
  ends_at time NOT NULL,
  CHECK (starts_at < ends_at)
);

CREATE TABLE slot_policies (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id uuid NOT NULL,
  duration_minutes integer NOT NULL CHECK (duration_minutes BETWEEN 5 AND 1440),
  interval_minutes integer NOT NULL CHECK (interval_minutes BETWEEN 5 AND 1440),
  min_notice_minutes integer NOT NULL DEFAULT 0 CHECK (min_notice_minutes >= 0),
  max_advance_days integer NOT NULL DEFAULT 90 CHECK (max_advance_days BETWEEN 1 AND 730),
  buffer_before_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_before_minutes >= 0),
  buffer_after_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_after_minutes >= 0),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, facility_id),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE facility_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  CHECK (starts_at < ends_at),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX facility_blocks_lookup_idx ON facility_blocks(tenant_id, facility_id, starts_at, ends_at) WHERE active;

CREATE TABLE bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'confirmed', 'cancelled', 'expired')),
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id)
);
CREATE INDEX bookings_tenant_facility_start_idx ON bookings(tenant_id, facility_id, starts_at);

CREATE TABLE booking_holds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('active', 'converted', 'released', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX booking_holds_expiry_idx ON booking_holds(tenant_id, expires_at) WHERE state = 'active';

CREATE TABLE booking_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  facility_id uuid NOT NULL,
  booking_id uuid NOT NULL UNIQUE,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reserved_from timestamptz NOT NULL,
  reserved_until timestamptz NOT NULL,
  reserved_range tstzrange GENERATED ALWAYS AS (tstzrange(reserved_from, reserved_until, '[)')) STORED,
  status text NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled', 'expired')),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (starts_at < ends_at),
  CHECK (reserved_from < reserved_until),
  CHECK ((status = 'held' AND expires_at IS NOT NULL) OR (status <> 'held' AND expires_at IS NULL)),
  FOREIGN KEY (tenant_id, facility_id) REFERENCES facilities(tenant_id, id),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id) ON DELETE CASCADE,
  EXCLUDE USING gist (tenant_id WITH =, facility_id WITH =, reserved_range WITH &&)
    WHERE (status IN ('held', 'confirmed'))
);
CREATE INDEX booking_allocations_expiry_idx ON booking_allocations(tenant_id, facility_id, expires_at) WHERE status = 'held';

CREATE TABLE booking_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  booking_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  price_minor bigint NOT NULL CHECK (price_minor >= 0),
  currency char(3) NOT NULL,
  CHECK (starts_at < ends_at),
  FOREIGN KEY (tenant_id, booking_id) REFERENCES bookings(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX booking_items_booking_idx ON booking_items(tenant_id, booking_id, starts_at);

CREATE TABLE idempotency_records (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  operation text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, operation, idempotency_key)
);

CREATE TABLE booking_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  aggregate_id uuid NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX booking_outbox_pending_idx ON booking_outbox(created_at) WHERE delivered_at IS NULL;
