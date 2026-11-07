-- Todo RUSH Chat vive en el esquema rush_chat para no tocar las tablas de Expresos.
create schema if not exists rush_chat;
set search_path to rush_chat, public, extensions;

-- RUSH DM Bot — esquema base
-- Contactos de Instagram, recursos gratuitos, palabras clave y bitácora de eventos.


-- Recursos gratuitos (guías, prompts, plantillas)
create table if not exists resources (
  id           uuid primary key default gen_random_uuid(),
  slug         text unique not null,             -- usado en links de tracking: /r/{slug}
  title        text not null,                    -- "Guía de Prompts para Cafeterías"
  description  text,                             -- 1 línea que se manda en el DM
  url          text not null,                    -- link real (Drive, Notion, PDF, landing)
  requires_email boolean not null default true,  -- true = pide correo antes de entregar
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);

-- Palabras clave que disparan un recurso (en comentario o DM)
create table if not exists keywords (
  id           uuid primary key default gen_random_uuid(),
  keyword      text not null,                    -- se compara normalizado (sin acentos, minúsculas)
  resource_id  uuid not null references resources(id) on delete cascade,
  channel      text not null default 'any' check (channel in ('any','comment','dm')),
  media_id     text,                             -- opcional: solo aplica en un post específico
  public_reply text,                             -- respuesta pública al comentario (opcional)
  active       boolean not null default true,
  created_at   timestamptz not null default now()
);
create unique index if not exists keywords_unique on keywords (lower(keyword), coalesce(media_id,''), channel);

-- Contactos (una fila por usuario de Instagram)
create table if not exists contacts (
  id              uuid primary key default gen_random_uuid(),
  igsid           text unique not null,          -- Instagram-scoped ID del usuario
  username        text,
  email           text,
  newsletter_optin boolean not null default false,
  optin_at        timestamptz,
  state           text not null default 'idle' check (state in ('idle','awaiting_email','handoff')),
  pending_resource_id uuid references resources(id),
  tags            text[] not null default '{}',
  last_inbound_at timestamptz,                   -- para respetar la ventana de 24 h
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Entregas de recursos (qué recibió quién)
create table if not exists deliveries (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references contacts(id) on delete cascade,
  resource_id  uuid not null references resources(id) on delete cascade,
  source       text not null,                    -- 'comment' | 'dm'
  clicked_at   timestamptz,
  created_at   timestamptz not null default now()
);

-- Bitácora de eventos crudos + deduplicación (Meta reintenta webhooks)
create table if not exists events (
  id           text primary key,                 -- comment_id o message mid
  kind         text not null,                    -- 'comment' | 'message'
  payload      jsonb not null,
  created_at   timestamptz not null default now()
);

create or replace function rush_chat.touch_updated_at() returns trigger language plpgsql set search_path = rush_chat as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists contacts_touch on contacts;
create trigger contacts_touch before update on contacts
  for each row execute function rush_chat.touch_updated_at();

-- RLS encendido: solo el service role (la edge function) lee/escribe.
alter table resources  enable row level security;
alter table keywords   enable row level security;
alter table contacts   enable row level security;
alter table deliveries enable row level security;
alter table events     enable row level security;

-- Vista rápida para ver leads en el Table Editor
create or replace view leads as
select c.username, c.email, c.newsletter_optin, c.optin_at, c.tags,
       count(d.id) as recursos_recibidos,
       count(d.clicked_at) as recursos_abiertos,
       max(d.created_at) as ultima_entrega
from contacts c
left join deliveries d on d.contact_id = c.id
group by c.id
order by ultima_entrega desc nulls last;
