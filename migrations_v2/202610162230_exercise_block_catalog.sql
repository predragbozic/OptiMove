alter table library.exercise_collections
  add column description text not null default '',
  add column cover_image_url text not null default '',
  add column access_all boolean not null default false,
  add column block_preview varchar(10) not null default 'hidden' check (block_preview in ('hidden','locked')),
  add column exercise_preview varchar(10) not null default 'hidden' check (exercise_preview in ('hidden','locked'));

alter table library.exercise_collections
  add constraint exercise_block_description_length check (length(description) <= 2000),
  add constraint exercise_block_cover_url check (cover_image_url = '' or (length(cover_image_url) <= 2048 and cover_image_url ~* '^https?://'));
