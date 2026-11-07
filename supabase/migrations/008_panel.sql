-- 008: panel web — biblioteca de archivos, tipos de entregable y datos del post en cada flujo
create schema if not exists rush_chat;
set search_path to rush_chat, public, extensions;

-- Bucket público para guías, plantillas y activos digitales que el bot entrega por DM
insert into storage.buckets (id, name, public, file_size_limit)
values ('recursos', 'recursos', true, 52428800)  -- 50 MB (tope del plan Free)
on conflict (id) do nothing;

-- Tipo de entregable: guia (gratis), activo (archivo/plantilla), venta (producto o funnel)
alter table resources add column if not exists kind text not null default 'guia';
alter table resources drop constraint if exists resources_kind_check;
alter table resources add constraint resources_kind_check check (kind in ('guia','activo','venta'));
update resources set kind = 'venta' where slug like 'huatusco%';

-- Datos del post ligado, para mostrarlo en el panel sin volver a preguntar a Instagram
alter table keywords add column if not exists media_permalink text;
alter table keywords add column if not exists media_caption text;
alter table keywords add column if not exists media_thumb text;
alter table keywords add column if not exists created_by text;

notify pgrst, 'reload schema';
