-- Vio Studio v2.0 character accessory assets.
-- Accessories are separate from the four expression images so they can be
-- positioned, resized, mirrored and independently enabled per character.

create table if not exists public.vio_character_accessories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.vio_app_users(id) on delete cascade,
  character_id uuid not null references public.vio_characters(id) on delete cascade,
  name text not null check (length(name) between 1 and 120),
  bucket_id text not null default 'vio-studio-assets',
  storage_path text not null unique,
  mime_type text not null check (mime_type in ('image/png','image/webp')),
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 8388608),
  x double precision not null default 0.5 check (x between 0 and 1),
  y double precision not null default 0.5 check (y between 0 and 1),
  w double precision not null default 0.18 check (w > 0 and w <= 2),
  h double precision not null default 0.18 check (h > 0 and h <= 2),
  mirror boolean not null default false,
  follow_avatar boolean not null default true,
  effects_enabled boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists vio_character_accessories_user_character_idx
  on public.vio_character_accessories(user_id, character_id, sort_order);

alter table public.vio_character_accessories enable row level security;
drop policy if exists vio_accessories_read_self on public.vio_character_accessories;
create policy vio_accessories_read_self on public.vio_character_accessories
  for select to authenticated using (user_id = public.vio_current_app_user_id());
drop policy if exists vio_accessories_write_self on public.vio_character_accessories;
create policy vio_accessories_write_self on public.vio_character_accessories
  for all to authenticated
  using (user_id = public.vio_current_app_user_id())
  with check (user_id = public.vio_current_app_user_id());

comment on table public.vio_character_accessories is 'Per-character transparent PNG/WebP accessories with persisted position and follow settings.';
