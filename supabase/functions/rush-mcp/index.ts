// RUSH MCP — panel de control del bot de Instagram desde Claude.
// Servidor MCP remoto (Streamable HTTP, sin estado, respuestas JSON) sobre la misma base del webhook.
//
// URL para agregarlo como conector personalizado en claude.ai:
//   https://<ref>.supabase.co/functions/v1/rush-mcp/<MCP_SECRET>

import { createClient } from "npm:@supabase/supabase-js@2";
import { publishingFromEnv, publishingTools } from "../_shared/publishing_env.ts";
import { igTokenProvider } from "../_shared/ig_token.ts";
import {
  actionToPayload, DEFAULT_PUBLIC_REPLIES, igShortcode, normalize, safeEqual, slugify, trackedLink, within24h,
} from "../_shared/logic.ts";

const env = (k: string, fallback?: string) => {
  const v = Deno.env.get(k) ?? fallback;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${k}`);
  return v;
};

const MCP_SECRET = env("MCP_SECRET");
const IG_USER_ID = env("IG_USER_ID");
const PUBLIC_BASE_URL = env("PUBLIC_BASE_URL");
const GRAPH = `https://${env("GRAPH_HOST", "graph.instagram.com")}/${env("GRAPH_VERSION", "v23.0")}`;

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  db: { schema: Deno.env.get("DB_SCHEMA") ?? "rush_chat" },
  auth: { persistSession: false },
});
const igToken = igTokenProvider(db, env("IG_ACCESS_TOKEN"));
const pub = publishingFromEnv(db);
const SUPABASE_URL = env("SUPABASE_URL").replace(/\/$/, "");
const SERVICE_KEY = env("SUPABASE_SERVICE_ROLE_KEY");

// ---------------- Graph API ----------------

async function graphGet(path: string, params: Record<string, string>) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${GRAPH}/${path}?${qs}`, { headers: { Authorization: `Bearer ${await igToken.get()}` } });
  const json = await res.json();
  if (!res.ok) throw new Error(`Meta API: ${json?.error?.message ?? res.status}`);
  return json;
}

async function graphPost(path: string, body: unknown) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await igToken.get()}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta API: ${json?.error?.message ?? res.status}`);
  return json;
}

async function graphDelete(path: string, body: unknown) {
  const res = await fetch(`${GRAPH}/${path}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${await igToken.get()}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Meta API: ${json?.error?.message ?? res.status}`);
  return json;
}

async function getSetting(key: string) {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}

async function setSetting(key: string, value: unknown) {
  const { error } = await db.from("settings").upsert({ key, value, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

type Post = { id: string; caption?: string; permalink: string; timestamp: string; media_type: string; comments_count?: number; media_url?: string; thumbnail_url?: string };

async function recentPosts(limit: number): Promise<Post[]> {
  const out: Post[] = [];
  let after: string | undefined;
  while (out.length < limit) {
    const page = await graphGet(`${IG_USER_ID}/media`, {
      fields: "id,caption,permalink,timestamp,media_type,comments_count,media_url,thumbnail_url",
      limit: String(Math.min(50, limit - out.length)),
      ...(after ? { after } : {}),
    });
    out.push(...(page.data ?? []));
    after = page.paging?.cursors?.after;
    if (!page.paging?.next || !after) break;
  }
  return out;
}

/** Acepta "ultimo", un link de Instagram o un media_id y devuelve el post. */
async function resolvePost(ref: string): Promise<Post> {
  const r = ref.trim();
  if (["ultimo", "último", "latest", "last"].includes(r.toLowerCase())) {
    const [p] = await recentPosts(1);
    if (!p) throw new Error("La cuenta no tiene publicaciones.");
    return p;
  }
  const code = igShortcode(r);
  if (code) {
    const posts = await recentPosts(100);
    const p = posts.find((x) => igShortcode(x.permalink) === code);
    if (!p) throw new Error("No encontré ese post entre las últimas 100 publicaciones de la cuenta.");
    return p;
  }
  if (/^\d+$/.test(r)) return await graphGet(r, { fields: "id,caption,permalink,timestamp,media_type,comments_count,media_url,thumbnail_url" });
  throw new Error('Post no reconocido. Usa "ultimo", el link del post o su media_id.');
}

// ---------------- Helpers de datos ----------------

async function findContact(who: string) {
  const handle = who.trim().replace(/^@/, "");
  const q = /^\d{6,}$/.test(handle)
    ? db.from("contacts").select("*").eq("igsid", handle)
    : db.from("contacts").select("*").ilike("username", handle);
  const { data } = await q.maybeSingle();
  if (!data) throw new Error(`No tengo a "${who}" en contactos. Solo puedo escribir a quien ya escribió o comentó.`);
  return data;
}

function assertWindow(contact: any) {
  if (!within24h(contact.last_inbound_at)) {
    throw new Error(
      `La ventana de 24 h de Meta con @${contact.username ?? contact.igsid} está cerrada ` +
        `(último mensaje: ${contact.last_inbound_at ?? "nunca"}). Hay que esperar a que vuelva a escribir.`,
    );
  }
}

const short = (s?: string | null, n = 80) => (s ?? "").replace(/\s+/g, " ").slice(0, n);

// ---------------- Herramientas ----------------

type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  run: (args: any) => Promise<unknown>;
};

const tools: Tool[] = [
  {
    name: "ig_posts_recientes",
    description: "Lista las publicaciones recientes de la cuenta de Instagram de Rush (id, fecha, tipo, inicio del caption, link). Úsala para elegir el post al que se liga una palabra clave.",
    inputSchema: { type: "object", properties: { limite: { type: "integer", minimum: 1, maximum: 50, default: 10 } } },
    annotations: { readOnlyHint: true },
    run: async ({ limite = 10 }) => {
      const posts = await recentPosts(limite);
      return posts.map((p) => ({
        media_id: p.id, fecha: p.timestamp, tipo: p.media_type, comentarios: p.comments_count,
        caption: short(p.caption), link: p.permalink,
        miniatura: p.thumbnail_url ?? (p.media_type === "VIDEO" ? null : p.media_url) ?? null,
      }));
    },
  },
  {
    name: "listar_recursos",
    description: "Lista los recursos gratuitos dados de alta, con sus palabras clave, condiciones (correo, seguir la cuenta), respuestas públicas y métricas de entrega, apertura y 'me sirvió'.",
    inputSchema: { type: "object", properties: { incluir_inactivos: { type: "boolean", default: false } } },
    annotations: { readOnlyHint: true },
    run: async ({ incluir_inactivos = false }) => {
      let q = db.from("resources").select(
        "id,slug,title,url,image_url,requires_email,requires_follow,active," +
          "keywords(keyword,channel,media_id,active,public_replies),deliveries(clicked_at,feedback)",
      );
      if (!incluir_inactivos) q = q.eq("active", true);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []).map((r: any) => ({
        slug: r.slug, titulo: r.title, url: r.url, imagen: r.image_url,
        pide_correo: r.requires_email, pide_seguir: r.requires_follow, activo: r.active,
        palabras: r.keywords.map((k: any) => ({
          palabra: k.keyword, canal: k.channel, post: k.media_id, activa: k.active,
          respuestas_publicas: k.public_replies?.length ? k.public_replies : "(default)",
        })),
        entregas: r.deliveries.length,
        aperturas: r.deliveries.filter((d: any) => d.clicked_at).length,
        me_sirvio: r.deliveries.filter((d: any) => d.feedback === "util").length,
      }));
    },
  },
  {
    name: "crear_recurso",
    description: "Da de alta o actualiza un recurso gratuito (guía, prompts, plantilla). Si la URL es de Google Drive, confirma antes con el conector de Drive que el archivo esté compartido como 'cualquiera con el link'. Si el slug ya existe, actualiza el recurso.",
    inputSchema: {
      type: "object",
      required: ["titulo", "url"],
      properties: {
        titulo: { type: "string", maxLength: 80 },
        url: { type: "string", description: "Link real del recurso (Drive, PDF, landing)" },
        descripcion: { type: "string", maxLength: 80, description: "Una línea que aparece en la tarjeta del DM" },
        imagen_url: { type: "string", description: "Portada para la tarjeta (URL pública de imagen, ideal 1.91:1)" },
        pide_correo: { type: "boolean", default: true },
        pide_seguir: { type: "boolean", default: false, description: "true = solo se entrega si la persona sigue la cuenta" },
        mensaje_dm: { type: "string", maxLength: 1000, description: "Texto exacto del DM (con sus links). Si se da, se manda tal cual en vez de la tarjeta. {link} se cambia por el link del recurso con medición de aperturas" },
        una_vez: { type: "boolean", default: false, description: "true = cada persona lo recibe una sola vez (campañas)" },
        slug: { type: "string", description: "Opcional; se genera del título" },
        tipo: { type: "string", enum: ["guia", "activo", "venta"], default: "guia", description: "guia gratis, activo digital (archivo/plantilla) o venta (producto/funnel)" },
      },
    },
    run: async ({ titulo, url, descripcion, imagen_url, pide_correo = true, pide_seguir = false, slug, mensaje_dm, una_vez = false, tipo = "guia" }) => {
      if (!/^https?:\/\//.test(url)) throw new Error("La URL debe empezar con http(s)://");
      if (imagen_url && !/^https:\/\//.test(imagen_url)) throw new Error("La imagen debe ser una URL https pública.");
      const row = {
        slug: slugify(slug || titulo), title: titulo, url, description: descripcion ?? null,
        image_url: imagen_url ?? null, requires_email: pide_correo, requires_follow: pide_seguir, active: true,
        dm_text: mensaje_dm ?? null, once_per_contact: una_vez, kind: tipo,
      };
      const { data, error } = await db.from("resources").upsert(row, { onConflict: "slug" })
        .select("slug,title,url,requires_email,requires_follow").single();
      if (error) throw new Error(error.message);
      return { ok: true, recurso: data, siguiente: "Liga una palabra clave con ligar_palabra." };
    },
  },
  {
    name: "ligar_palabra",
    description: "Liga una palabra clave a un recurso. Con post ('ultimo', link de Instagram o media_id) la palabra solo funciona en comentarios de ese post. Sin post funciona en cualquier publicación, en DMs y en respuestas a historias. canal 'story' = solo respuestas a historias. Las respuestas públicas rotan al azar para que Instagram no lo marque como spam; da 3-5 variaciones.",
    inputSchema: {
      type: "object",
      required: ["palabra", "recurso"],
      properties: {
        palabra: { type: "string", description: "Ej. PROMPTS" },
        recurso: { type: "string", description: "slug del recurso" },
        post: { type: "string", description: "'ultimo', link del post o media_id (opcional)" },
        canal: { type: "string", enum: ["any", "comment", "dm", "story"], default: "any" },
        respuestas_publicas: {
          type: "array", items: { type: "string", maxLength: 300 }, maxItems: 10,
          description: "Variaciones del comentario público. Si se omite se usan las predeterminadas.",
        },
      },
    },
    run: async ({ palabra, recurso, post, canal = "any", respuestas_publicas }) => {
      const kw = normalize(palabra);
      if (!kw) throw new Error("Palabra vacía.");
      const { data: r } = await db.from("resources").select("id,title").eq("slug", recurso).maybeSingle();
      if (!r) throw new Error(`No existe el recurso "${recurso}". Revisa listar_recursos.`);
      const p = post ? await resolvePost(post) : null;
      const channel = p && canal === "any" ? "comment" : canal;
      const replies = (Array.isArray(respuestas_publicas) ? respuestas_publicas : respuestas_publicas ? [respuestas_publicas] : [])
        .map((s: string) => s.trim()).filter(Boolean);

      const { data: clash } = await db.from("keywords").select("id,resource_id")
        .ilike("keyword", kw).eq("channel", channel)
        .filter("media_id", p ? "eq" : "is", p ? p.id : null).maybeSingle();
      const row = {
        keyword: kw, resource_id: r.id, channel, media_id: p?.id ?? null,
        public_replies: replies, public_reply: replies[0] ?? null, active: true,
        media_permalink: p?.permalink ?? null, media_caption: p ? short(p.caption, 120) : null,
        media_thumb: p ? (p.thumbnail_url ?? (p.media_type === "VIDEO" ? null : p.media_url) ?? null) : null,
      };
      const { error } = clash
        ? await db.from("keywords").update(row).eq("id", clash.id)
        : await db.from("keywords").insert(row);
      if (error) throw new Error(error.message);
      return {
        ok: true, palabra: kw.toUpperCase(), recurso: r.title, canal: channel,
        post: p ? { link: p.permalink, caption: short(p.caption) } : "cualquier publicación",
        respuestas_publicas: replies.length ? replies : DEFAULT_PUBLIC_REPLIES,
        reemplazo: !!clash,
      };
    },
  },
  {
    name: "configurar_ice_breakers",
    description: "Configura en Instagram hasta 4 preguntas sugeridas (ice breakers) que ve la gente al abrir el chat de Rush por primera vez. Cada una dispara una acción: 'recurso:<slug>', 'menu' o 'humano'. Lista vacía = quitarlas.",
    inputSchema: {
      type: "object",
      required: ["preguntas"],
      properties: {
        preguntas: {
          type: "array", maxItems: 4,
          items: {
            type: "object", required: ["pregunta", "accion"],
            properties: {
              pregunta: { type: "string", maxLength: 80, description: "Ej. '¿Tienen guías gratis para cafeterías?'" },
              accion: { type: "string", description: "'recurso:<slug>', 'menu' o 'humano'" },
            },
          },
        },
      },
    },
    annotations: { openWorldHint: true },
    run: async ({ preguntas }) => {
      const items = (preguntas ?? []).map((q: any) => ({ question: q.pregunta, payload: actionToPayload(q.accion) }));
      for (const it of items) {
        if (it.payload.startsWith("RES:")) {
          const { data } = await db.from("resources").select("id").eq("slug", it.payload.slice(4)).maybeSingle();
          if (!data) throw new Error(`No existe el recurso "${it.payload.slice(4)}".`);
        }
      }
      if (items.length) {
        await graphPost("me/messenger_profile", {
          platform: "instagram",
          ice_breakers: [{ call_to_actions: items, locale: "default" }],
        });
      } else {
        await graphDelete("me/messenger_profile", { platform: "instagram", fields: ["ice_breakers"] });
      }
      await setSetting("ice_breakers", preguntas ?? []);
      return { ok: true, ice_breakers: preguntas ?? [] };
    },
  },
  {
    name: "configurar_mensajes",
    description: "Edita el mensaje de bienvenida (primer DM sin palabra clave, va con botones de los recursos) y qué pasa cuando alguien menciona a Rush en una historia: 'menu' (agradece y muestra recursos), 'recurso' (agradece y ofrece uno específico) u 'off'.",
    inputSchema: {
      type: "object",
      properties: {
        bienvenida: { type: "string", maxLength: 640 },
        historia_modo: { type: "string", enum: ["menu", "recurso", "off"] },
        historia_recurso: { type: "string", description: "slug, requerido si historia_modo = recurso" },
        historia_texto: { type: "string", maxLength: 640 },
      },
    },
    run: async ({ bienvenida, historia_modo, historia_recurso, historia_texto }) => {
      if (bienvenida) await setSetting("welcome", { text: bienvenida });
      if (historia_modo || historia_texto || historia_recurso) {
        const cur = (await getSetting("story_mention")) ?? {};
        const mode = historia_modo === "recurso" ? "resource" : historia_modo ?? cur.mode ?? "menu";
        const slug = historia_recurso ?? cur.resource_slug ?? null;
        if (mode === "resource") {
          if (!slug) throw new Error("Falta historia_recurso.");
          const { data } = await db.from("resources").select("id").eq("slug", slug).maybeSingle();
          if (!data) throw new Error(`No existe el recurso "${slug}".`);
        }
        await setSetting("story_mention", { mode, resource_slug: slug, text: historia_texto ?? cur.text });
      }
      return { ok: true, config: { welcome: await getSetting("welcome"), story_mention: await getSetting("story_mention") } };
    },
  },
  {
    name: "ver_config",
    description: "Muestra la configuración actual: bienvenida, menciones en historias e ice breakers.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => ({
      bienvenida: await getSetting("welcome"),
      menciones_historia: await getSetting("story_mention"),
      ice_breakers: await getSetting("ice_breakers"),
      token_instagram: await (async () => {
        const t = await getSetting("ig_token");
        return t
          ? { renovado: t.refreshed_at, vence: t.expires_at, renovacion: "automática semanal" }
          : { renovado: null, vence: null, renovacion: "automática semanal (primera corrida pendiente)" };
      })(),
    }),
  },
  {
    name: "pausar",
    description: "Activa o desactiva una palabra clave o un recurso completo.",
    inputSchema: {
      type: "object",
      required: ["tipo", "valor", "activo"],
      properties: {
        tipo: { type: "string", enum: ["palabra", "recurso"] },
        valor: { type: "string", description: "La palabra o el slug del recurso" },
        activo: { type: "boolean" },
      },
    },
    run: async ({ tipo, valor, activo }) => {
      const { data, error } = tipo === "palabra"
        ? await db.from("keywords").update({ active: activo }).ilike("keyword", normalize(valor)).select("id")
        : await db.from("resources").update({ active: activo }).eq("slug", valor).select("id");
      if (error) throw new Error(error.message);
      if (!data?.length) throw new Error(`No encontré ${tipo} "${valor}".`);
      return { ok: true, actualizados: data.length, activo };
    },
  },
  {
    name: "ver_leads",
    description: "Leads captados por el bot en los últimos N días: usuario, correo, opt-in y qué recursos recibió y abrió.",
    inputSchema: {
      type: "object",
      properties: {
        dias: { type: "integer", minimum: 1, maximum: 365, default: 7 },
        solo_con_correo: { type: "boolean", default: false },
      },
    },
    annotations: { readOnlyHint: true },
    run: async ({ dias = 7, solo_con_correo = false }) => {
      const since = new Date(Date.now() - dias * 864e5).toISOString();
      let q = db.from("contacts")
        .select("username,email,newsletter_optin,created_at,tags,deliveries(created_at,clicked_at,resources(slug))")
        .gte("created_at", since).order("created_at", { ascending: false }).limit(200);
      if (solo_con_correo) q = q.not("email", "is", null);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      const rows = (data ?? []).map((c: any) => ({
        usuario: c.username ? `@${c.username}` : "(sin username)", correo: c.email, newsletter: c.newsletter_optin,
        alta: c.created_at, baja: c.tags?.includes("stop") ?? false,
        recursos: c.deliveries.map((d: any) => `${d.resources?.slug}${d.clicked_at ? " ✓abierto" : ""}`),
      }));
      return {
        resumen: {
          contactos: rows.length,
          con_correo: rows.filter((r) => r.correo).length,
          abrieron_algo: rows.filter((r) => r.recursos.some((x: string) => x.includes("✓"))).length,
        },
        leads: rows,
      };
    },
  },
  {
    name: "pendientes_humano",
    description: "Personas que pidieron hablar con alguien del equipo (modo humano), con su último mensaje y si la ventana de 24 h sigue abierta.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    run: async () => {
      const { data, error } = await db.from("contacts").select("igsid,username,email,last_inbound_at")
        .eq("state", "handoff").order("last_inbound_at", { ascending: false });
      if (error) throw new Error(error.message);
      return await Promise.all((data ?? []).map(async (c: any) => {
        const { data: ev } = await db.from("events").select("payload,created_at").eq("kind", "message")
          .eq("payload->sender->>id", c.igsid).order("created_at", { ascending: false }).limit(3);
        return {
          usuario: c.username ? `@${c.username}` : c.igsid, correo: c.email,
          ventana_abierta: within24h(c.last_inbound_at), ultimo_mensaje_at: c.last_inbound_at,
          ultimos_mensajes: (ev ?? []).map((e: any) => e.payload?.message?.text).filter(Boolean).reverse(),
        };
      }));
    },
  },
  {
    name: "responder_dm",
    description: "Envía un mensaje de texto por DM de Instagram a un contacto (por @usuario o igsid). Solo funciona si la persona escribió en las últimas 24 h. Confirma el texto con Roy antes de enviar.",
    inputSchema: {
      type: "object",
      required: ["usuario", "texto"],
      properties: {
        usuario: { type: "string" },
        texto: { type: "string", maxLength: 1000 },
        regresar_al_bot: { type: "boolean", default: false, description: "true = sale de modo humano después de enviar" },
      },
    },
    annotations: { destructiveHint: false, openWorldHint: true },
    run: async ({ usuario, texto, regresar_al_bot = false }) => {
      const c = await findContact(usuario);
      assertWindow(c);
      await graphPost(`${IG_USER_ID}/messages`, { recipient: { id: c.igsid }, message: { text: texto } });
      if (regresar_al_bot) await db.from("contacts").update({ state: "idle" }).eq("id", c.id);
      return { ok: true, enviado_a: c.username ? `@${c.username}` : c.igsid, regreso_al_bot: regresar_al_bot };
    },
  },
  {
    name: "enviar_recurso",
    description: "Manda un recurso (con link de tracking) por DM a un contacto. Solo dentro de la ventana de 24 h. No pide correo.",
    inputSchema: {
      type: "object",
      required: ["usuario", "recurso"],
      properties: {
        usuario: { type: "string" },
        recurso: { type: "string", description: "slug" },
        mensaje: { type: "string", description: "Texto opcional antes del link" },
      },
    },
    annotations: { destructiveHint: false, openWorldHint: true },
    run: async ({ usuario, recurso, mensaje }) => {
      const c = await findContact(usuario);
      assertWindow(c);
      const { data: r } = await db.from("resources").select("id,slug,title").eq("slug", recurso).maybeSingle();
      if (!r) throw new Error(`No existe el recurso "${recurso}".`);
      const link = trackedLink(PUBLIC_BASE_URL, r.slug, c.id);
      await graphPost(`${IG_USER_ID}/messages`, {
        recipient: { id: c.igsid },
        message: { text: `${mensaje ? mensaje + "\n\n" : ""}*${r.title}*\n${link}` },
      });
      await db.from("deliveries").insert({ contact_id: c.id, resource_id: r.id, source: "dm" });
      return { ok: true, enviado_a: c.username ? `@${c.username}` : c.igsid, recurso: r.title };
    },
  },
  {
    name: "regresar_al_bot",
    description: "Saca a un contacto del modo humano para que el bot vuelva a atenderlo.",
    inputSchema: { type: "object", required: ["usuario"], properties: { usuario: { type: "string" } } },
    run: async ({ usuario }) => {
      const c = await findContact(usuario);
      await db.from("contacts").update({ state: "idle" }).eq("id", c.id);
      return { ok: true, usuario: c.username ?? c.igsid };
    },
  },
];


// ---------------- Panel web: archivos y flujos ----------------

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv", zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", txt: "text/plain",
};

function b64ToBytes(b64: string) {
  const clean = b64.includes(",") && b64.startsWith("data:") ? b64.slice(b64.indexOf(",") + 1) : b64;
  const bin = atob(clean.replace(/\s/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Nombre de archivo seguro, conservando mayúsculas y guiones (códigos RUSH-GUD-...). */
function safeFileName(name: string) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  const stem = (dot > 0 ? name.slice(0, dot) : name).normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 120) || "archivo";
  return { file: ext ? `${stem}.${ext}` : stem, ext };
}
const safeFolder = (f?: string) =>
  (f ?? "").split("/").map((x) => safeFileName(x).file.replace(/\./g, "_")).filter((x) => x && x !== "archivo").join("/");

function publicUrl(bucket: string, path: string) {
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

async function listBucket(bucket: string, prefix: string) {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${bucket}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ prefix, limit: 500, offset: 0, sortBy: { column: "name", order: "asc" } }),
  });
  if (!res.ok) throw new Error(`Storage: ${res.status} ${await res.text()}`);
  return await res.json() as any[];
}

function panelTools(): Tool[] {
  const find = (n: string) => tools.find((t) => t.name === n)!;
  return [
    {
      name: "subir_archivo",
      description:
        "Sube un archivo (PDF, Excel, imagen, video, zip…) al almacenamiento de Rush y devuelve su URL pública. " +
        "destino 'recursos' = biblioteca de guías y activos digitales que entrega el bot (se puede elegir carpeta); " +
        "destino 'contenido' = imagen JPG o video MP4/MOV para publicar en Instagram. Máximo ~15 MB por llamada; para videos más grandes usa importar_medio con un link de Drive.",
      inputSchema: {
        type: "object",
        required: ["nombre", "contenido_base64"],
        properties: {
          nombre: { type: "string", description: "Nombre con extensión, ej. RUSH-GUD-MKT-008-Guia_X-v1.0.pdf" },
          contenido_base64: { type: "string", description: "Bytes del archivo en base64" },
          tipo_mime: { type: "string" },
          destino: { type: "string", enum: ["recursos", "contenido"], default: "recursos" },
          carpeta: { type: "string", description: "Solo recursos: carpeta dentro de la biblioteca, ej. guias/marketing" },
          reemplazar: { type: "boolean", default: false, description: "true = si ya existe con ese nombre, lo sustituye (mismo link)" },
        },
      },
      run: async ({ nombre, contenido_base64, tipo_mime, destino = "recursos", carpeta, reemplazar = false }) => {
        const bytes = b64ToBytes(String(contenido_base64 ?? ""));
        if (bytes.byteLength < 16) throw new Error("El archivo llegó vacío.");
        const { file, ext } = safeFileName(String(nombre ?? "archivo"));
        const mime = tipo_mime || MIME_BY_EXT[ext] || "application/octet-stream";
        if (destino === "contenido") {
          const r = await pub.storage.store(bytes, mime, file.replace(/\.[^.]+$/, ""));
          return { ok: true, destino, url: r.url, tipo: r.type, mb: +(bytes.byteLength / 1048576).toFixed(2) };
        }
        if (bytes.byteLength > 50 * 1048576) throw new Error("Máximo 50 MB por archivo.");
        const folder = safeFolder(carpeta);
        const path = folder ? `${folder}/${file}` : file;
        const res = await fetch(`${SUPABASE_URL}/storage/v1/object/recursos/${path.split("/").map(encodeURIComponent).join("/")}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": mime, "x-upsert": reemplazar ? "true" : "false" },
          body: bytes as Uint8Array<ArrayBuffer>,
        });
        if (!res.ok) {
          const t = await res.text();
          if (res.status === 409 || /already exists|Duplicate/i.test(t)) {
            throw new Error(`Ya existe "${path}". Súbelo con otro nombre (nueva versión) o con reemplazar=true.`);
          }
          throw new Error(`Storage: ${res.status} ${t}`);
        }
        return { ok: true, destino, ruta: path, url: publicUrl("recursos", path), mb: +(bytes.byteLength / 1048576).toFixed(2) };
      },
    },
    {
      name: "listar_archivos",
      description: "Lista la biblioteca de archivos de Rush (guías, plantillas, activos digitales) con su URL pública. carpeta vacía = raíz.",
      inputSchema: { type: "object", properties: { carpeta: { type: "string", default: "" } } },
      annotations: { readOnlyHint: true },
      run: async ({ carpeta = "" }) => {
        const prefix = safeFolder(carpeta);
        const items = await listBucket("recursos", prefix ? prefix + "/" : "");
        const carpetas = items.filter((i) => !i.id && i.name !== ".emptyFolderPlaceholder").map((i) => (prefix ? `${prefix}/` : "") + i.name);
        const archivos = items.filter((i) => i.id && i.name !== ".emptyFolderPlaceholder").map((i) => {
          const path = (prefix ? `${prefix}/` : "") + i.name;
          return { nombre: i.name, ruta: path, url: publicUrl("recursos", path), kb: Math.round((i.metadata?.size ?? 0) / 1024),
            tipo: i.metadata?.mimetype ?? null, actualizado: i.updated_at ?? i.created_at };
        });
        return { carpeta: prefix, carpetas, archivos };
      },
    },
    {
      name: "crear_carpeta",
      description: "Crea una carpeta vacía en la biblioteca de archivos.",
      inputSchema: { type: "object", required: ["carpeta"], properties: { carpeta: { type: "string" } } },
      run: async ({ carpeta }) => {
        const folder = safeFolder(carpeta);
        if (!folder) throw new Error("Nombre de carpeta vacío.");
        const res = await fetch(`${SUPABASE_URL}/storage/v1/object/recursos/${folder}/.emptyFolderPlaceholder`, {
          method: "POST", headers: { Authorization: `Bearer ${SERVICE_KEY}`, "Content-Type": "text/plain", "x-upsert": "true" }, body: "",
        });
        if (!res.ok) throw new Error(`Storage: ${res.status} ${await res.text()}`);
        return { ok: true, carpeta: folder };
      },
    },
    {
      name: "crear_flujo",
      description:
        "Arma un flujo completo en un paso: cuando alguien comenta (o escribe por DM) la palabra, el bot responde en público y le manda por DM el entregable. " +
        "Entregable: un recurso existente (recurso = slug) o uno nuevo (nuevo = {tipo, titulo, url, descripcion, mensaje_dm}). " +
        "post: 'ultimo', link de Instagram o media_id; vacío = cualquier publicación. Para un post aún no publicado usa publicar_contenido con palabra_clave + recurso.",
      inputSchema: {
        type: "object",
        required: ["palabra"],
        properties: {
          palabra: { type: "string" },
          post: { type: "string" },
          canal: { type: "string", enum: ["any", "comment", "dm", "story"], default: "any" },
          recurso: { type: "string", description: "slug de un recurso existente" },
          nuevo: {
            type: "object",
            required: ["titulo", "url"],
            properties: {
              tipo: { type: "string", enum: ["guia", "activo", "venta"], default: "guia" },
              titulo: { type: "string", maxLength: 80 },
              url: { type: "string" },
              descripcion: { type: "string", maxLength: 80 },
              mensaje_dm: { type: "string", maxLength: 1000 },
              imagen_url: { type: "string" },
            },
          },
          respuestas_publicas: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 10 },
          una_vez: { type: "boolean", default: true },
          pide_correo: { type: "boolean", default: false },
          pide_seguir: { type: "boolean", default: false },
        },
      },
      run: async (a) => {
        let slug = a.recurso as string | undefined;
        if (!slug && a.nuevo) {
          const n = a.nuevo;
          const r: any = await find("crear_recurso").run({
            titulo: n.titulo, url: n.url, descripcion: n.descripcion, imagen_url: n.imagen_url || undefined,
            mensaje_dm: n.mensaje_dm || undefined, tipo: n.tipo ?? "guia",
            pide_correo: a.pide_correo ?? false, pide_seguir: a.pide_seguir ?? false, una_vez: a.una_vez ?? true,
          });
          slug = r.recurso.slug;
        } else if (slug) {
          await db.from("resources").update({
            once_per_contact: a.una_vez ?? true,
            ...(a.pide_correo !== undefined ? { requires_email: a.pide_correo } : {}),
            ...(a.pide_seguir !== undefined ? { requires_follow: a.pide_seguir } : {}),
          }).eq("slug", slug);
        }
        if (!slug) throw new Error("Indica recurso (slug existente) o nuevo.");
        const k: any = await find("ligar_palabra").run({
          palabra: a.palabra, recurso: slug, post: a.post || undefined, canal: a.canal ?? "any",
          respuestas_publicas: a.respuestas_publicas,
        });
        await db.from("keywords").update({ created_by: "panel" }).ilike("keyword", normalize(a.palabra));
        return { ...k, recurso_slug: slug };
      },
    },
    {
      name: "ver_flujos",
      description: "Todos los flujos palabra → entregable, con el post al que aplican y sus métricas (entregas, aperturas, me sirvió), más las publicaciones programadas que ya traen palabra clave.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => {
        const { data, error } = await db.from("keywords").select(
          "id,keyword,channel,media_id,media_permalink,media_caption,media_thumb,active,public_replies,created_at," +
            "resources(id,slug,title,kind,url,dm_text,once_per_contact,requires_email,requires_follow,active,deliveries(source,clicked_at,feedback,created_at))",
        ).order("created_at", { ascending: false });
        if (error) throw new Error(error.message);
        const { data: sched } = await db.from("posts").select("id,kind,caption,scheduled_at,status,keyword,resource_slug,permalink")
          .not("keyword", "is", null).in("status", ["draft", "scheduled", "processing", "publishing", "failed"])
          .order("scheduled_at");
        const week = Date.now() - 7 * 864e5;
        return {
          flujos: (data ?? []).map((k: any) => {
            const d = k.resources?.deliveries ?? [];
            return {
              id: k.id, palabra: k.keyword.toUpperCase(), canal: k.channel, activo: k.active && k.resources?.active !== false,
              post: k.media_id ? { media_id: k.media_id, link: k.media_permalink, caption: k.media_caption, miniatura: k.media_thumb } : null,
              respuestas_publicas: k.public_replies ?? [],
              entregable: k.resources && {
                slug: k.resources.slug, titulo: k.resources.title, tipo: k.resources.kind, url: k.resources.url,
                mensaje_dm: k.resources.dm_text, una_vez: k.resources.once_per_contact,
                pide_correo: k.resources.requires_email, pide_seguir: k.resources.requires_follow,
              },
              metricas: {
                entregas: d.length, ultimos_7_dias: d.filter((x: any) => Date.parse(x.created_at) > week).length,
                aperturas: d.filter((x: any) => x.clicked_at).length, me_sirvio: d.filter((x: any) => x.feedback === "util").length,
              },
              creado: k.created_at,
            };
          }),
          programados: (sched ?? []).map((p: any) => ({
            id: p.id, tipo: p.kind, fecha: p.scheduled_at, estado: p.status, palabra: p.keyword?.toUpperCase(),
            recurso: p.resource_slug, caption: short(p.caption, 100),
          })),
        };
      },
    },
    {
      name: "flujo_estado",
      description: "Activa o pausa un flujo (por su id de ver_flujos).",
      inputSchema: { type: "object", required: ["id", "activo"], properties: { id: { type: "string" }, activo: { type: "boolean" } } },
      run: async ({ id, activo }) => {
        const { data, error } = await db.from("keywords").update({ active: activo }).eq("id", id).select("id,keyword");
        if (error) throw new Error(error.message);
        if (!data?.length) throw new Error("No encontré ese flujo.");
        return { ok: true, palabra: data[0].keyword.toUpperCase(), activo };
      },
    },
  ];
}

tools.push(...panelTools());

// Publicación de contenido (comparte motor con la API REST rush-api)
tools.push(...(publishingTools(pub, "claude") as Tool[]));

// ---------------- MCP (JSON-RPC sobre HTTP) ----------------

const SUPPORTED = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "rush-instagram", version: "0.4.0" };
const INSTRUCTIONS =
  "Panel del Instagram de Rush Café. Las respuestas automáticas las da el webhook; con estas herramientas se publica y programa " +
  "contenido (importar_medio → publicar_contenido), se dan de alta recursos, se ligan palabras clave a posts, se ven leads " +
  "y se atienden casos de modo humano. Antes de publicar_contenido, responder_dm o enviar_recurso, muestra a Roy el texto " +
  "(y la fecha, si aplica) y espera su OK.";

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const ok = (id: RpcReq["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: RpcReq["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function dispatch(m: RpcReq) {
  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion;
      return ok(m.id, {
        protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(m.id, {});
    case "tools/list":
      return ok(m.id, {
        tools: tools.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === m.params?.name);
      if (!tool) return err(m.id, -32602, `Herramienta desconocida: ${m.params?.name}`);
      try {
        const result = await tool.run(m.params?.arguments ?? {});
        return ok(m.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (e) {
        return ok(m.id, { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true });
      }
    }
    default:
      return m.id === undefined ? null : err(m.id, -32601, `Método no soportado: ${m.method}`);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, mcp-protocol-version, mcp-session-id, authorization",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  const secret = new URL(req.url).pathname.split("/").filter(Boolean).pop() ?? "";
  if (!safeEqual(secret, MCP_SECRET)) return new Response("Not found", { status: 404 });

  // Servidor sin estado: no ofrece stream SSE por GET.
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let body: RpcReq | RpcReq[];
  try { body = await req.json(); } catch {
    return Response.json(err(null, -32700, "JSON inválido"), { status: 400, headers: CORS });
  }

  const batch = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(batch.map(dispatch))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202, headers: CORS }); // solo notificaciones
  return Response.json(Array.isArray(body) ? replies : replies[0], { headers: CORS });
});
