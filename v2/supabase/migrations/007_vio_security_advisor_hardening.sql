-- Tighten execution grants for policy helper SECURITY DEFINER functions.
-- These helpers are required by authenticated RLS policies, but must not be
-- callable by the unauthenticated anon database role.
revoke all on function public.vio_current_app_user_id() from public, anon;
revoke all on function public.vio_is_admin() from public, anon;
revoke all on function public.vio_is_room_member(uuid) from public, anon;

grant execute on function public.vio_current_app_user_id() to authenticated, service_role;
grant execute on function public.vio_is_admin() to authenticated, service_role;
grant execute on function public.vio_is_room_member(uuid) to authenticated, service_role;

-- The hash helper is immutable and uses only pg_catalog built-ins.
-- Pin its search_path so callers cannot influence name resolution.
create or replace function public.vio_storage_cleanup_lock_key(p_bucket_id text, p_storage_path text)
returns bigint
language sql
immutable
strict
set search_path = pg_catalog
as $$
  select hashtextextended(p_bucket_id || ':' || p_storage_path, 0);
$$;

revoke all on function public.vio_storage_cleanup_lock_key(text, text) from public, anon, authenticated;
grant execute on function public.vio_storage_cleanup_lock_key(text, text) to service_role;
