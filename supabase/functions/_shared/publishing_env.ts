// Arma el motor de publicación con las variables de entorno (lo usan rush-api y rush-mcp).

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { createPublisher } from "./publisher.ts";
import { mediaStorage, publishGraph, publishStore } from "./publisher_supabase.ts";
import { igTokenProvider } from "./ig_token.ts";

export function publishingFromEnv(db: SupabaseClient<any, any, any>) {
  const get = (k: string, d?: string) => {
    const v = Deno.env.get(k) ?? d;
    if (v === undefined) throw new Error(`Falta la variable de entorno ${k}`);
    return v;
  };
  const base = `https://${get("GRAPH_HOST", "graph.instagram.com")}/${get("GRAPH_VERSION", "v23.0")}`;
  const igUserId = get("IG_USER_ID");
  const tok = igTokenProvider(db, get("IG_ACCESS_TOKEN"));
  const token = () => tok.get();
  const publisher = createPublisher(
    publishStore(db),
    publishGraph({ base, igUserId, token }),
    { tzOffset: get("TZ_OFFSET", "-06:00") },
  );
  const storage = mediaStorage({
    supabaseUrl: get("SUPABASE_URL"),
    serviceKey: get("SUPABASE_SERVICE_ROLE_KEY"),
    maxBytes: Number(get("MEDIA_MAX_MB", "100")) * 1024 * 1024,
  });

  /** Publicaciones recientes ya en Instagram (para elegir a cuál ligar algo). */
  async function recentInstagram(limit = 10) {
    const res = await fetch(
      `${base}/${igUserId}/media?fields=id,caption,permalink,timestamp,media_type,comments_count,like_count&limit=${Math.min(limit, 50)}`,
      { headers: { Authorization: `Bearer ${await token()}` } },
    );
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
    return (j.data ?? []).map((p: any) => ({
      media_id: p.id, fecha: p.timestamp, tipo: p.media_type, likes: p.like_count, comentarios: p.comments_count,
      caption: (p.caption ?? "").replace(/\s+/g, " ").slice(0, 100), link: p.permalink,
    }));
  }

  return { publisher, storage, recentInstagram };
}

/** Herramientas MCP de publicación (las comparte rush-mcp). */
export function publishingTools(p: ReturnType<typeof publishingFromEnv>, createdBy = "claude") {
  const mediaSchema = {
    type: "array", minItems: 1, maxItems: 10,
    items: { type: "string", description: "URL https pública directa (usa importar_medio para links de Drive/Dropbox)" },
  };
  return [
    {
      name: "importar_medio",
      description: "Descarga una imagen o video desde un link (Google Drive compartido como 'cualquiera con el link', Dropbox o web) y lo sube al almacenamiento de Rush para que Instagram pueda publicarlo. Devuelve la URL directa a usar en publicar_contenido. Instagram solo acepta JPG para imágenes y MP4/MOV para video.",
      inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } },
      run: async ({ url }: any) => p.storage.importFromUrl(url),
    },
    {
      name: "publicar_contenido",
      description:
        "Publica o programa contenido en el Instagram de Rush. Tipos: image (1 JPG), carousel (2-10 JPG/MP4), reel (1 video), story (1 imagen o video, sin caption). " +
        "Sin fecha = publica ya. Fecha sin zona = hora de Rush (UTC-6), ej. '2026-10-28 18:30'. borrador=true lo guarda sin programar. " +
        "Opcional: primer_comentario (hashtags o CTA) y palabra_clave + recurso para que el bot entregue esa guía a quien comente la palabra en ESTE post. " +
        "Muestra a Roy el caption y la fecha antes de publicar y espera su OK.",
      inputSchema: {
        type: "object",
        required: ["tipo", "medios"],
        properties: {
          tipo: { type: "string", enum: ["image", "carousel", "reel", "story"] },
          medios: mediaSchema,
          caption: { type: "string", maxLength: 2200 },
          fecha: { type: "string", description: "Vacío = ahora. '2026-10-28 18:30' (hora Rush) o ISO con zona" },
          borrador: { type: "boolean", default: false },
          portada_url: { type: "string", description: "Solo reels: imagen de portada" },
          compartir_en_feed: { type: "boolean", default: true, description: "Solo reels" },
          primer_comentario: { type: "string", maxLength: 2200 },
          palabra_clave: { type: "string", description: "Ej. GUIA. Requiere recurso" },
          recurso: { type: "string", description: "slug del recurso que entrega el bot" },
          respuestas_publicas: { type: "array", items: { type: "string" }, maxItems: 10 },
        },
      },
      annotations: { openWorldHint: true },
      run: async (a: any) => p.publisher.createPost({
        kind: a.tipo, media: a.medios, caption: a.caption, scheduled_at: a.fecha, draft: a.borrador,
        cover_url: a.portada_url, share_to_feed: a.compartir_en_feed, first_comment: a.primer_comentario,
        keyword: a.palabra_clave, resource_slug: a.recurso, public_replies: a.respuestas_publicas,
      }, createdBy),
    },
    {
      name: "calendario_contenido",
      description: "Muestra las publicaciones programadas, borradores y fallidas de los próximos N días (o también las ya publicadas con incluir_pasadas).",
      inputSchema: {
        type: "object",
        properties: { dias: { type: "integer", default: 14, minimum: 1, maximum: 90 }, incluir_pasadas: { type: "boolean", default: false } },
      },
      annotations: { readOnlyHint: true },
      run: async (a: any) => p.publisher.calendar({ days: a.dias, includePast: a.incluir_pasadas }),
    },
    {
      name: "gestionar_publicacion",
      description: "Acciones sobre una publicación de la cola: 'publicar_ahora', 'reprogramar' (con fecha), 'cancelar' o 'ver'.",
      inputSchema: {
        type: "object",
        required: ["id", "accion"],
        properties: {
          id: { type: "string" },
          accion: { type: "string", enum: ["publicar_ahora", "reprogramar", "cancelar", "ver"] },
          fecha: { type: "string" },
        },
      },
      run: async ({ id, accion, fecha }: any) => {
        if (accion === "publicar_ahora") return p.publisher.publishNow(id);
        if (accion === "reprogramar") {
          if (!fecha) throw new Error("Falta la fecha.");
          return p.publisher.reschedule(id, fecha);
        }
        if (accion === "cancelar") return p.publisher.cancel(id);
        return (await p.publisher.get(id)) ?? { error: "No existe" };
      },
    },
    {
      name: "limite_publicacion",
      description: "Cuántas publicaciones por API quedan disponibles en las últimas 24 h según Instagram.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => p.publisher.limits(),
    },
  ];
}
