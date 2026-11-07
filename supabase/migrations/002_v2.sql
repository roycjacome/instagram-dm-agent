-- Todo RUSH Chat vive en el esquema rush_chat para no tocar las tablas de Expresos.
create schema if not exists rush_chat;
set search_path to rush_chat, public, extensions;

-- RUSH DM Bot v2: botones, historias, ice breakers, gate de seguidor,
-- variaciones de respuesta pública y seguimiento a las ~23 h.

-- Recursos: imagen para la tarjeta y opción de pedir que te sigan
alter table resources add column if not exists image_url text;
alter table resources add column if not exists requires_follow boolean not null default false;

-- Palabras clave: varias respuestas públicas que rotan (anti-spam) y canal 'story'
alter table keywords add column if not exists public_replies text[] not null default '{}';
update keywords set public_replies = array[public_reply]
  where public_reply is not null and cardinality(public_replies) = 0;

alter table keywords drop constraint if exists keywords_channel_check;
alter table keywords add constraint keywords_channel_check
  check (channel in ('any','comment','dm','story'));

-- Contactos: nuevo estado esperando que nos siga
alter table contacts drop constraint if exists contacts_state_check;
alter table contacts add constraint contacts_state_check
  check (state in ('idle','awaiting_email','awaiting_follow','handoff'));

-- Entregas: control del seguimiento y la respuesta
alter table deliveries add column if not exists followup_sent_at timestamptz;
alter table deliveries add column if not exists feedback text;   -- 'util' | 'otra' | 'duda'

create index if not exists deliveries_followup_idx
  on deliveries (created_at) where followup_sent_at is null;

-- Configuración editable (bienvenida, historias, ice breakers)
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
alter table settings enable row level security;

insert into settings (key, value) values
  ('welcome', jsonb_build_object(
     'text', '¡Hola! Soy el asistente de RUSH ☕ Tenemos recursos gratis para cafeterías. Toca el que quieras:')),
  ('story_mention', jsonb_build_object(
     'mode', 'menu',           -- 'menu' | 'resource' | 'off'
     'resource_slug', null,
     'text', '¡Gracias por mencionarnos! 🙌 Como agradecimiento, llévate un recurso gratis para tu cafetería:')),
  ('ice_breakers', '[]'::jsonb)
on conflict (key) do nothing;

-- Vista leads con aperturas y feedback
drop view if exists leads;
create view leads as
select c.username, c.email, c.newsletter_optin, c.optin_at, c.tags,
       count(d.id) as recursos_recibidos,
       count(d.clicked_at) as recursos_abiertos,
       count(*) filter (where d.feedback = 'util') as dijeron_util,
       max(d.created_at) as ultima_entrega
from contacts c
left join deliveries d on d.contact_id = c.id
group by c.id
order by ultima_entrega desc nulls last;
