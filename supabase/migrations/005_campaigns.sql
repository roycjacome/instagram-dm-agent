-- Todo RUSH Chat vive en el esquema rush_chat para no tocar las tablas de Expresos.
create schema if not exists rush_chat;
set search_path to rush_chat, public, extensions;

-- Campañas: DM con texto exacto y "un solo DM por persona".
alter table resources add column if not exists dm_text text;
alter table resources add column if not exists once_per_contact boolean not null default false;

-- Evita entregar dos veces la misma campaña aunque lleguen dos comentarios casi al mismo tiempo.
create or replace function rush_chat.deliveries_once_guard() returns trigger language plpgsql set search_path = rush_chat as $$
begin
  if exists (select 1 from resources r where r.id = new.resource_id and r.once_per_contact)
     and exists (select 1 from deliveries d where d.contact_id = new.contact_id and d.resource_id = new.resource_id) then
    raise exception 'already_delivered' using errcode = 'unique_violation';
  end if;
  return new;
end $$;
drop trigger if exists deliveries_once on deliveries;
create trigger deliveries_once before insert on deliveries
  for each row execute function rush_chat.deliveries_once_guard();

-- Campaña Huatusco 88 pts (reel del microlote Finca Zacatlami)
insert into resources (slug, title, description, url, requires_email, requires_follow, once_per_contact, dm_text)
values (
  'huatusco-88',
  'Huatusco 88 pts · Ficha y recetas',
  'Ficha técnica + recetas para prepararlo en casa',
  'https://cdn.shopify.com/s/files/1/0504/6550/5439/files/RUSH-GUD-CAF-004-Ficha_y_Recetas_Huatusco-v1.0.pdf',
  false, false, true,
  E'¡Gracias por comentar! ☕ Aquí tienes lo prometido:\n\n' ||
  E'📄 Ficha técnica + mis recetas para prepararlo en casa:\n' ||
  E'https://cdn.shopify.com/s/files/1/0504/6550/5439/files/RUSH-GUD-CAF-004-Ficha_y_Recetas_Huatusco-v1.0.pdf\n\n' ||
  E'🛒 Llévatelo antes de que se acabe (microlote, pocas bolsas):\n' ||
  E'https://rushcafe.net/products/huatusco-finca-zacatlami-tueste-medio\n\n' ||
  E'También lo encuentras en nuestras barras Rush. ¿En qué método lo vas a preparar?'
)
on conflict (slug) do update set
  title = excluded.title, description = excluded.description, url = excluded.url,
  requires_email = excluded.requires_email, requires_follow = excluded.requires_follow,
  once_per_contact = excluded.once_per_contact, dm_text = excluded.dm_text, active = true;

-- Palabra clave en comentarios. Para limitarla al reel, ligarla con el MCP:
--   ligar_palabra(palabra: "huatusco", recurso: "huatusco-88", post: "<link del reel>")
-- y pausar esta versión general.
insert into keywords (keyword, resource_id, channel, public_replies)
select 'huatusco', r.id, 'comment',
       array['¡Te mandamos todo por DM! 📩', '¡Listo! Revisa tus mensajes ☕', '¡Va por DM! Que lo disfrutes 🙌']
from resources r where r.slug = 'huatusco-88'
on conflict do nothing;
