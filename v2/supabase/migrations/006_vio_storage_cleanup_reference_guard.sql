-- Serialize cleanup scheduling and metadata re-references for the same Storage object.
-- A pending queue row reserves the object until deletion/skip is finalized.
-- The advisory transaction lock makes queue creation and new-reference checks
-- observe a single order; the pending row then blocks references while the
-- external Storage API call is in progress.

create or replace function public.vio_storage_cleanup_lock_key(p_bucket_id text, p_storage_path text)
returns bigint
language sql
immutable
strict
as $$
  select hashtextextended(p_bucket_id || ':' || p_storage_path, 0);
$$;

create or replace function public.vio_lock_storage_cleanup_queue_key()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform pg_advisory_xact_lock(
    public.vio_storage_cleanup_lock_key(new.bucket_id, new.storage_path)
  );
  return new;
end;
$$;

drop trigger if exists vio_storage_cleanup_queue_key_lock on public.vio_storage_cleanup_queue;
create trigger vio_storage_cleanup_queue_key_lock
before insert or update of bucket_id, storage_path
on public.vio_storage_cleanup_queue
for each row execute function public.vio_lock_storage_cleanup_queue_key();

create or replace function public.vio_guard_storage_reference_during_cleanup()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  new_bucket text;
  new_path text;
  old_bucket text;
  old_path text;
begin
  if tg_table_name = 'vio_profiles' then
    new_bucket := new.preferences #>> '{background,bucket_id}';
    new_path := new.preferences #>> '{background,storage_path}';
    if tg_op = 'UPDATE' then
      old_bucket := old.preferences #>> '{background,bucket_id}';
      old_path := old.preferences #>> '{background,storage_path}';
    end if;
  else
    new_bucket := new.bucket_id;
    new_path := new.storage_path;
    if tg_op = 'UPDATE' then
      old_bucket := old.bucket_id;
      old_path := old.storage_path;
    end if;
  end if;

  if new_bucket is null or new_path is null then
    return new;
  end if;

  -- Editing unrelated metadata while retaining the same object is not a
  -- re-reference. Existing references are handled by the cleanup worker.
  if tg_op = 'UPDATE'
     and new_bucket = old_bucket
     and new_path = old_path then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    public.vio_storage_cleanup_lock_key(new_bucket, new_path)
  );

  if exists (
    select 1
    from public.vio_storage_cleanup_queue q
    where q.bucket_id = new_bucket
      and q.storage_path = new_path
      and q.processed_at is null
  ) then
    raise exception 'Storage object is reserved for cleanup: %/%', new_bucket, new_path
      using errcode = '55000';
  end if;

  return new;
end;
$$;

drop trigger if exists vio_character_assets_cleanup_reference_guard on public.vio_character_assets;
create trigger vio_character_assets_cleanup_reference_guard
before insert or update of bucket_id, storage_path
on public.vio_character_assets
for each row execute function public.vio_guard_storage_reference_during_cleanup();

drop trigger if exists vio_character_accessories_cleanup_reference_guard on public.vio_character_accessories;
create trigger vio_character_accessories_cleanup_reference_guard
before insert or update of bucket_id, storage_path
on public.vio_character_accessories
for each row execute function public.vio_guard_storage_reference_during_cleanup();

drop trigger if exists vio_profiles_background_cleanup_reference_guard on public.vio_profiles;
create trigger vio_profiles_background_cleanup_reference_guard
before insert or update of preferences
on public.vio_profiles
for each row execute function public.vio_guard_storage_reference_during_cleanup();

revoke all on function public.vio_storage_cleanup_lock_key(text, text) from public, anon, authenticated;
revoke all on function public.vio_lock_storage_cleanup_queue_key() from public, anon, authenticated;
revoke all on function public.vio_guard_storage_reference_during_cleanup() from public, anon, authenticated;

comment on function public.vio_guard_storage_reference_during_cleanup() is
  'Prevents a new metadata reference to a Storage object while a durable cleanup job is pending.';
