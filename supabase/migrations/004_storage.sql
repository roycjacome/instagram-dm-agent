-- Todo RUSH Chat vive en el esquema rush_chat para no tocar las tablas de Expresos.
create schema if not exists rush_chat;
set search_path to rush_chat, public, extensions;

-- Bucket público para las imágenes y videos que Instagram descarga al publicar.
-- (Instagram necesita una URL pública directa; los links de Drive no sirven tal cual.)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ig-media', 'ig-media', true, 104857600,  -- 100 MB (en plan Free el tope global es 50 MB)
        array['image/jpeg','video/mp4','video/quicktime'])
on conflict (id) do nothing;
