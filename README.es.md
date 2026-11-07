# RUSH Instagram · v3

Sistema propio para operar el Instagram de Rush de punta a punta:

- **Bot de DMs** (alternativa a ManyChat): responde comentarios, DMs e historias con palabras clave, entrega guías con botones, capta correos, da seguimiento y mide aperturas.
- **Publicación** (alternativa a Postiz/Metricool para Instagram): posts, carruseles, reels e historias, al momento o programados, con primer comentario y la palabra clave del bot ligada al post en el mismo paso.
- **Agent-friendly**: MCP para Claude y API REST con OpenAPI para Grok, n8n o cualquier bot.

Corre en Supabase (Postgres + Storage + Edge Functions). Costo: $0 en mensajes y publicaciones de Instagram.

## Bot de DMs: qué hace

| Disparador | Acción |
|---|---|
| Alguien comenta **PROMPTS** en un post | Comentario público (rota entre 3-5 variaciones) + DM privado |
| Responde una **historia** con la palabra | Mismo flujo, por DM |
| Te **menciona en una historia** | Le agradece, te avisa para que la repostees y le ofrece un recurso o el menú |
| Abre tu chat por primera vez | Ve los **ice breakers** (hasta 4 preguntas sugeridas) |
| Primer DM sin palabra clave | Bienvenida con **botones** de cada recurso + "Hablar con alguien" |
| Recurso con **"pide seguir"** | Si no te sigue, le pide seguirte con botón **Ya te sigo**; Meta confirma y entonces se entrega |
| Recurso con **"pide correo"** | Pide correo con botón **Prefiero no darlo** |
| Entrega | **Tarjeta** con portada, descripción y botón **Abrir 📥** (link con tracking) |
| ~22 h después | **Seguimiento** "¿Te sirvió?" con botones: Me sirvió / Quiero otra / Tengo una duda |
| Escribe **HUMANO** o toca "Hablar con alguien" | El bot se calla con esa persona y avisa al equipo |
| Escribe **STOP** / **BAJA** | Se da de baja y no se le vuelve a escribir |
| Cualquier otro mensaje ("¿abren hoy?") | Nada: lo contesta el equipo como siempre |

Si Meta rechaza un botón o una tarjeta en algún contexto, el bot reintenta automáticamente con texto plano y link.

## Estructura

```
supabase/
  migrations/001_init.sql     tablas base + vista leads
  migrations/002_v2.sql       settings, gate de seguidor, variaciones, seguimiento
  migrations/003_publishing.sql cola de publicaciones
  migrations/004_storage.sql  bucket público ig-media para imágenes y videos
  seed.sql                    3 recursos de ejemplo (cambia las URL)
  cron.sql                    tareas programadas: publicar (cada min) y seguimiento (cada 15 min)
  config.toml                 desactiva JWT en las funciones (cada una tiene su propia seguridad)
  functions/
    ig-webhook/index.ts       HTTP: webhook de Meta, redirección con tracking, cron de seguimiento
    rush-mcp/index.ts         servidor MCP para manejar todo desde Claude
    rush-api/index.ts         API REST + OpenAPI para Grok y otros agentes, cron de publicación
    _shared/publisher.ts      motor de publicación (contenedores, video, reintentos, sin duplicados)
    _shared/publish_logic.ts  reglas de Instagram: formatos, límites, fechas, links de Drive
    _shared/bot.ts            motor de flujos (comentarios, DMs, historias, botones, seguimiento)
    _shared/logic.ts          lógica pura y copys (edita aquí los textos)
    _shared/supabase_store.ts acceso a datos y a la API de Instagram
tests/
  logic.test.ts               pruebas de lógica
  bot.test.ts                 13 escenarios del bot simulados en memoria
  publisher.test.ts           8 escenarios de publicación + reglas
.env.example                  variables necesarias
```

## Puesta en marcha

### 1. Supabase
```bash
supabase link --project-ref <ref>
supabase db push                              # aplica las migraciones 001-004
psql "$DATABASE_URL" -f supabase/seed.sql     # o pega seed.sql en el SQL Editor
```

### 2. App de Meta
1. Cuenta de Instagram **profesional** de Rush (Business o Creator).
2. [developers.facebook.com](https://developers.facebook.com) → Crear app → tipo **Business** → producto **Instagram** → "API setup with Instagram login".
3. Agrega la cuenta de Rush, genera el **token de acceso** y copia el **ID de la cuenta de Instagram**.
4. Copia el **App Secret** (Configuración → Básica).
5. Permisos: `instagram_business_basic`, `instagram_business_manage_messages`, `instagram_business_manage_comments`, `instagram_business_content_publish`.
6. En la app de Instagram de Rush: Configuración → Mensajes → **Permitir acceso a mensajes** para herramientas conectadas.

### 3. Secrets y deploy
```bash
cp .env.example .env    # llénalo (MCP_SECRET, CRON_SECRET y claves de API: openssl rand -hex 24)
supabase secrets set --env-file .env
supabase functions deploy ig-webhook --no-verify-jwt
supabase functions deploy rush-mcp --no-verify-jwt
supabase functions deploy rush-api --no-verify-jwt
```

### 4. Conectar el webhook
En la app de Meta → Instagram → Webhooks:
- **Callback URL:** `https://<ref>.supabase.co/functions/v1/ig-webhook`
- **Verify token:** el mismo `META_VERIFY_TOKEN`
- Suscribir campos: **messages**, **messaging_postbacks** (ice breakers y botones) y **comments**

Mientras la app está en modo desarrollo solo responde a cuentas con rol en la app (agrégate como tester y prueba desde tu Instagram personal).

### 5. Tareas programadas
Abre `supabase/cron.sql`, reemplaza `<project-ref>` y `<CRON_SECRET>`, y córrelo una vez en el SQL Editor. Activa la publicación programada (cada minuto) y el seguimiento del bot (cada 15 min).

### 6. App Review (para que funcione con cualquier persona)
Meta pide revisión de `instagram_business_manage_messages`, `instagram_business_manage_comments` y `instagram_business_content_publish`:
- Video de pantalla: comentas la palabra → llega el DM → tocas los botones → das correo → recibes la tarjeta. Otro video publicando un post desde Claude.
- Explicación del uso: "Entregar recursos gratuitos que el usuario solicita al comentar, responder una historia o escribir una palabra clave".
- URL de política de privacidad pública (la de `PRIVACY_URL`).
- Verificación del negocio en Meta Business (si no la tienes aún, empieza por ahí: es lo que más tarda).

## Publicar contenido

Tipos: **image** (1 JPG), **carousel** (2-10 JPG/MP4), **reel** (1 video) y **story** (1 imagen o video, sin caption). Sin fecha se publica al momento; con fecha queda en la cola. Las fechas sin zona horaria se toman en hora de Rush (UTC-6), por ejemplo `2026-10-28 18:30`.

Flujo:
1. **Importar el archivo**: si está en Drive (compartido como "cualquiera con el link"), Dropbox o una web, se descarga y se sube al bucket `ig-media` para que Instagram lo pueda leer. Instagram solo acepta JPG en imágenes y MP4/MOV en video.
2. **Publicar o programar** con caption, primer comentario opcional y, si quieres, palabra clave + recurso para el bot.
3. Las imágenes salen en segundos. Los videos quedan en `processing` unos minutos mientras Instagram los procesa, y el cron los publica solos.

Al publicarse, si el post trae palabra clave, el bot queda escuchándola en los comentarios de ese post.

**Protecciones:** reintenta hasta 3 veces si Instagram falla, nunca publica dos veces la misma pieza (aunque se caiga la conexión a medio paso), y avisa con el motivo si Instagram rechaza un medio. Instagram limita la publicación por API a un cupo cada 24 h; consúltalo con `limite_publicacion` o `GET /limits`.

### Desde Claude (MCP)

| Herramienta | Para qué |
|---|---|
| `importar_medio` | Link de Drive/Dropbox/web → URL directa lista para Instagram |
| `publicar_contenido` | Publicar ya, programar o guardar borrador |
| `calendario_contenido` | Qué viene en los próximos días (y qué falló) |
| `gestionar_publicacion` | Publicar ahora, reprogramar, cancelar o ver una publicación |
| `limite_publicacion` | Cupo de publicaciones de las últimas 24 h |

Ejemplos:
- "Importa estas 4 fotos de Drive y programa un carrusel para el jueves a las 7 pm con este caption. Que GUIA mande la guía de prompts."
- "Sube este reel del cold brew mañana 8 am y pon de primer comentario los hashtags."
- "¿Qué tenemos programado esta semana?"

### Desde Grok u otros agentes (API REST)

Base: `https://<ref>.supabase.co/functions/v1/rush-api` · Especificación: `GET /openapi.json` (pública, el agente la lee para saber cómo usar la API).

Autenticación: `Authorization: Bearer <clave>`. Las claves se definen en `PUBLISH_API_KEYS` como `nombre:clave` separadas por coma (`grok:…,n8n:…`); cada publicación guarda qué cliente la creó.

| Método | Ruta | Para qué |
|---|---|---|
| POST | `/media/import` | `{url}` → URL directa en el bucket |
| POST | `/media/upload?name=` | Subir el archivo binario directo (JPG/MP4/MOV) |
| POST | `/posts` | Publicar o programar |
| GET | `/posts?days=14&past=false` | Calendario |
| GET / PATCH / DELETE | `/posts/{id}` | Ver, reprogramar (`{scheduled_at}`), cancelar |
| POST | `/posts/{id}/publish` | Publicar ahora |
| GET | `/limits` | Cupo de 24 h |
| GET | `/instagram/posts?limit=10` | Publicaciones recientes ya en Instagram |

Ejemplo:
```bash
curl -X POST "$BASE/posts" -H "Authorization: Bearer $GROK_KEY" -H "Content-Type: application/json" -d '{
  "kind": "image",
  "media": ["https://<ref>.supabase.co/storage/v1/object/public/ig-media/2026/10/latte.jpg"],
  "caption": "Nuevo latte de temporada 🍂 Comenta GUIA y te mandamos nuestra guía de prompts para cafeterías",
  "scheduled_at": "2026-10-28 18:30",
  "keyword": "guia", "resource_slug": "prompts-cafeteria"
}'
```

Grok también puede usar el servidor MCP si tu integración con xAI admite MCP remoto; si no, la API REST con la especificación OpenAPI es el camino.

## MCP: manejar el bot desde Claude

En claude.ai → Configuración → Conectores → **Agregar conector personalizado** con la URL:
`https://<ref>.supabase.co/functions/v1/rush-mcp/<MCP_SECRET>`

El secreto en la URL es la llave: no la compartas. Si se filtra, cambia `MCP_SECRET` y vuelve a agregar el conector.

| Herramienta | Para qué |
|---|---|
| `ig_posts_recientes` | Ver tus últimos posts (directo de la API de Meta) |
| `crear_recurso` | Dar de alta una guía: link, descripción, portada, si pide correo y si pide seguir |
| `ligar_palabra` | Ligar una palabra a un recurso, opcionalmente a un post (`ultimo`, link o ID) o solo a historias, con variaciones de respuesta pública |
| `configurar_ice_breakers` | Las 4 preguntas sugeridas al abrir el chat (se publican en Instagram) |
| `configurar_mensajes` | Texto de bienvenida y qué hacer con menciones en historias |
| `ver_config` | Configuración actual |
| `pausar` | Activar o desactivar una palabra o un recurso |
| `listar_recursos` | Recursos, palabras y métricas: entregas, aperturas, "me sirvió" |
| `ver_leads` | Leads de los últimos N días |
| `pendientes_humano` | Quién pidió hablar con alguien, con sus últimos mensajes |
| `responder_dm` | Contestar un DM (solo dentro de 24 h) |
| `enviar_recurso` | Mandar una guía a alguien (solo dentro de 24 h) |
| `regresar_al_bot` | Sacar a alguien de modo humano |

Ejemplos:
- "Crea el recurso 'Checklist de apertura' con este link de Drive, que pida seguirnos, y ligalo a CHECKLIST en mi último post."
- "Pon de ice breakers: '¿Tienen guías gratis?' → menú, '¿Dan asesorías?' → humano."
- "Cuando alguien nos mencione en historia, regálale la guía de prompts."
- "¿Qué guía tiene más 'me sirvió' este mes?"

## Operación diaria

- **Leads:** vista `leads` en Supabase o `ver_leads` desde Claude.
- **Newsletter:** `NEWSLETTER_WEBHOOK_URL` recibe `{email, username, resource, tags}` en cada registro. Apúntalo a n8n/Make o directo a Brevo/MailerLite. Las etiquetas por recurso sirven para segmentar.
- **Avisos al equipo:** `NOTIFY_WEBHOOK_URL` recibe `type: "handoff"` (alguien pidió humano o tiene una duda) y `type: "story_mention"` (con el link de la historia para repostear). Se puede conectar a Kafexy para avisar en WhatsApp.
- **Textos:** los copys viven en `_shared/logic.ts` (`copy`) y la bienvenida y menciones se editan desde el MCP.

## Reglas de Meta que el bot ya respeta
- Solo escribe a quien comentó o mandó mensaje primero.
- Una sola respuesta privada por comentario; las respuestas públicas rotan para no parecer spam.
- El seguimiento sale entre las 21 y 23.5 h desde el último mensaje: siempre dentro de la ventana de 24 h, una sola vez.
- Un comentario no cuenta como apertura de ventana: el MCP no intenta mensajes que Meta rechazaría.
- No hace envíos masivos. Las campañas a la base van por correo, no por DM.
- Ignora sus propios comentarios y mensajes (sin loops) y deduplica los reintentos de Meta.

## Pruebas
```bash
node --experimental-strip-types tests/logic.test.ts
node --experimental-strip-types tests/bot.test.ts
node --experimental-strip-types tests/publisher.test.ts
deno check supabase/functions/*/index.ts
```

## Siguientes pasos sugeridos
- Links ig.me con referencia y QR para catas, la Expo y las sucursales.
- Métricas por publicación (alcance, guardados) para ver qué contenido trae más leads.
- Respuestas con IA para preguntas abiertas de emprendedores.
- Secuencia de bienvenida por correo de 3-5 emails tras el registro.
