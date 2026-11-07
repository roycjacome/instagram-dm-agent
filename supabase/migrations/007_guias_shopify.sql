-- 007: guías publicadas en Shopify + espacio para el token renovable
create schema if not exists rush_chat;
set search_path to rush_chat, public, extensions;

update resources set
  title = 'Guía: 30 Prompts para Cafeterías',
  description = 'Prompts listos para tu menú, redes, clientes y operación',
  url = 'https://cdn.shopify.com/s/files/1/0504/6550/5439/files/RUSH-GUD-MKT-005-Prompts_para_Cafeterias-v1.0.pdf'
where slug = 'prompts-cafeteria';

update resources set
  title = 'Guía: 10 Tácticas para Vender Más',
  description = 'Ticket promedio, upselling y combos que sí funcionan',
  url = 'https://cdn.shopify.com/s/files/1/0504/6550/5439/files/RUSH-GUD-MKT-006-Tacticas_para_Vender_Mas-v1.0.pdf'
where slug = 'vender-mas';

update resources set
  title = 'Guía + Plantilla: Costea tus Bebidas',
  description = 'Calcula el costo real y el precio de cada bebida (incluye Excel)',
  url = 'https://cdn.shopify.com/s/files/1/0504/6550/5439/files/RUSH-GUD-FIN-007-Costeo_de_Bebidas-v1.0.pdf'
where slug = 'costeo-bebidas';

-- El token de Instagram renovado se guarda en settings('ig_token'); solo service_role lo lee (RLS sin políticas).
select slug, url from resources where slug in ('prompts-cafeteria','vender-mas','costeo-bebidas');
