-- Add explicit draft/saved lifecycle for character library.
-- Existing characters remain saved; new drafts are created with is_saved=false.
alter table public.vio_characters
  add column if not exists is_saved boolean not null default true;

create index if not exists vio_characters_saved_user_idx
  on public.vio_characters(user_id, is_saved, created_at);
