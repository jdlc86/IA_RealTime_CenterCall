create table if not exists public.human_handoff_events (
  id uuid primary key,
  tenant_id text not null,
  call_id text not null,
  caller_phone text not null,
  reason_code text not null,
  reason_summary text,
  destination_type text not null default 'PHONE',
  destination_label text,
  destination_phone text not null,
  status text not null,
  requested_at timestamptz not null default now(),
  transfer_started_at timestamptz,
  answered_at timestamptz,
  transfer_ended_at timestamptz,
  call_terminated_at timestamptz,
  target_call_control_id text,
  callback_required boolean not null default false,
  callback_status text,
  callback_completed_at timestamptz,
  callback_notes text,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint human_handoff_destination_type_chk check (destination_type = 'PHONE'),
  constraint human_handoff_status_chk check (status in ('REQUESTED','ANNOUNCING','DIALING','ANSWERED','TRANSFERRED','NO_ANSWER','BUSY','FAILED','CALLBACK_REQUIRED','TERMINATED')),
  constraint human_handoff_callback_status_chk check (callback_status is null or callback_status in ('PENDING','CONTACTED','RESOLVED','UNREACHABLE','CANCELLED'))
);

create index if not exists human_handoff_events_tenant_created_idx
  on public.human_handoff_events (tenant_id, created_at desc);

create index if not exists human_handoff_events_callback_queue_idx
  on public.human_handoff_events (tenant_id, callback_required, callback_status, created_at desc);

create index if not exists human_handoff_events_call_idx
  on public.human_handoff_events (tenant_id, call_id, created_at desc);

alter table public.human_handoff_events enable row level security;
