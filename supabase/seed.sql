-- Correr con search_path rush_chat (lo pone el script de deploy).
set search_path to rush_chat, public;
-- Recursos de arranque. Cambia las URL por los links reales (Drive/PDF/landing).
-- Correr después de las migraciones.
insert into resources (slug, title, description, url, requires_email, requires_follow) values
  ('prompts-cafeteria', 'Guía de Prompts para Cafeterías',
   '30 prompts para tu menú, redes y operación', 'https://rushcafe.net/recursos/prompts-cafeteria', true, false),
  ('vender-mas', '10 Tácticas para Vender Más',
   'Ticket promedio, upselling y combos que sí funcionan', 'https://rushcafe.net/recursos/vender-mas', true, false),
  ('costeo-bebidas', 'Plantilla de Costeo de Bebidas',
   'Calcula el costo real de cada bebida', 'https://rushcafe.net/recursos/costeo-bebidas', true, true)
on conflict (slug) do nothing;

insert into keywords (keyword, resource_id, channel, public_replies)
select k.keyword, r.id, 'any', k.replies
from (values
  ('prompts', 'prompts-cafeteria', array['¡Listo! Te mandé la guía por DM ☕', '¡Va por DM! Revisa tus mensajes 📩', 'Te escribimos por DM, que la disfrutes 🙌']),
  ('vender',  'vender-mas',        array['¡Te la mandé por DM! ☕', 'Checa tus mensajes, ya te llegó 📩', '¡Hecho! Va por DM 🙌']),
  ('costeo',  'costeo-bebidas',    array['¡Va por DM! ☕', 'Te escribimos por mensaje 📩', 'Revisa tu DM 🙌'])
) as k(keyword, slug, replies)
join resources r on r.slug = k.slug
on conflict do nothing;
