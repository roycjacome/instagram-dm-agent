// RUSH API — publicación de contenido en Instagram para agentes (Grok, n8n, scripts…).
// REST + OpenAPI. Autenticación: Authorization: Bearer <API key> (PUBLISH_API_KEYS).
//
// Base: https://<ref>.supabase.co/functions/v1/rush-api

import { createClient } from "npm:@supabase/supabase-js@2";
import { safeEqual } from "../_shared/logic.ts";
import { ValidationError } from "../_shared/publisher.ts";
import { publishingFromEnv } from "../_shared/publishing_env.ts";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  db: { schema: Deno.env.get("DB_SCHEMA") ?? "rush_chat" },
  auth: { persistSession: false },
});
const pub = publishingFromEnv(db);
const CRON_SECRET = Deno.env.get("CRON_SECRET");

// "grok:abc123,n8n:def456" → [{name, key}]
const KEYS = (Deno.env.get("PUBLISH_API_KEYS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((s) => ({ name: s.split(":")[0], key: s.slice(s.indexOf(":") + 1) }))
  .filter((k) => k.key.length >= 24);

function clientFor(req: Request): string | null {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return KEYS.find((k) => safeEqual(k.key, token))?.name ?? null;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: CORS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^.*\/rush-api/, "") || "/";
  const base = `${url.origin}${url.pathname.slice(0, url.pathname.length - path.length)}`;

  try {
    // Público: la especificación para que el agente sepa cómo usar la API.
    if (req.method === "GET" && (path === "/" || path === "/openapi.json")) return json(openapi(base));

    // Cron (pg_cron cada minuto)
    if (path === "/cron/publish") {
      if (!CRON_SECRET || !safeEqual(req.headers.get("x-cron-secret") ?? "", CRON_SECRET)) return json({ error: "forbidden" }, 403);
      return json(await pub.publisher.processQueue());
    }

    const client = clientFor(req);
    if (!client) return json({ error: "API key inválida o ausente (Authorization: Bearer <key>)" }, 401);

    const body = ["POST", "PATCH"].includes(req.method) && !path.startsWith("/media/upload")
      ? await req.json().catch(() => ({}))
      : {};
    const m = path.match(/^\/posts\/([0-9a-f-]{36})(\/publish)?$/i);

    if (req.method === "GET" && path === "/posts") {
      return json(await pub.publisher.calendar({
        days: Number(url.searchParams.get("days") ?? 14),
        includePast: url.searchParams.get("past") === "true",
      }));
    }
    if (req.method === "POST" && path === "/posts") return json(await pub.publisher.createPost(body, client), 201);
    if (m && req.method === "GET" && !m[2]) {
      const p = await pub.publisher.get(m[1]);
      return p ? json(p) : json({ error: "No existe" }, 404);
    }
    if (m && req.method === "POST" && m[2]) return json(await pub.publisher.publishNow(m[1]));
    if (m && req.method === "PATCH") return json(await pub.publisher.reschedule(m[1], body.scheduled_at));
    if (m && req.method === "DELETE") return json(await pub.publisher.cancel(m[1]));

    if (req.method === "POST" && path === "/media/import") return json(await pub.storage.importFromUrl(body.url), 201);
    if (req.method === "POST" && path === "/media/upload") {
      const bytes = new Uint8Array(await req.arrayBuffer());
      return json(await pub.storage.store(bytes, req.headers.get("content-type") ?? "", url.searchParams.get("name") ?? "medio"), 201);
    }
    if (req.method === "GET" && path === "/limits") return json(await pub.publisher.limits());
    if (req.method === "GET" && path === "/instagram/posts") {
      return json(await pub.recentInstagram(Number(url.searchParams.get("limit") ?? 10)));
    }
    return json({ error: `Ruta no encontrada: ${req.method} ${path}. Ver /openapi.json` }, 404);
  } catch (e) {
    if (e instanceof ValidationError) return json({ error: "validacion", errors: e.errors }, 422);
    return json({ error: (e as Error).message }, 400);
  }
});

function openapi(server: string) {
  const media = {
    type: "array", minItems: 1, maxItems: 10,
    items: {
      oneOf: [
        { type: "string", format: "uri", description: "URL https directa; el tipo se infiere por extensión" },
        { type: "object", required: ["url"], properties: { url: { type: "string" }, type: { enum: ["image", "video"] } } },
      ],
    },
  };
  const postView = {
    type: "object",
    properties: {
      id: { type: "string" }, tipo: { type: "string" },
      estado: { enum: ["draft", "scheduled", "processing", "publishing", "published", "failed", "canceled"] },
      programado: { type: "string" }, caption: { type: "string" }, medios: { type: "integer" },
      link: { type: "string" }, error: { type: "string" }, palabra_clave: { type: "string" }, creado_por: { type: "string" },
    },
  };
  const ok = (schema: unknown, description = "OK") => ({ description, content: { "application/json": { schema } } });
  const idParam = [{ name: "id", in: "path", required: true, schema: { type: "string" } }];
  return {
    openapi: "3.1.0",
    info: {
      title: "RUSH Instagram API",
      version: "1.0.0",
      description:
        "Publica y programa contenido en el Instagram de Rush Café. Flujo típico: 1) POST /media/import con el link del archivo " +
        "(Drive/Dropbox/web) para obtener una URL directa; 2) POST /posts con tipo, medios, caption y fecha opcional. " +
        "Las fechas sin zona horaria se interpretan en hora de Rush (UTC-6). Las imágenes deben ser JPG; video MP4/MOV. " +
        "Los videos tardan unos minutos en procesarse: la publicación queda en 'processing' y se publica sola.",
    },
    servers: [{ url: server }],
    security: [{ bearer: [] }],
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
    paths: {
      "/posts": {
        get: {
          operationId: "listPosts", summary: "Calendario: programadas, borradores y fallidas",
          parameters: [
            { name: "days", in: "query", schema: { type: "integer", default: 14 } },
            { name: "past", in: "query", schema: { type: "boolean", default: false }, description: "Incluir publicadas" },
          ],
          responses: { "200": ok({ type: "array", items: postView }) },
        },
        post: {
          operationId: "createPost", summary: "Publicar ya o programar",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object", required: ["kind", "media"],
                  properties: {
                    kind: { enum: ["image", "carousel", "reel", "story"], description: "image=1 JPG, carousel=2-10, reel=1 video, story=1 medio sin caption" },
                    media,
                    caption: { type: "string", maxLength: 2200, description: "Máx. 30 hashtags y 20 menciones" },
                    scheduled_at: { type: "string", description: "Vacío = ahora. '2026-10-28 18:30' (hora Rush) o ISO 8601 con zona. Máx. 75 días" },
                    draft: { type: "boolean", description: "Guardar sin programar" },
                    cover_url: { type: "string", description: "Portada del reel" },
                    share_to_feed: { type: "boolean", default: true },
                    first_comment: { type: "string", description: "Comentario propio al publicar" },
                    keyword: { type: "string", description: "Palabra que activa el bot de DMs en comentarios de este post" },
                    resource_slug: { type: "string", description: "Recurso que entrega el bot (requerido con keyword)" },
                    public_replies: { type: "array", items: { type: "string" }, description: "Variaciones del comentario público del bot" },
                  },
                },
              },
            },
          },
          responses: { "201": ok(postView, "Creada"), "422": ok({ type: "object", properties: { errors: { type: "array", items: { type: "string" } } } }, "Validación") },
        },
      },
      "/posts/{id}": {
        get: { operationId: "getPost", parameters: idParam, responses: { "200": ok(postView) } },
        patch: {
          operationId: "reschedulePost", summary: "Reprogramar", parameters: idParam,
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["scheduled_at"], properties: { scheduled_at: { type: "string" } } } } } },
          responses: { "200": ok(postView) },
        },
        delete: { operationId: "cancelPost", summary: "Cancelar (si no se ha publicado)", parameters: idParam, responses: { "200": ok(postView) } },
      },
      "/posts/{id}/publish": {
        post: { operationId: "publishNow", summary: "Publicar ahora (borrador, programada o fallida)", parameters: idParam, responses: { "200": ok(postView) } },
      },
      "/media/import": {
        post: {
          operationId: "importMedia", summary: "Traer un archivo desde un link público y obtener URL directa",
          requestBody: { content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } } },
          responses: { "201": ok({ type: "object", properties: { url: { type: "string" }, type: { type: "string" }, mime: { type: "string" }, bytes: { type: "integer" } } }) },
        },
      },
      "/media/upload": {
        post: {
          operationId: "uploadMedia", summary: "Subir el archivo directamente (cuerpo binario)",
          parameters: [{ name: "name", in: "query", schema: { type: "string" } }],
          requestBody: { content: { "image/jpeg": {}, "video/mp4": {}, "video/quicktime": {} } },
          responses: { "201": ok({ type: "object", properties: { url: { type: "string" } } }) },
        },
      },
      "/limits": { get: { operationId: "publishingLimit", summary: "Cupo de publicaciones por API en 24 h", responses: { "200": ok({ type: "object" }) } } },
      "/instagram/posts": {
        get: {
          operationId: "recentInstagramPosts", summary: "Publicaciones recientes ya en Instagram",
          parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 10 } }],
          responses: { "200": ok({ type: "array", items: { type: "object" } }) },
        },
      },
    },
  };
}
