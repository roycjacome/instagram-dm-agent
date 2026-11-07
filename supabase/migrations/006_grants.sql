-- Todo RUSH Chat vive en el esquema rush_chat para no tocar las tablas de Expresos.
create schema if not exists rush_chat;
set search_path to rush_chat, public, extensions;

-- Solo el service role (las edge functions) entra a este esquema. anon/authenticated no.
grant usage on schema rush_chat to service_role;
grant all on all tables in schema rush_chat to service_role;
grant all on all sequences in schema rush_chat to service_role;
grant all on all functions in schema rush_chat to service_role;
alter default privileges in schema rush_chat grant all on tables to service_role;
alter default privileges in schema rush_chat grant all on sequences to service_role;
alter default privileges in schema rush_chat grant all on functions to service_role;
revoke all on schema rush_chat from anon, authenticated;

-- PostgREST: agregar rush_chat a "Exposed schemas" (Dashboard → Settings → API) y recargar.
notify pgrst, 'reload schema';
