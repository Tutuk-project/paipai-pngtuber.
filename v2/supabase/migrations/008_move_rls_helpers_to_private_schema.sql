-- Keep SECURITY DEFINER RLS helpers outside Supabase's exposed API schemas.
-- RLS policies retain their function dependencies when ALTER FUNCTION SET SCHEMA
-- moves the existing function objects.
create schema if not exists vio_private;
revoke all on schema vio_private from public, anon;
grant usage on schema vio_private to authenticated, service_role;

alter function public.vio_current_app_user_id() set schema vio_private;
alter function public.vio_is_admin() set schema vio_private;
alter function public.vio_is_room_member(uuid) set schema vio_private;

revoke all on function vio_private.vio_current_app_user_id() from public, anon;
revoke all on function vio_private.vio_is_admin() from public, anon;
revoke all on function vio_private.vio_is_room_member(uuid) from public, anon;

grant execute on function vio_private.vio_current_app_user_id() to authenticated, service_role;
grant execute on function vio_private.vio_is_admin() to authenticated, service_role;
grant execute on function vio_private.vio_is_room_member(uuid) to authenticated, service_role;
