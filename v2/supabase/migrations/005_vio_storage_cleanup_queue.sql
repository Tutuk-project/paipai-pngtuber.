-- Durable retry queue for Storage objects whose database records are removed.
-- Only the service-role Edge Function may read or mutate this table.
create table if not exists public.vio_storage_cleanup_queue (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null check (bucket_id in ('vio-studio-assets','vio-backgrounds')),
  storage_path text not null check (length(storage_path) between 1 and 512),
  requested_by uuid references public.vio_app_users(id) on delete set null,
  target_user_id uuid references public.vio_app_users(id) on delete set null,
  reason text not null check (length(reason) between 1 and 80),
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (bucket_id, storage_path)
);

create index if not exists vio_storage_cleanup_pending_idx
  on public.vio_storage_cleanup_queue(created_at)
  where processed_at is null;

alter table public.vio_storage_cleanup_queue enable row level security;
-- Intentionally no authenticated policies: cleanup jobs are service-role only.

comment on table public.vio_storage_cleanup_queue is
  'Durable retry queue for private Storage object deletion after metadata removal.';
