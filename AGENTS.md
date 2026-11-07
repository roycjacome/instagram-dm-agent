# RUSH Chat — guía para agentes (Hermes, Grokbot, Claude)

> Léelo completo antes de tocar el bot, crear flujos o publicar en Instagram.
> Estado verificado contra Supabase el **2026-11-05**. Ver §9 para lo que falta desplegar.

## 1. Qué es

RUSH Chat es el sistema propio de Rush para operar el Instagram **@rushislandcoffeeroasters**. Es la alternativa a ManyChat y Metricool para Instagram, y tiene dos partes:

1. **Bot de comentarios y DMs.** Alguien comenta o escribe una palabra clave → el bot responde en público y le manda por DM el entregable: una guía gratis, un activo digital o un producto/funnel de venta.
2. **Publicación.** Posts, carruseles, reels e historias, al momento o programados, con primer comentario y la palabra clave del bot ligada al post.

Solo Instagram. Las demás redes quedan fuera por decisión de Roy.

- App de Meta: **RUSH Chat** (app id 1627510568861502; Instagram app "RUSH Chat-IG"), en modo Live.
- IG user id: `17841402245454563`.
- Corre completo en **Supabase**, proyecto `rush-chat`, ref `<project-ref>` (plan Free). No hay servidor propio.

## 2. Arquitectura

```
Instagram (comentarios, DMs, historias)
   │  webhook firmado (X-Hub-Signature-256)
   ▼
Edge Function ig-webhook ──► _shared/bot.ts (lógica pura) ──► Graph API graph.instagram.com v23
   │   /r/{slug}   redirect con tracking de aperturas
   │   /cron/followups      (pg_cron cada 15 min: "¿te sirvió?")
   │   /cron/refresh-token  (pg_cron lunes 09:17 UTC: renueva token IG)
   ▼
Postgres schema rush_chat  ◄── Edge Function rush-mcp  (MCP para Claude / Hermes)
   ▲                       ◄── Edge Function rush-api  (REST + OpenAPI para Grokbot / n8n)
   │                              /cron/publish (pg_cron cada minuto: cola de publicación)
Storage: bucket ig-media (medios para publicar) · bucket recursos (biblioteca pública de guías)
Archivos de guías actuales: CDN de Shopify (rushcafe.net)
```

- Las tres funciones son Deno/TypeScript con `--no-verify-jwt`; cada una trae su propia seguridad (§6).
- Todo vive en el schema **`rush_chat`**. Nunca uses `public`: el mismo Supabase podría alojar otras apps.
- La lógica está separada de la infraestructura:
  - `_shared/logic.ts`, `bot.ts`, `publish_logic.ts`, `publisher.ts` son puras y tienen tests.
  - `*_supabase.ts` e `ig_token.ts` hablan con Supabase y Meta.

## 3. Código (`codigo/rush-chat`)

| Ruta | Qué hace |
|---|---|
| `supabase/functions/ig-webhook/index.ts` | Verificación de Meta, eventos de comentarios/DM/postbacks, redirect `/r/`, crons de seguimiento y token |
| `supabase/functions/rush-mcp/index.ts` | Servidor MCP (JSON-RPC sin estado, secreto en la URL) con todas las herramientas de §5 |
| `supabase/functions/rush-api/index.ts` | REST de publicación + `openapi.json` + cron `/cron/publish` |
| `_shared/logic.ts` | `normalize` (minúsculas, sin acentos, sin emojis), `matchKeyword`, payloads de botones, textos, links con tracking, firma |
| `_shared/bot.ts` | Máquina de estados del contacto: oferta → pide seguir → pide correo → entrega → seguimiento; campañas `dm_text` y `once_per_contact` |
| `_shared/publish_logic.ts` | Validación de publicaciones (reglas de Instagram, §7) y parseo de fechas en hora Rush (UTC-6) |
| `_shared/publisher.ts` | Cola: crea contenedores, espera `status_code`, publica, pone primer comentario y liga la palabra clave al `media_id` |
| `_shared/publishing_env.ts` | Arma el publicador desde variables de entorno y define las herramientas MCP de publicación |
| `_shared/ig_token.ts` | Token IG: lee `settings.ig_token` (caché 5 min) o el secret; `refresh()` lo renueva con `ig_refresh_token` |
| `supabase/migrations/001…008` | Esquema (§4). **En producción solo corren las nuevas**: `001` falla si se re-ejecuta |
| `supabase/cron.sql` | Plantilla de los 3 jobs de pg_cron (`<project-ref>` y `<CRON_SECRET>` se sustituyen al desplegar) |
| `tests/*.test.ts` | `node --experimental-strip-types tests/X.test.ts` (no admite parameter properties de TS) |
| `deploy.sh` | Instalación desde cero. **No usar en producción** |
| `update.sh <REF>` | Actualización: migraciones 007+, secrets, deploy de funciones, crons, primera renovación del token y URL del MCP al portapapeles |
| `fix_ig_token.sh <REF>` | Reemplaza a mano el token IG desde el portapapeles |

Panel web (no está en el repo): artifact privado de claude.ai, **Panel RUSH Chat**. Habla con el MCP a través del conector "RUSH Chat" de la cuenta de Roy.

## 4. Modelo de datos (`rush_chat`)

| Tabla | Para qué |
|---|---|
| `resources` | Entregables. `slug`, `title`, `description`, `url`, `image_url`, `requires_email`, `requires_follow`, `dm_text`, `once_per_contact`, `kind` (`guia`/`activo`/`venta`, mig. 008), `active` |
| `keywords` | Disparadores. `keyword` normalizada, `resource_id`, `channel` (`any`/`comment`/`dm`/`story`), `media_id` (null = cualquier post), `public_replies[]`, `active`; mig. 008 agrega `media_permalink`, `media_caption`, `media_thumb` |
| `contacts` | Una fila por usuario de IG: estado de la conversación, correo, newsletter, `human_takeover`, baja |
| `deliveries` | Qué se entregó a quién, `source`, `clicked_at`, `feedback`. Un trigger bloquea duplicados en recursos `once_per_contact` |
| `events` | Bitácora cruda de webhooks (para depurar) |
| `settings` | Clave/valor: `welcome`, `ice_breakers`, `paused`, `ig_token` (**secreto**: nunca lo imprimas ni lo devuelvas) |
| `posts` | Cola de publicación: `kind`, `media[]`, `caption`, `scheduled_at`, `status` (draft/scheduled/processing/publishing/published/failed/canceled), `keyword`, `resource_slug`, `first_comment` |
| vista `leads` | Contactos con correo y recursos recibidos |

Matching: el texto entrante se normaliza y se busca la palabra. Si hay una regla con `media_id` del post, gana sobre la general.

### Flujos activos al 2026-11-05 (33 palabras)

- **huatusco** (comentario, cualquier post) → `huatusco-88`. Campaña de venta: DM con texto exacto, una vez por persona. **No cambiar el texto sin Roy.**
- **prompts / vender / costeo** (any) → guías en CDN de Shopify:
  - RUSH-GUD-MKT-005 Prompts para Cafeterías
  - RUSH-GUD-MKT-006 Tácticas para Vender Más
  - RUSH-GUD-FIN-007 Costeo de Bebidas + plantilla XLSX
- **Curso de Cosecha Coatepec** (5 recursos `cosecha-*`):
  - `cosecha-info`: palabras como info, precio, quiero, yo… en un post específico; cosecha, coatepec y viaje en cualquier lado.
  - `cosecha-fechas`, `cosecha-pagos`, `cosecha-monedero`: por DM.

Antes de crear una palabra nueva, revisa con `ver_flujos` que no choque con éstas. Palabras genéricas ("info", "precio", "yo") **solo** ligadas a un post específico, nunca globales.

## 5. Cómo usarlo como agente

### 5.1 MCP — Claude y Hermes (control total)

- URL: `https://<project-ref>.supabase.co/functions/v1/rush-mcp/<MCP_SECRET>`.
- El secreto vive en `.secrets/generated.env` de la Mac rosa y en el conector "RUSH Chat" de claude.ai. **Nunca lo escribas en archivos del repo, tableros ni mensajes.**

| Herramienta | Uso |
|---|---|
| `ver_config` | Estado: pausa, bienvenida, ice breakers, vencimiento del token |
| `ver_flujos` | Todos los flujos con métricas y los programados con palabra clave |
| `crear_flujo` | Palabra + post (o cualquiera) + entregable existente o nuevo, en un paso |
| `flujo_estado` | Pausar o activar un flujo |
| `listar_recursos` / `crear_recurso` / `ligar_palabra` | Piezas sueltas del flujo |
| `subir_archivo` / `listar_archivos` / `crear_carpeta` | Biblioteca pública (`recursos`) y medios para publicar (`contenido`), hasta ~15 MB |
| `ig_posts_recientes` | Últimos posts con `media_id`, link y miniatura |
| `importar_medio` | Trae un video o imagen desde Drive o Dropbox al bucket |
| `publicar_contenido` | Publica o programa. Acepta `palabra_clave` + `recurso` |
| `calendario_contenido` / `gestionar_publicacion` / `limite_publicacion` | Agenda, publicar ya, reprogramar, cancelar, cupo de 24 h |
| `ver_leads` / `pendientes_humano` / `responder_dm` / `enviar_recurso` / `regresar_al_bot` | Leads y atención humana |
| `configurar_mensajes` / `configurar_ice_breakers` / `pausar` | Textos del bot e interruptor general |

`subir_archivo`, `crear_carpeta`, `crear_flujo`, `ver_flujos`, `flujo_estado` y las miniaturas llegan con `update.sh` (§9).

### 5.2 REST — Grokbot, n8n y bots externos (solo publicación)

- Base: `https://<project-ref>.supabase.co/functions/v1/rush-api`.
- Spec OpenAPI en `GET /openapi.json`, sin auth.
- Auth: `Authorization: Bearer <key>`. Las keys van en el secret `PUBLISH_API_KEYS` (formato `cliente:key,cliente2:key2`). La de Grok es `grok:…` y está en `.secrets/generated.env`.

| Método y ruta | Qué hace |
|---|---|
| `GET /posts?status=&days=` | Lista la cola |
| `POST /posts` | Crea una publicación. Cuerpo: `{kind, media:[url], caption, scheduled_at, first_comment, keyword, resource_slug, public_replies, draft}` |
| `GET /posts/{id}` | Detalle |
| `PATCH /posts/{id}` | Reprogramar (`scheduled_at`) o cancelar (`status:"canceled"`) |
| `POST /posts/{id}/publish` | Publicar ya |
| `POST /media/import {url}` | Medio desde Drive o Dropbox → URL pública |
| `POST /media/upload` | Binario directo (`Content-Type` del archivo) |
| `GET /limits` | Cupo de publicaciones por API |
| `GET /instagram/posts` | Posts recientes |

La REST **no** crea flujos ni recursos. Si Grokbot necesita un flujo nuevo:

- con un post que aún no sale: `POST /posts` con `keyword` + `resource_slug` de un recurso **existente**;
- para todo lo demás: se pide a Claude o Hermes por MCP.

## 6. Reglas que no se rompen

1. **Publicar es irreversible.** Un agente arma la publicación y Roy confirma antes de `publish` o de una fecha cercana. Por defecto crea como `draft: true`.
2. **Campañas con texto exacto** (`dm_text`, por ejemplo Huatusco): no se reescriben ni "mejoran" sin pedírselo a Roy.
3. **Una vez por persona** en campañas de venta (`once_per_contact`): no dupliques DMs.
4. **Secretos fuera de todo** lo que se comparte: tokens de IG, `MCP_SECRET`, `CRON_SECRET`, API keys, service role.
5. **Documentos entregados** siguen `rush-control-documental`:
   - nombre `RUSH-TIPO-AREA-###-Nombre-vX.Y`, con encabezado interno;
   - sin precios ni nombres de proveedores ni productores;
   - versión nueva = archivo nuevo (no se sobreescribe el link de una versión ya entregada).
6. **Piezas visuales** siguen `rush-brand`:
   - Baron Neue en títulos, Montserrat en cuerpo;
   - paleta #1A1A1A, #C8A882, #F5EDD8, #A6845C;
   - logo siempre desde archivo;
   - reels sin audio y con marca de agua del logo cuadrado blanco.
7. **Precios y nombres de la carta**: solo de la skill `rush-carta-vigente` o de Shopify, nunca inventados.
8. **Ventana de 24 h de Meta**: fuera de ella el bot no puede iniciar DMs. Las respuestas privadas a comentarios sí funcionan con `recipient.comment_id`.

## 7. Límites de Instagram (validados en `publish_logic.ts`)

- **Imágenes**: solo JPG. PNG, WEBP o HEIC se rechazan; conviértelos antes.
- **Medios**: URL https pública.
- **Número de medios por tipo**:
  - imagen: 1;
  - reel: 1 video MP4/MOV;
  - carrusel: 2 a 10;
  - historia: 1, sin caption, sin primer comentario y sin palabra clave.
- **Caption**: hasta 2,200 caracteres, máximo 30 hashtags y 20 menciones.
- **Programación**: hasta 75 días adelante, en hora Rush (`2026-11-20 18:30`).
- **Cupo**: Meta permite ~100 publicaciones por API cada 24 h; consulta `limite_publicacion`.

## 8. Ideas de mejora (backlog, en orden sugerido)

1. **Shopify → flujo de venta automático.**
   - Al publicar un producto nuevo en rushcafe.net, proponer: post + palabra clave + DM con link del producto (`{link}` medido).
   - Usar el MCP de Shopify para leer el producto.
2. **Métricas de conversión.**
   - Cruzar `deliveries.clicked_at` con pedidos de Shopify (UTM `?utm_source=rushchat&utm_campaign=<slug>` en los links de venta).
   - Reporte semanal por campaña.
3. **Secuencias de venta**: 2 o 3 mensajes dentro de la ventana de 24 h para recursos `venta` (hoy solo existe el "¿te sirvió?").
4. **Newsletter**: sincronizar los correos de `leads` con la herramienta de email que elija Roy.
5. **Calendario editorial semanal** generado por agente:
   - borradores en `posts` con `draft: true`, a partir de la carta vigente y los cafés de temporada;
   - Roy aprueba desde el Panel.
6. **Reels**: pipeline video-factory → `importar_medio` → `publicar_contenido` como borrador.
7. **Retirar** flujos de campañas vencidas (por ejemplo Cosecha, al cerrar inscripciones) con `flujo_estado`.

Antes de construir algo grande, considera ChatbotX (fork en `github.com/roycjacome/chatbotx-rush`) si Roy decide pasar a omnicanal con WhatsApp y bandeja de equipo. Ver la decisión en el project file.

## 9. Estado del despliegue (2026-11-05)

- **Funcionando en producción**:
  - bot de comentarios y DMs;
  - campañas Huatusco, guías y Cosecha;
  - publicación por REST/MCP con el set original de herramientas.
- **Pendiente: `update.sh` no se ha corrido.** En el código, sin desplegar:
  - migraciones 007 (links de guías en Shopify) y 008 (biblioteca y panel);
  - renovación automática del token IG;
  - herramientas del Panel;
  - `{link}` con tracking en `dm_text`.
- **Mientras no se corra**:
  - el token de Instagram **no se renueva solo** y vence ~60 días después de generado (finales de diciembre de 2026);
  - las guías PROMPTS/VENDER/COSTEO apuntan a URLs viejas si 007 no ha corrido.
- **Para desplegar**: en la Mac rosa, carpeta `~/Downloads/rush-chat`, correr `./update.sh <project-ref>`. Lo hace Roy, porque requiere `.secrets/supabase_token`.

## 10. Probar cambios

```bash
cd codigo/rush-chat
for t in tests/*.test.ts; do node --experimental-strip-types "$t"; done   # bot + publicación
deno check supabase/functions/*/index.ts                                  # tipos
```

Cambio de esquema = nueva migración `0NN_nombre.sql` que empieza con:

```sql
create schema if not exists rush_chat;
set search_path to rush_chat, public, extensions;
```

Además: agregar el archivo al loop de `update.sh` y terminar con `notify pgrst, 'reload schema';`.
