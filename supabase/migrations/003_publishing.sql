-- Todo RUSH Chat vive en el esquema rush_chat para no tocar las tablas de Expresos.
create schema if not exists rush_chat;
set search_path to rush_chat, public, extensions;

-- RUSH DM Bot v3: publicación y programación de contenido en Instagram.

create table if not exists posts (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null check (kind in ('image','carousel','reel','story')),
  caption        text,
  media          jsonb not null,                   -- [{ "url": "...", "type": "image"|"video" }]
  cover_url      text,                             -- portada del reel (opcional)
  share_to_feed  boolean not null default true,    -- reels: también en el feed
  first_comment  text,                             -- comentario propio al publicar (hashtags, CTA)
  scheduled_at   timestamptz not null default now(),
  status         text not null default 'scheduled'
                 check (status in ('draft','scheduled','processing','publishing','published','failed','canceled')),
  container_id   text,
  children_ids   text[] not null default '{}',
  ig_media_id    text,
  permalink      text,
  error          text,
  attempts       int not null default 0,
  -- Automatización del bot ligada a esta publicación
  keyword        text,
  resource_slug  text,
  public_replies text[] not null default '{}',
  created_by     text not null default 'api',      -- 'claude' | 'grok' | nombre de la API key
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  published_at   timestamptz
);

create index if not exists posts_due_idx on posts (scheduled_at) where status = 'scheduled';
create index if not exists posts_processing_idx on posts (updated_at) where status = 'processing';

drop trigger if exists posts_touch on posts;
create trigger posts_touch before update on posts
  for each row execute function rush_chat.touch_updated_at();

alter table posts enable row level security;
