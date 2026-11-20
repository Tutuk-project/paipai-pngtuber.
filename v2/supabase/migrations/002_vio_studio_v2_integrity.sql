-- Vio Studio v2.0 integrity migration.
-- Completes tables and storage buckets referenced by the v2 Edge Function.
-- Additive only: does not alter v1.0 tables or the legacy pngtuber-assets bucket.

create table if not exists public.vio_character_accessories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.vio_app_users(id) on delete cascade,
  character_id uuid not null references public.vio_characters(id) on delete cascade,
  name text not null default 'Accessory' check (length(name) between 1 and 120),
  bucket_id text not null default 'vio-studio-assets' check (bucket_id = 'vio-studio-assets'),
  storage_path text not null,
  mime_type text not null check (mime_type in ('image/png','image/webp')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 8388608),
  x double precision not null default 0.5 check (x between 0 and 1),
  y double precision not null default 0.5 check (y between 0 and 1),
  w double precision not null default 0.35 check (w between 0.01 and 2),
  h double precision not null default 0.35 check (h between 0.01 and 2),
  mirror boolean not null default false,
  follow_avatar boolean not null default true,
  effects_enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bucket_id, storage_path)
);
create index if not exists vio_character_accessories_user_idx
  on public.vio_character_accessories(user_id, character_id, sort_order);

alter table public.vio_character_accessories enable row level security;
drop policy if exists vio_accessories_read_self_or_admin on public.vio_character_accessories;
create policy vio_accessories_read_self_or_admin
  on public.vio_character_accessories for select to authenticated
  using (user_id = public.vio_current_app_user_id() or public.vio_is_admin());
drop policy if exists vio_accessories_write_self_or_admin on public.vio_character_accessories;
create policy vio_accessories_write_self_or_admin
  on public.vio_character_accessories for all to authenticated
  using (user_id = public.vio_current_app_user_id() or public.vio_is_admin())
  with check (user_id = public.vio_current_app_user_id() or public.vio_is_admin());

-- Durable retry queue for Storage cleanup. User IDs are intentionally not FKs:
-- jobs must survive deletion of the account that owned the object.
create table if not exists public.vio_storage_cleanup_queue (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null check (bucket_id in ('vio-studio-assets','vio-backgrounds')),
  storage_path text not null,
  requested_by uuid,
  target_user_id uuid,
  reason text not null,
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  last_error text,
  unique(bucket_id, storage_path)
);
create index if not exists vio_storage_cleanup_pending_idx
  on public.vio_storage_cleanup_queue(created_at)
  where processed_at is null;
alter table public.vio_storage_cleanup_queue enable row level security;
-- No client policy: only the Edge Function service-role client may inspect or mutate jobs.

-- Private background bucket. Background media accepts the formats and 50 MiB
-- upper bound already enforced by record_background_asset.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'vio-backgrounds',
  'vio-backgrounds',
  false,
  52428800,
  array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm']
)
on conflict(id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists vio_backgrounds_read_self_or_admin on storage.objects;
create policy vio_backgrounds_read_self_or_admin
  on storage.objects for select to authenticated
  using (
    bucket_id = 'vio-backgrounds'
    and ((storage.foldername(name))[1] = public.vio_current_app_user_id()::text or public.vio_is_admin())
  );
drop policy if exists vio_backgrounds_insert_self on storage.objects;
create policy vio_backgrounds_insert_self
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'vio-backgrounds'
    and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text
  );
drop policy if exists vio_backgrounds_update_self on storage.objects;
create policy vio_backgrounds_update_self
  on storage.objects for update to authenticated
  using (
    bucket_id = 'vio-backgrounds'
    and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text
  )
  with check (
    bucket_id = 'vio-backgrounds'
    and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text
  );
drop policy if exists vio_backgrounds_delete_self_or_admin on storage.objects;
create policy vio_backgrounds_delete_self_or_admin
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'vio-backgrounds'
    and ((storage.foldername(name))[1] = public.vio_current_app_user_id()::text or public.vio_is_admin())
  );

-- The initial migration's Realtime policies checked membership but did not
-- require the parent room to remain active and unexpired. Enforce both here.
drop policy if exists vio_room_realtime_read on realtime.messages;
create policy vio_room_realtime_read on realtime.messages for select to authenticated
using (
  extension in ('broadcast','presence')
  and topic like 'room:%'
  and (
    exists (
      select 1
      from public.vio_room_members m
      join public.vio_user_devices d on d.app_user_id = m.user_id
      join public.vio_app_users u on u.id = m.user_id and u.is_active
      join public.vio_rooms r on r.id = m.room_id and r.status = 'active' and r.expires_at > now()
      where d.auth_user_id = auth.uid()
        and topic = ('room:' || m.room_id::text)
    )
    or exists (
      select 1
      from public.vio_overlay_devices od
      join public.vio_rooms r on r.id = od.room_id and r.status = 'active' and r.expires_at > now()
      where od.auth_user_id = auth.uid()
        and topic = ('room:' || od.room_id::text)
    )
  )
);

drop policy if exists vio_room_realtime_write on realtime.messages;
create policy vio_room_realtime_write on realtime.messages for insert to authenticated
with check (
  extension in ('broadcast','presence')
  and topic like 'room:%'
  and exists (
    select 1
    from public.vio_room_members m
    join public.vio_user_devices d on d.app_user_id = m.user_id
    join public.vio_app_users u on u.id = m.user_id and u.is_active
    join public.vio_rooms r on r.id = m.room_id and r.status = 'active' and r.expires_at > now()
    where d.auth_user_id = auth.uid()
      and topic = ('room:' || m.room_id::text)
  )
);

comment on table public.vio_character_accessories is 'Per-character transparent accessory assets and normalized placement/effect settings.';
comment on table public.vio_storage_cleanup_queue is 'Server-only retry queue for Storage object deletion; survives account deletion.';
