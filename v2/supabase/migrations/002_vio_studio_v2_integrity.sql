-- Vio Studio v2.0 Realtime authorization hardening.
-- Migrations 003-005 provide accessories, background media and cleanup queue.
-- This migration closes a gap in 001: Realtime access must also require an
-- active, unexpired room for both members and OBS overlay devices.

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
