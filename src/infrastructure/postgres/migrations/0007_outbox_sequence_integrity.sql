-- Remediate historical aggregate_sequence collisions on outbox_events and enforce database-level uniqueness.

WITH collided_aggregates AS (
  SELECT DISTINCT tenant_id, aggregate_type, aggregate_id
  FROM outbox_events
  GROUP BY tenant_id, aggregate_type, aggregate_id, aggregate_sequence
  HAVING COUNT(*) > 1
),
renumbered AS (
  SELECT
    o.id,
    ROW_NUMBER() OVER (
      PARTITION BY o.tenant_id, o.aggregate_type, o.aggregate_id
      ORDER BY o.aggregate_sequence ASC, o.occurred_at ASC, o.recorded_at ASC, o.id ASC
    )::integer AS new_seq
  FROM outbox_events o
  JOIN collided_aggregates c
    ON c.tenant_id = o.tenant_id
   AND c.aggregate_type = o.aggregate_type
   AND c.aggregate_id = o.aggregate_id
)
UPDATE outbox_events o
SET aggregate_sequence = r.new_seq
FROM renumbered r
WHERE o.id = r.id
  AND o.aggregate_sequence <> r.new_seq;

-- Synchronize aggregate parent sequence counters so subsequent lifecycle events strictly increment.
WITH booking_max AS (
  SELECT tenant_id, aggregate_id, MAX(aggregate_sequence)::integer AS max_seq
  FROM outbox_events
  WHERE aggregate_type = 'booking'
  GROUP BY tenant_id, aggregate_id
)
UPDATE bookings b
SET sequence = GREATEST(b.sequence, bm.max_seq)
FROM booking_max bm
WHERE b.tenant_id = bm.tenant_id
  AND b.id = bm.aggregate_id
  AND b.sequence < bm.max_seq;

WITH hold_max AS (
  SELECT tenant_id, aggregate_id, MAX(aggregate_sequence)::integer AS max_seq
  FROM outbox_events
  WHERE aggregate_type = 'hold'
  GROUP BY tenant_id, aggregate_id
)
UPDATE holds h
SET sequence = GREATEST(h.sequence, hm.max_seq)
FROM hold_max hm
WHERE h.tenant_id = hm.tenant_id
  AND h.id = hm.aggregate_id
  AND h.sequence < hm.max_seq;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_aggregate_seq_uidx
  ON outbox_events(tenant_id, aggregate_type, aggregate_id, aggregate_sequence);

DROP INDEX IF EXISTS outbox_events_aggregate_idx;
