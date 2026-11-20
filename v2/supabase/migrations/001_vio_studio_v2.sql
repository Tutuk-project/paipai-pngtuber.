-- Vio Studio v2.0 additive schema.
-- This migration deliberately leaves all v1.0 tables and the pngtuber-assets bucket intact.
-- Review the Supabase project schema before applying to production.

create extension if not exists pgcrypto with schema extensions;

create table if not exists public.vio_app_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  role text not null default 'user' check (role in ('admin','user','tester')),
  is_active boolean not null default true,
  display_name text,
  created_at timestamptz not null default now(),
  created_by uuid references public.vio_app_users(id) on delete set null,
  last_seen_at timestamptz
);
create unique index if not exists vio_app_users_username_lower_uq on public.vio_app_users (lower(username));

create table if not exists public.vio_user_devices (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  app_user_id uuid not null references public.vio_app_users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  device_label text
);
create index if not exists vio_user_devices_app_user_idx on public.vio_user_devices(app_user_id);

create table if not exists public.vio_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  app_user_id uuid not null references public.vio_app_users(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.vio_app_users(id) on delete set null
);
create index if not exists vio_pairing_codes_user_idx on public.vio_pairing_codes(app_user_id, expires_at) where used_at is null;

create table if not exists public.vio_profiles (
  user_id uuid primary key references public.vio_app_users(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  active_character_id uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.vio_characters (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.vio_app_users(id) on delete cascade,
  name text not null default 'Default',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vio_characters_user_idx on public.vio_characters(user_id);
alter table public.vio_profiles drop constraint if exists vio_profiles_active_character_fk;
alter table public.vio_profiles add constraint vio_profiles_active_character_fk foreign key (active_character_id) references public.vio_characters(id) on delete set null;

create table if not exists public.vio_character_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.vio_app_users(id) on delete cascade,
  character_id uuid not null references public.vio_characters(id) on delete cascade,
  expression text not null check (expression in ('idle','talking','blink','talking_blink','thumbnail')),
  bucket_id text not null default 'vio-studio-assets',
  storage_path text not null,
  mime_type text not null check (mime_type in ('image/png','image/webp')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 8388608),
  updated_at timestamptz not null default now(),
  unique(character_id, expression),
  unique(bucket_id, storage_path)
);
create index if not exists vio_character_assets_user_idx on public.vio_character_assets(user_id);

create table if not exists public.vio_rooms (
  id uuid primary key default gen_random_uuid(),
  room_code char(4) not null check (room_code ~ '^[0-9]{4}$'),
  host_user_id uuid not null references public.vio_app_users(id) on delete cascade,
  capacity smallint not null check (capacity between 1 and 4),
  purpose text not null default 'collaboration' check (purpose in ('collaboration','personal_overlay')),
  status text not null default 'active' check (status in ('active','closed','expired')),
  overlay_token_hash text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '8 hours'),
  closed_at timestamptz
);
-- Room codes are unique only while a room is active, so a closed/expired code
-- can be reused instead of exhausting the 10,000-code space over time.
alter table public.vio_rooms drop constraint if exists vio_rooms_room_code_key;
create unique index if not exists vio_rooms_active_code_uq on public.vio_rooms(room_code) where status='active';
create index if not exists vio_rooms_status_idx on public.vio_rooms(status, expires_at);

create table if not exists public.vio_room_join_attempts (
  id bigint generated always as identity primary key,
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now(),
  attempted_code text
);
create index if not exists vio_room_join_attempts_recent_idx on public.vio_room_join_attempts(auth_user_id, attempted_at desc);

create table if not exists public.vio_room_members (
  room_id uuid not null references public.vio_rooms(id) on delete cascade,
  user_id uuid not null references public.vio_app_users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  is_host boolean not null default false,
  state text not null default 'idle' check (state in ('idle','talking')),
  state_updated_at timestamptz not null default now(),
  primary key(room_id, user_id)
);
create index if not exists vio_room_members_user_idx on public.vio_room_members(user_id, room_id);

create table if not exists public.vio_room_overrides (
  room_id uuid not null,
  user_id uuid not null,
  overrides jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key(room_id, user_id),
  foreign key(room_id, user_id) references public.vio_room_members(room_id, user_id) on delete cascade
);

create table if not exists public.vio_overlay_devices (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  room_id uuid not null references public.vio_rooms(id) on delete cascade,
  connected_at timestamptz not null default now()
);

create table if not exists public.vio_support_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  admin_user_id uuid not null references public.vio_app_users(id) on delete cascade,
  target_user_id uuid not null references public.vio_app_users(id) on delete cascade,
  reason text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);

create table if not exists public.vio_audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references public.vio_app_users(id) on delete set null,
  target_user_id uuid references public.vio_app_users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists vio_audit_logs_created_idx on public.vio_audit_logs(created_at desc);

create or replace function public.vio_current_app_user_id()
returns uuid language sql stable security definer set search_path = public, auth
as $$
  select d.app_user_id
  from public.vio_user_devices d
  join public.vio_app_users u on u.id = d.app_user_id and u.is_active
  where d.auth_user_id = auth.uid()
  limit 1;
$$;

create or replace function public.vio_is_admin()
returns boolean language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1 from public.vio_user_devices d
    join public.vio_app_users u on u.id = d.app_user_id
    where d.auth_user_id = auth.uid() and u.role = 'admin' and u.is_active
  );
$$;

create or replace function public.vio_is_room_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public, auth
as $$
  select exists (
    select 1 from public.vio_user_devices d
    join public.vio_app_users u on u.id = d.app_user_id and u.is_active
    join public.vio_room_members m on m.user_id = d.app_user_id
    join public.vio_rooms r on r.id = m.room_id and r.status = 'active' and r.expires_at > now()
    where d.auth_user_id = auth.uid() and m.room_id = p_room_id
  ) or exists (
    select 1 from public.vio_overlay_devices od
    join public.vio_rooms r on r.id = od.room_id and r.status = 'active' and r.expires_at > now()
    where od.auth_user_id = auth.uid() and od.room_id = p_room_id
  );
$$;

create or replace function public.vio_join_room(p_room_code text, p_user_id uuid)
returns public.vio_rooms language plpgsql security definer set search_path = public
as $$
declare
  v_room public.vio_rooms;
  v_count integer;
begin
  select * into v_room from public.vio_rooms
  where room_code = p_room_code and status = 'active' and expires_at > now()
  for update;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if exists (select 1 from public.vio_room_members where room_id=v_room.id and user_id=p_user_id) then
    return v_room;
  end if;
  if exists (
    select 1 from public.vio_room_members m
    join public.vio_rooms r on r.id=m.room_id
    where m.user_id=p_user_id and r.status='active' and r.expires_at > now() and r.id <> v_room.id
  ) then raise exception 'ALREADY_IN_ROOM'; end if;
  select count(*) into v_count from public.vio_room_members where room_id=v_room.id;
  if v_count >= v_room.capacity then raise exception 'ROOM_FULL'; end if;
  insert into public.vio_room_members(room_id,user_id,is_host) values(v_room.id,p_user_id,false);
  return v_room;
end;
$$;

create or replace function public.vio_admin_create_user(p_username text, p_role text, p_created_by uuid, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_user public.vio_app_users;
begin
  if p_username !~ '^[a-z0-9_]{3,24}$' then raise exception 'INVALID_USERNAME'; end if;
  if p_role not in ('user','tester') then raise exception 'INVALID_ROLE'; end if;
  if p_code_hash is null or length(p_code_hash) <> 64 then raise exception 'INVALID_PAIRING_HASH'; end if;
  insert into public.vio_app_users(username,role,created_by)
  values(lower(p_username),p_role,p_created_by)
  returning * into v_user;
  insert into public.vio_profiles(user_id) values(v_user.id);
  insert into public.vio_pairing_codes(app_user_id,code_hash,expires_at,created_by)
  values(v_user.id,p_code_hash,now() + interval '72 hours',p_created_by);
  insert into public.vio_audit_logs(actor_user_id,target_user_id,action,details)
  values(p_created_by,v_user.id,'user_created',jsonb_build_object('username',v_user.username,'role',v_user.role));
  return jsonb_build_object('id',v_user.id,'username',v_user.username,'role',v_user.role,'is_active',v_user.is_active);
end;
$$;

create or replace function public.vio_activate_device(p_auth_uid uuid, p_username text, p_code_hash text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_user public.vio_app_users;
  v_pair public.vio_pairing_codes;
begin
  select * into v_user from public.vio_app_users where lower(username)=lower(p_username) and is_active=true for update;
  if not found then raise exception 'ACCOUNT_NOT_FOUND'; end if;
  select * into v_pair from public.vio_pairing_codes
    where app_user_id=v_user.id and code_hash=p_code_hash and used_at is null and expires_at > now()
    order by created_at desc limit 1 for update;
  if not found then raise exception 'PAIRING_CODE_INVALID'; end if;
  if exists (select 1 from public.vio_user_devices where auth_user_id=p_auth_uid and app_user_id<>v_user.id) then
    raise exception 'DEVICE_ALREADY_BOUND';
  end if;
  update public.vio_pairing_codes set used_at=now() where id=v_pair.id;
  insert into public.vio_user_devices(auth_user_id,app_user_id) values(p_auth_uid,v_user.id)
  on conflict(auth_user_id) do update set app_user_id=excluded.app_user_id,last_seen_at=now();
  update public.vio_app_users set last_seen_at=now() where id=v_user.id;
  insert into public.vio_profiles(user_id) values(v_user.id) on conflict(user_id) do nothing;
  return jsonb_build_object('id',v_user.id,'username',v_user.username,'role',v_user.role,'display_name',v_user.display_name);
end;
$$;

create or replace function public.vio_bootstrap_admin(p_auth_uid uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_user public.vio_app_users;
begin
  if lower(p_username) <> 'paipai77' then raise exception 'BOOTSTRAP_USERNAME_MISMATCH'; end if;
  if exists(select 1 from public.vio_app_users where role='admin') then raise exception 'ADMIN_ALREADY_EXISTS'; end if;
  insert into public.vio_app_users(username,role,display_name) values('paipai77','admin','Vio Studio Admin') returning * into v_user;
  insert into public.vio_user_devices(auth_user_id,app_user_id) values(p_auth_uid,v_user.id);
  insert into public.vio_profiles(user_id) values(v_user.id);
  insert into public.vio_audit_logs(actor_user_id,target_user_id,action,details) values(v_user.id,v_user.id,'bootstrap_admin','{"method":"one_time_bootstrap"}'::jsonb);
  return jsonb_build_object('id',v_user.id,'username',v_user.username,'role',v_user.role,'display_name',v_user.display_name);
end;
$$;

-- All privileged RPCs are callable only by the Edge Function's secret key.
revoke all on function public.vio_admin_create_user(text,text,uuid,text) from public, anon, authenticated;
revoke all on function public.vio_activate_device(uuid,text,text) from public, anon, authenticated;
revoke all on function public.vio_bootstrap_admin(uuid,text) from public, anon, authenticated;
revoke all on function public.vio_join_room(text,uuid) from public, anon, authenticated;
grant execute on function public.vio_admin_create_user(text,text,uuid,text) to service_role;
grant execute on function public.vio_activate_device(uuid,text,text) to service_role;
grant execute on function public.vio_bootstrap_admin(uuid,text) to service_role;
grant execute on function public.vio_join_room(text,uuid) to service_role;

alter table public.vio_app_users enable row level security;
alter table public.vio_user_devices enable row level security;
alter table public.vio_pairing_codes enable row level security;
alter table public.vio_profiles enable row level security;
alter table public.vio_characters enable row level security;
alter table public.vio_character_assets enable row level security;
alter table public.vio_rooms enable row level security;
alter table public.vio_room_members enable row level security;
alter table public.vio_room_join_attempts enable row level security;
alter table public.vio_room_overrides enable row level security;
alter table public.vio_overlay_devices enable row level security;
alter table public.vio_support_sessions enable row level security;
alter table public.vio_audit_logs enable row level security;

drop policy if exists vio_users_read_self_or_admin on public.vio_app_users;
create policy vio_users_read_self_or_admin on public.vio_app_users for select to authenticated
using (id = public.vio_current_app_user_id() or public.vio_is_admin());
drop policy if exists vio_devices_read_self_or_admin on public.vio_user_devices;
create policy vio_devices_read_self_or_admin on public.vio_user_devices for select to authenticated
using (auth_user_id = auth.uid() or public.vio_is_admin());
drop policy if exists vio_profiles_read_self_or_admin on public.vio_profiles;
create policy vio_profiles_read_self_or_admin on public.vio_profiles for select to authenticated
using (user_id = public.vio_current_app_user_id() or public.vio_is_admin());
drop policy if exists vio_profiles_update_self_or_admin on public.vio_profiles;
create policy vio_profiles_update_self_or_admin on public.vio_profiles for update to authenticated
using (user_id = public.vio_current_app_user_id() or public.vio_is_admin())
with check (user_id = public.vio_current_app_user_id() or public.vio_is_admin());
drop policy if exists vio_characters_read_self_or_admin on public.vio_characters;
create policy vio_characters_read_self_or_admin on public.vio_characters for select to authenticated
using (user_id = public.vio_current_app_user_id() or public.vio_is_admin());
drop policy if exists vio_characters_write_self_or_admin on public.vio_characters;
create policy vio_characters_write_self_or_admin on public.vio_characters for all to authenticated
using (user_id = public.vio_current_app_user_id() or public.vio_is_admin())
with check (user_id = public.vio_current_app_user_id() or public.vio_is_admin());
drop policy if exists vio_assets_read_self_or_admin on public.vio_character_assets;
create policy vio_assets_read_self_or_admin on public.vio_character_assets for select to authenticated
using (user_id = public.vio_current_app_user_id() or public.vio_is_admin());
drop policy if exists vio_assets_write_self_or_admin on public.vio_character_assets;
create policy vio_assets_write_self_or_admin on public.vio_character_assets for all to authenticated
using (user_id = public.vio_current_app_user_id() or public.vio_is_admin())
with check (user_id = public.vio_current_app_user_id() or public.vio_is_admin());
drop policy if exists vio_rooms_read_members_or_admin on public.vio_rooms;
create policy vio_rooms_read_members_or_admin on public.vio_rooms for select to authenticated
using (public.vio_is_room_member(id) or public.vio_is_admin());
drop policy if exists vio_room_members_read_members_or_admin on public.vio_room_members;
create policy vio_room_members_read_members_or_admin on public.vio_room_members for select to authenticated
using (public.vio_is_room_member(room_id) or public.vio_is_admin());
drop policy if exists vio_overrides_read_self_or_admin on public.vio_room_overrides;
create policy vio_overrides_read_self_or_admin on public.vio_room_overrides for select to authenticated
using (user_id = public.vio_current_app_user_id() or public.vio_is_admin());
drop policy if exists vio_overrides_write_self on public.vio_room_overrides;
create policy vio_overrides_write_self on public.vio_room_overrides for all to authenticated
using (user_id = public.vio_current_app_user_id() and public.vio_is_room_member(room_id))
with check (user_id = public.vio_current_app_user_id() and public.vio_is_room_member(room_id));
drop policy if exists vio_audit_admin_read on public.vio_audit_logs;
create policy vio_audit_admin_read on public.vio_audit_logs for select to authenticated
using (public.vio_is_admin());

-- New private bucket. The v1.0 bucket is deliberately untouched.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('vio-studio-assets','vio-studio-assets',false,8388608,array['image/png','image/webp'])
on conflict(id) do nothing;
drop policy if exists vio_storage_read_self_or_admin on storage.objects;
create policy vio_storage_read_self_or_admin on storage.objects for select to authenticated
using (bucket_id='vio-studio-assets' and ((storage.foldername(name))[1] = public.vio_current_app_user_id()::text or public.vio_is_admin()));
drop policy if exists vio_storage_insert_self on storage.objects;
create policy vio_storage_insert_self on storage.objects for insert to authenticated
with check (bucket_id='vio-studio-assets' and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text);
drop policy if exists vio_storage_update_self on storage.objects;
create policy vio_storage_update_self on storage.objects for update to authenticated
using (bucket_id='vio-studio-assets' and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text)
with check (bucket_id='vio-studio-assets' and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text);
drop policy if exists vio_storage_delete_self_or_admin on storage.objects;
create policy vio_storage_delete_self_or_admin on storage.objects for delete to authenticated
using (bucket_id='vio-studio-assets' and ((storage.foldername(name))[1] = public.vio_current_app_user_id()::text or public.vio_is_admin()));

-- Private Realtime topics: room members may send/receive events; overlay devices may only receive.
drop policy if exists vio_room_realtime_read on realtime.messages;
create policy vio_room_realtime_read on realtime.messages for select to authenticated
using (
  extension in ('broadcast','presence') and topic like 'room:%' and (
    exists (
      select 1 from public.vio_room_members m
      join public.vio_user_devices d on d.app_user_id=m.user_id
      join public.vio_app_users u on u.id=m.user_id and u.is_active
      where d.auth_user_id=auth.uid() and topic=('room:' || m.room_id::text)
    )
    or exists (
      select 1 from public.vio_overlay_devices od
      where od.auth_user_id=auth.uid() and topic=('room:' || od.room_id::text)
    )
  )
);
drop policy if exists vio_room_realtime_write on realtime.messages;
create policy vio_room_realtime_write on realtime.messages for insert to authenticated
with check (
  extension in ('broadcast','presence') and topic like 'room:%' and exists (
    select 1 from public.vio_room_members m
    join public.vio_user_devices d on d.app_user_id=m.user_id
    join public.vio_app_users u on u.id=m.user_id and u.is_active
    where d.auth_user_id=auth.uid() and topic=('room:' || m.room_id::text)
  )
);

comment on table public.vio_app_users is 'Vio Studio account directory; role is server-managed, never client supplied.';
comment on table public.vio_user_devices is 'Maps Supabase anonymous auth sessions to manually provisioned Vio usernames.';
comment on table public.vio_pairing_codes is 'Single-use device pairing codes; only their hashes are stored.';
comment on table public.vio_room_overrides is 'Temporary per-user collaboration settings; do not overwrite profile preferences.';
comment on table public.vio_audit_logs is 'Admin and support actions, including view-as sessions.';
