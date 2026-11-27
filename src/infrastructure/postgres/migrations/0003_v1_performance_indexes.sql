-- V1 performance indexes: eliminate outbox claim sort and speed up narrow allocation/hold lookups.

CREATE INDEX IF NOT EXISTS outbox_events_claim_ordered_idx
  ON outbox_events(recorded_at ASC, aggregate_sequence ASC, next_attempt_at, lease_expires_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS holds_tenant_fac_active_cust_idx
  ON holds(tenant_id, facility_id, external_customer_id, expires_at)
  WHERE state = 'active';

CREATE INDEX IF NOT EXISTS allocations_tenant_fac_held_expiry_idx
  ON allocations(tenant_id, facility_id, expires_at)
  WHERE status = 'held';

