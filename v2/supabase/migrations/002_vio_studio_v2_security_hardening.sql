-- Vio Studio v2.0 security hardening migration.
-- Apply only after reviewing against the live Supabase schema.
-- Admin cross-user inspection/mutation must go through the audited Edge Function,
-- never through broad client-side RLS exceptions.

-- There is one root Admin account (paipai77). Prevent concurrent bootstrap
-- requests from creating multiple Admin identities.
create unique index if not exists vio_single_admin_uq
  on public.vio_app_users ((role)) where role = 'admin';

create or replace function public.vio_bootstrap_admin(p_auth_uid uuid, p_username text)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_user public.vio_app_users;
begin
  perform pg_advisory_xact_lock(hashtext('vio_bootstrap_admin'));
  if lower(p_username) <> 'paipai77' then raise exception 'BOOTSTRAP_USERNAME_MISMATCH'; end if;
  if exists(select 1 from public.vio_app_users where role='admin') then raise exception 'ADMIN_ALREADY_EXISTS'; end if;
  insert into public.vio_app_users(username,role,display_name)
    values('paipai77','admin','Vio Studio Admin') returning * into v_user;
  insert into public.vio_user_devices(auth_user_id,app_user_id) values(p_auth_uid,v_user.id);
  insert into public.vio_profiles(user_id) values(v_user.id);
  insert into public.vio_audit_logs(actor_user_id,target_user_id,action,details)
    values(v_user.id,v_user.id,'bootstrap_admin','{"method":"one_time_bootstrap"}'::jsonb);
  return jsonb_build_object('id',v_user.id,'username',v_user.username,'role',v_user.role,'display_name',v_user.display_name);
end;
$$;

-- Admin cross-account reads are served by the Edge Function (service role),
-- which records audit events. Direct client reads are limited to own identity.
drop policy if exists vio_users_read_self_or_admin on public.vio_app_users;
create policy vio_users_read_self on public.vio_app_users
  for select to authenticated using (id = public.vio_current_app_user_id());

drop policy if exists vio_devices_read_self_or_admin on public.vio_user_devices;
create policy vio_devices_read_self on public.vio_user_devices
  for select to authenticated using (auth_user_id = auth.uid());

drop policy if exists vio_profiles_read_self_or_admin on public.vio_profiles;
create policy vio_profiles_read_self on public.vio_profiles
  for select to authenticated using (user_id = public.vio_current_app_user_id());

drop policy if exists vio_profiles_update_self_or_admin on public.vio_profiles;
create policy vio_profiles_update_self on public.vio_profiles
  for update to authenticated
  using (user_id = public.vio_current_app_user_id())
  with check (user_id = public.vio_current_app_user_id());

drop policy if exists vio_characters_write_self_or_admin on public.vio_characters;
create policy vio_characters_write_self on public.vio_characters
  for all to authenticated
  using (user_id = public.vio_current_app_user_id())
  with check (user_id = public.vio_current_app_user_id());

drop policy if exists vio_assets_write_self_or_admin on public.vio_character_assets;
create policy vio_assets_write_self on public.vio_character_assets
  for all to authenticated
  using (user_id = public.vio_current_app_user_id())
  with check (user_id = public.vio_current_app_user_id());

drop policy if exists vio_rooms_read_members_or_admin on public.vio_rooms;
create policy vio_rooms_read_active_members on public.vio_rooms
  for select to authenticated using (public.vio_is_room_member(id));

drop policy if exists vio_room_members_read_members_or_admin on public.vio_room_members;
create policy vio_room_members_read_active_members on public.vio_room_members
  for select to authenticated using (public.vio_is_room_member(room_id));

drop policy if exists vio_overrides_read_self_or_admin on public.vio_room_overrides;
create policy vio_overrides_read_self on public.vio_room_overrides
  for select to authenticated
  using (user_id = public.vio_current_app_user_id() and public.vio_is_room_member(room_id));

-- Admin asset inspection/deletion goes through signed URLs and audited Edge
-- Function actions. Direct Storage access remains scoped to the owner.
drop policy if exists vio_storage_read_self_or_admin on storage.objects;
create policy vio_storage_read_self on storage.objects
  for select to authenticated
  using (bucket_id='vio-studio-assets' and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text);

drop policy if exists vio_storage_delete_self_or_admin on storage.objects;
create policy vio_storage_delete_self on storage.objects
  for delete to authenticated
  using (bucket_id='vio-studio-assets' and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text);

-- Realtime authorization must check the room itself is still active and
-- unexpired for both regular members and OBS overlay devices.
drop policy if exists vio_room_realtime_read on realtime.messages;
create policy vio_room_realtime_read on realtime.messages
  for select to authenticated
  using (
    extension in ('broadcast','presence')
    and topic like 'room:%'
    and (
      exists (
        select 1
        from public.vio_room_members m
        join public.vio_user_devices d on d.app_user_id=m.user_id
        join public.vio_app_users u on u.id=m.user_id and u.is_active
        join public.vio_rooms r on r.id=m.room_id and r.status='active' and r.expires_at > now()
        where d.auth_user_id=auth.uid() and topic=('room:' || m.room_id::text)
      )
      or exists (
        select 1
        from public.vio_overlay_devices od
        join public.vio_rooms r on r.id=od.room_id and r.status='active' and r.expires_at > now()
        where od.auth_user_id=auth.uid() and topic=('room:' || od.room_id::text)
      )
    )
  );

drop policy if exists vio_room_realtime_write on realtime.messages;
create policy vio_room_realtime_write on realtime.messages
  for insert to authenticated
  with check (
    extension in ('broadcast','presence')
    and topic like 'room:%'
    and exists (
      select 1
      from public.vio_room_members m
      join public.vio_user_devices d on d.app_user_id=m.user_id
      join public.vio_app_users u on u.id=m.user_id and u.is_active
      join public.vio_rooms r on r.id=m.room_id and r.status='active' and r.expires_at > now()
      where d.auth_user_id=auth.uid() and topic=('room:' || m.room_id::text)
    )
  );

-- A disabled account must not retain an active support-view token.
create index if not exists vio_support_sessions_active_target_idx
  on public.vio_support_sessions(target_user_id, expires_at)
  where ended_at is null;

