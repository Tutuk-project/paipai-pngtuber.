-- Private image/GIF/video backgrounds, separate from character expression assets.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'vio-backgrounds',
  'vio-backgrounds',
  false,
  52428800,
  array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm']
)
on conflict(id) do update
set file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    public = false;

drop policy if exists vio_backgrounds_read_self on storage.objects;
create policy vio_backgrounds_read_self on storage.objects
for select to authenticated
using (
  bucket_id = 'vio-backgrounds'
  and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text
);

drop policy if exists vio_backgrounds_insert_self on storage.objects;
create policy vio_backgrounds_insert_self on storage.objects
for insert to authenticated
with check (
  bucket_id = 'vio-backgrounds'
  and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text
);

drop policy if exists vio_backgrounds_update_self on storage.objects;
create policy vio_backgrounds_update_self on storage.objects
for update to authenticated
using (
  bucket_id = 'vio-backgrounds'
  and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text
)
with check (
  bucket_id = 'vio-backgrounds'
  and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text
);

drop policy if exists vio_backgrounds_delete_self on storage.objects;
create policy vio_backgrounds_delete_self on storage.objects
for delete to authenticated
using (
  bucket_id = 'vio-backgrounds'
  and (storage.foldername(name))[1] = public.vio_current_app_user_id()::text
);
