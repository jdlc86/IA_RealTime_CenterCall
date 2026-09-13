-- Reservation capacity concurrency invariant.
--
-- This does NOT implement conversational HOLDs or expirations. It mirrors the
-- existing occupied statuses (HELD/BOOKED) solely so every physical table
-- allocation carries an enforceable time range at schema level.

create extension if not exists btree_gist with schema extensions;

alter table public.reservation_tables
  add column if not exists allocation_starts_at timestamptz,
  add column if not exists allocation_ends_at timestamptz,
  add column if not exists allocation_active boolean;

update public.reservation_tables rt
set allocation_starts_at = r.starts_at,
    allocation_ends_at = r.ends_at,
    allocation_active = r.status in ('HELD','BOOKED')
from public.reservations r
where r.id = rt.reservation_id
  and (
    rt.allocation_starts_at is distinct from r.starts_at
    or rt.allocation_ends_at is distinct from r.ends_at
    or rt.allocation_active is distinct from (r.status in ('HELD','BOOKED'))
  );

alter table public.reservation_tables
  alter column allocation_starts_at set not null,
  alter column allocation_ends_at set not null,
  alter column allocation_active set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.reservation_tables'::regclass
      and conname = 'reservation_tables_allocation_time_check'
  ) then
    alter table public.reservation_tables
      add constraint reservation_tables_allocation_time_check
      check (allocation_ends_at > allocation_starts_at);
  end if;
end
$$;

create or replace function public.derive_reservation_table_allocation()
returns trigger
language plpgsql
as $$
declare
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_status text;
begin
  select r.starts_at, r.ends_at, r.status
    into v_starts_at, v_ends_at, v_status
  from public.reservations r
  where r.id = new.reservation_id;

  if not found then
    raise exception 'reservation_not_found_for_table_allocation';
  end if;

  new.allocation_starts_at := v_starts_at;
  new.allocation_ends_at := v_ends_at;
  new.allocation_active := v_status in ('HELD','BOOKED');
  return new;
end;
$$;

drop trigger if exists reservation_tables_derive_allocation on public.reservation_tables;
create trigger reservation_tables_derive_allocation
before insert or update on public.reservation_tables
for each row
execute function public.derive_reservation_table_allocation();

create or replace function public.sync_reservation_table_allocations()
returns trigger
language plpgsql
as $$
begin
  update public.reservation_tables
  set allocation_starts_at = new.starts_at,
      allocation_ends_at = new.ends_at,
      allocation_active = new.status in ('HELD','BOOKED')
  where reservation_id = new.id;
  return new;
end;
$$;

drop trigger if exists reservations_sync_table_allocations on public.reservations;
create trigger reservations_sync_table_allocations
after update of starts_at, ends_at, status on public.reservations
for each row
when (
  old.starts_at is distinct from new.starts_at
  or old.ends_at is distinct from new.ends_at
  or old.status is distinct from new.status
)
execute function public.sync_reservation_table_allocations();

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.reservation_tables'::regclass
      and conname = 'reservation_tables_no_active_overlap'
  ) then
    alter table public.reservation_tables
      add constraint reservation_tables_no_active_overlap
      exclude using gist (
        table_id with =,
        tstzrange(allocation_starts_at, allocation_ends_at, '[)') with &&
      )
      where (allocation_active);
  end if;
end
$$;

-- The modification RPC used to update the parent reservation before removing
-- its old table allocation. With the schema invariant that could create a
-- transient false conflict on the old table. Remove the old allocation first;
-- the whole function remains one transaction, so any later error rolls it back.
create or replace function public.modify_restaurant_reservation(
  p_tenant_id text,
  p_reservation_id uuid,
  p_caller_phone text,
  p_party_size integer,
  p_starts_at timestamptz,
  p_duration_minutes integer,
  p_customer_name text default null,
  p_notes text default null
)
returns table(
  reservation_code text,
  table_id uuid,
  table_code text,
  table_name text,
  starts_at timestamptz,
  ends_at timestamptz,
  party_size integer,
  status text,
  allocation_mode text
)
language plpgsql
as $$
declare
  v_reservation public.reservations%rowtype;
  v_table_ids uuid[];
  v_mode text;
  v_ends_at timestamptz;
begin
  select * into v_reservation
  from public.reservations r
  where r.id = p_reservation_id
    and r.tenant_id = p_tenant_id
    and r.customer_phone = p_caller_phone
    and r.status = 'BOOKED'
  for update;
  if v_reservation.id is null then raise exception 'reservation_not_found'; end if;
  if p_party_size <= 0 or p_party_size > 100 then raise exception 'invalid_party_size'; end if;
  if p_duration_minutes < 15 or p_duration_minutes > 480 then raise exception 'invalid_duration_minutes'; end if;

  v_ends_at := p_starts_at + make_interval(mins => p_duration_minutes);

  select array_agg(p.table_id order by p.plan_order), min(p.allocation_mode)
    into v_table_ids, v_mode
  from public.check_restaurant_table_plan(
    p_tenant_id,
    p_starts_at,
    p_party_size,
    p_duration_minutes,
    p_reservation_id
  ) p;
  if v_table_ids is null or cardinality(v_table_ids) = 0 then raise exception 'no_availability'; end if;

  perform 1
  from public.restaurant_tables t
  where t.id = any(v_table_ids)
  order by t.id
  for update;

  if exists (
    select 1
    from public.reservation_tables rt
    join public.reservations r on r.id = rt.reservation_id
    where rt.table_id = any(v_table_ids)
      and r.tenant_id = p_tenant_id
      and r.id <> p_reservation_id
      and r.status in ('HELD','BOOKED')
      and tstzrange(r.starts_at, r.ends_at, '[)') && tstzrange(p_starts_at, v_ends_at, '[)')
  ) then
    raise exception 'no_availability';
  end if;

  delete from public.reservation_tables
  where reservation_id = p_reservation_id;

  update public.reservations
  set party_size = p_party_size,
      starts_at = p_starts_at,
      ends_at = v_ends_at,
      customer_name = coalesce(nullif(btrim(p_customer_name), ''), customer_name),
      notes = case when p_notes is null then notes else nullif(btrim(p_notes), '') end,
      updated_at = now()
  where id = p_reservation_id
  returning * into v_reservation;

  insert into public.reservation_tables(reservation_id, table_id)
  select p_reservation_id, unnest(v_table_ids);

  return query
  select v_reservation.reservation_code,
         t.id,
         t.code,
         t.display_name,
         v_reservation.starts_at,
         v_reservation.ends_at,
         v_reservation.party_size,
         v_reservation.status,
         v_mode
  from public.restaurant_tables t
  where t.id = any(v_table_ids)
  order by array_position(v_table_ids, t.id);
end;
$$;
