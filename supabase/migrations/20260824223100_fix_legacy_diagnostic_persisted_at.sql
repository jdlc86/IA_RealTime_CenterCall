-- The preceding cross-plane migration added persisted_at with DEFAULT now(),
-- so PostgreSQL populated historical rows with the migration timestamp before
-- the backfill could coalesce them to created_at. Legacy writers do not have a
-- separate source occurrence timestamp; for those rows created_at is the
-- authoritative persistence time and occurred_at is already backfilled from it.
update public.call_diagnostic_events
set persisted_at = created_at
where event_id like 'legacy:%'
  and occurred_at = created_at
  and persisted_at is distinct from created_at;
