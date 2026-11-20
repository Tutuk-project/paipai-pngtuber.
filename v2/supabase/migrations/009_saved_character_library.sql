-- Vio Studio v2.0 saved character library.
-- Existing characters are preserved and normalized to ordered Avatar N labels.
alter table public.vio_characters
  add column if not exists is_saved boolean not null default true;

with ranked as (
  select id, row_number() over (partition by user_id order by created_at, id) as avatar_no
  from public.vio_characters
)
update public.vio_characters c
set name = 'Avatar ' || ranked.avatar_no,
    is_saved = true,
    updated_at = now()
from ranked
where ranked.id = c.id
  and (c.name = 'Default' or c.name is null or c.name = '');

create index if not exists vio_characters_saved_user_idx
  on public.vio_characters(user_id, is_saved, created_at);

comment on column public.vio_characters.is_saved is
  'True when the creator has saved this character into their Avatar library; false for the current unsaved draft.';
