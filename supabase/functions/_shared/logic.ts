// Lógica pura (sin dependencias) — se puede probar en Node o Deno.

export type Channel = "comment" | "dm" | "story";

export type Keyword = {
  keyword: string;
  resource_id: string;
  channel: "any" | Channel;
  media_id: string | null;
  public_reply?: string | null;
  public_replies?: string[] | null;
};

export type Resource = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  url: string;
  requires_email: boolean;
  requires_follow?: boolean;
  image_url?: string | null;
  /** Texto exacto del DM (reemplaza la tarjeta). Para campañas con links propios. */
  dm_text?: string | null;
  /** true = cada persona recibe este recurso una sola vez. */
  once_per_contact?: boolean;
};

export type QuickReply = { content_type: "text"; title: string; payload: string };

/** Minúsculas, sin acentos, sin signos, espacios colapsados. */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9@.\s_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Qué palabras aplican en cada canal. Una respuesta a historia también es un DM.
const CHANNEL_MATCH: Record<Channel, string[]> = {
  comment: ["any", "comment"],
  dm: ["any", "dm"],
  story: ["any", "dm", "story"],
};

/**
 * Busca la primera palabra clave que aparezca como palabra completa en el texto.
 * Prioriza las ligadas a un post específico (media_id) y luego las de canal específico.
 */
export function matchKeyword(text: string, keywords: Keyword[], channel: Channel, mediaId?: string): Keyword | null {
  const norm = normalize(text);
  const words = new Set(norm.split(" "));
  const full = ` ${norm} `;
  const candidates = keywords
    .filter((k) => CHANNEL_MATCH[channel].includes(k.channel))
    .filter((k) => !k.media_id || k.media_id === mediaId)
    .sort((a, b) =>
      Number(!!b.media_id) - Number(!!a.media_id) ||
      Number(b.channel !== "any") - Number(a.channel !== "any"));

  for (const k of candidates) {
    const kw = normalize(k.keyword);
    if (!kw) continue;
    if (kw.includes(" ") ? full.includes(` ${kw} `) : words.has(kw)) return k;
  }
  return null;
}

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
export function extractEmail(text: string): string | null {
  const m = text.match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

const STOP_WORDS = ["stop", "baja", "no gracias", "cancelar", "salir"];
export function isStop(text: string): boolean {
  const t = normalize(text);
  return STOP_WORDS.some((w) => t === w || t.startsWith(w + " "));
}

const SKIP_EMAIL_WORDS = ["no gracias", "no", "sin correo", "paso", "prefiero no darlo", "prefiero no"];
export function isSkipEmail(text: string): boolean {
  return SKIP_EMAIL_WORDS.includes(normalize(text));
}

const FOLLOW_DONE_WORDS = ["listo", "ya", "ya te sigo", "ya los sigo", "ya sigo", "hecho", "ok", "va"];
export function isFollowDone(text: string): boolean {
  return FOLLOW_DONE_WORDS.includes(normalize(text));
}

const HUMAN_WORDS = ["humano", "asesor", "persona", "hablar con alguien", "roy"];
export function wantsHuman(text: string): boolean {
  const t = ` ${normalize(text)} `;
  return HUMAN_WORDS.some((w) => t.includes(` ${w} `));
}

// ---------- Payloads de botones ----------
// RES:<slug> | SKIP_EMAIL | FOLLOW_CHECK | HUMAN | MENU | FB:<util|otra|duda>:<deliveryId>

export type Intent =
  | { type: "resource"; slug: string }
  | { type: "skip_email" }
  | { type: "follow_check" }
  | { type: "human" }
  | { type: "menu" }
  | { type: "feedback"; value: "util" | "otra" | "duda"; deliveryId: string }
  | null;

export function parsePayload(payload?: string | null): Intent {
  if (!payload) return null;
  if (payload.startsWith("RES:")) return { type: "resource", slug: payload.slice(4) };
  if (payload === "SKIP_EMAIL") return { type: "skip_email" };
  if (payload === "FOLLOW_CHECK") return { type: "follow_check" };
  if (payload === "HUMAN") return { type: "human" };
  if (payload === "MENU") return { type: "menu" };
  const fb = payload.match(/^FB:(util|otra|duda):(.+)$/);
  if (fb) return { type: "feedback", value: fb[1] as "util" | "otra" | "duda", deliveryId: fb[2] };
  return null;
}

/** "menu" | "humano" | "recurso:slug" (como se configura en el MCP) → payload */
export function actionToPayload(action: string): string {
  const a = action.trim().toLowerCase();
  if (a === "menu" || a === "menú") return "MENU";
  if (a === "humano") return "HUMAN";
  const m = action.trim().match(/^recurso:(.+)$/i);
  if (m) return `RES:${m[1].trim()}`;
  throw new Error(`Acción no válida: "${action}". Usa "menu", "humano" o "recurso:<slug>".`);
}

/** Títulos de quick reply: máximo 20 caracteres. */
export function qr(title: string, payload: string): QuickReply {
  const t = title.length > 20 ? title.slice(0, 19).trimEnd() + "…" : title;
  return { content_type: "text", title: t, payload };
}

/** Quick replies del menú: un botón por recurso (máx. 12) + hablar con alguien. */
export function menuQuickReplies(resources: Resource[], keywords: Keyword[]): QuickReply[] {
  const items = resources.slice(0, 12).map((r) => {
    const kw = keywords.find((k) => k.resource_id === r.id && !k.media_id);
    const label = kw ? `📥 ${kw.keyword.toUpperCase()}` : `📥 ${r.title}`;
    return qr(label, `RES:${r.slug}`);
  });
  return [...items, qr("💬 Hablar con alguien", "HUMAN")];
}

// ---------- Respuestas públicas que rotan ----------

export const DEFAULT_PUBLIC_REPLIES = [
  "¡Listo! Te lo mandé por DM ☕",
  "¡Va! Revisa tus mensajes 📩",
  "Te escribimos por DM 🙌",
  "¡Hecho! Checa tu bandeja de mensajes ☕",
  "Ya te llegó por DM, que lo disfrutes 🙌",
];

export function pickPublicReply(k: Keyword, rand = Math.random): string {
  const pool = (k.public_replies?.filter(Boolean).length ? k.public_replies!.filter(Boolean) : null) ??
    (k.public_reply ? [k.public_reply] : DEFAULT_PUBLIC_REPLIES);
  return pool[Math.floor(rand() * pool.length)];
}

// ---------- Ventanas de tiempo ----------

const H = 60 * 60 * 1000;

/** ¿Sigue abierta la ventana de 24 h de Meta para escribirle a este contacto? */
export function within24h(lastInboundAt: string | null, now = Date.now()): boolean {
  if (!lastInboundAt) return false;
  return now - new Date(lastInboundAt).getTime() < 24 * H - 5 * 60 * 1000; // margen de 5 min
}

/** ¿Toca mandar el seguimiento? Entre 21 h y 23.5 h desde el último mensaje de la persona. */
export function inFollowupSlot(lastInboundAt: string | null, now = Date.now()): boolean {
  if (!lastInboundAt) return false;
  const elapsed = now - new Date(lastInboundAt).getTime();
  return elapsed >= 21 * H && elapsed < 23.5 * H;
}

// ---------- Copys (edítalos a gusto) ----------

export const copy = {
  askEmail: (r: Resource, privacyUrl?: string) =>
    `¡Hola! ☕ Con gusto te comparto *${r.title}*.\n\n` +
    (r.description ? `${r.description}\n\n` : "") +
    `¿A qué correo te la mando? Así también te llegan nuestras guías nuevas para cafeterías (te das de baja cuando quieras).` +
    (privacyUrl ? `\n\nAviso de privacidad: ${privacyUrl}` : ""),

  askFollow: (r: Resource) =>
    `¡Hola! ☕ *${r.title}* es exclusiva para nuestra comunidad.\n\n` +
    `Síguenos en Instagram y toca *Ya te sigo* (o escribe LISTO) para mandártela.`,

  notFollowingYet: () =>
    `Todavía no me aparece que nos sigas 🤔 Dale seguir a la cuenta y vuelve a tocar *Ya te sigo*.`,

  deliverText: (r: Resource, link: string) =>
    `¡Aquí está! 👇\n\n*${r.title}*\n${link}`,

  cardButton: "Abrir 📥",

  thanksEmail: (email: string) =>
    `Perfecto, quedaste registrado con ${email}. Bienvenido a la comunidad RUSH ☕`,

  invalidEmail: () =>
    `Mmm, no me salió un correo válido. ¿Me lo escribes de nuevo? (ej. nombre@correo.com)`,

  skipEmail: () => `Sin problema 👌`,

  stop: () => `Listo, no te volveremos a escribir. Si cambias de opinión, solo mándanos un mensaje.`,

  handoff: () => `Va, le aviso al equipo de RUSH y te contestan por aquí en cuanto puedan 🙌`,

  followup: (r: Resource) =>
    `¡Hola! ¿Te sirvió *${r.title}*? Nos ayuda mucho saberlo para las próximas guías ☕`,

  feedback: {
    util: () => `¡Qué gusto! 🙌 Si te late, compártela con alguien que tenga cafetería. Pronto vienen más.`,
    otra: () => `¡Claro! Elige la que quieras:`,
    duda: () => `Cuéntame tu duda por aquí y alguien del equipo te contesta 💬`,
  },
};

/** Link con tracking de clic: {base}/r/{slug}?c={contactId} */
export function trackedLink(baseUrl: string, slug: string, contactId: string): string {
  return `${baseUrl.replace(/\/$/, "")}/r/${encodeURIComponent(slug)}?c=${encodeURIComponent(contactId)}`;
}

/** Tarjeta (generic template) con imagen opcional y botón al recurso. */
export function resourceCard(r: Resource, link: string) {
  return {
    attachment: {
      type: "template",
      payload: {
        template_type: "generic",
        elements: [{
          title: r.title.slice(0, 80),
          ...(r.description ? { subtitle: r.description.slice(0, 80) } : {}),
          ...(r.image_url ? { image_url: r.image_url } : {}),
          default_action: { type: "web_url", url: link },
          buttons: [{ type: "web_url", url: link, title: copy.cardButton }],
        }],
      },
    },
  };
}

/** "Guía de Prompts para Cafeterías" → "guia-de-prompts-para-cafeterias" */
export function slugify(text: string): string {
  return normalize(text).replace(/[^a-z0-9\s-]/g, "").trim().replace(/\s+/g, "-").replace(/-+/g, "-").slice(0, 60);
}

/** Extrae el shortcode de un link de Instagram (/p/, /reel/, /tv/). */
export function igShortcode(url: string): string | null {
  const m = url.match(/instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/** Verifica X-Hub-Signature-256 (HMAC-SHA256 del body crudo con el App Secret). */
export async function verifySignature(rawBody: string, header: string | null, appSecret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return safeEqual(header.slice(7), hex);
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
