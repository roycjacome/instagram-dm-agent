-- Tareas programadas. Correr UNA vez en el SQL Editor de Supabase,
-- reemplazando <project-ref> y <CRON_SECRET> (el mismo de los secrets).
-- Requiere las extensiones pg_cron y pg_net (Database → Extensions).

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Publicaciones programadas y videos en proceso: cada minuto
select cron.schedule('rush-ig-publish', '* * * * *', $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/rush-api/cron/publish',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);

-- Seguimiento "¿te sirvió?" del bot de DMs: cada 15 minutos
select cron.schedule('rush-dm-followups', '*/15 * * * *', $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/ig-webhook/cron/followups',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);

-- Para quitarlas:
--   select cron.unschedule('rush-ig-publish');
--   select cron.unschedule('rush-dm-followups');

-- Renovación del token de Instagram: lunes 9:17 UTC
select cron.schedule('rush-ig-token-refresh', '17 9 * * 1', $$
  select net.http_post(
    url     := 'https://<project-ref>.supabase.co/functions/v1/ig-webhook/cron/refresh-token',
    headers := '{"Content-Type": "application/json", "x-cron-secret": "<CRON_SECRET>"}'::jsonb,
    body    := '{}'::jsonb
  );
$$);
