// Reglas de publicación de Instagram (lógica pura, sin dependencias).

export type PostKind = "image" | "carousel" | "reel" | "story";
export type MediaItem = { url: string; type: "image" | "video" };

export type PostInput = {
  kind: PostKind;
  caption?: string | null;
  media: (MediaItem | string)[];
  cover_url?: string | null;
  share_to_feed?: boolean;
  first_comment?: string | null;
  scheduled_at?: string | null;     // ISO; sin zona = hora local de Rush
  draft?: boolean;
  keyword?: string | null;
  resource_slug?: string | null;
  public_replies?: string[] | null;
};

const VIDEO_EXT = /\.(mp4|mov|m4v)(\?|#|$)/i;

/** Acepta "https://…/foto.jpg" o {url, type}; infiere el tipo por extensión. */
export function normalizeMedia(items: (MediaItem | string)[]): MediaItem[] {
  return (items ?? []).map((m) => {
    if (typeof m === "string") return { url: m.trim(), type: VIDEO_EXT.test(m) ? "video" : "image" };
    return { url: m.url.trim(), type: m.type ?? (VIDEO_EXT.test(m.url) ? "video" : "image") };
  });
}

export const LIMITS = { caption: 2200, hashtags: 30, mentions: 20, carouselMin: 2, carouselMax: 10 };

export const countHashtags = (t: string) => (t.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
export const countMentions = (t: string) => (t.match(/(^|\s)@[\w.]+/g) ?? []).length;

/** Devuelve la lista de errores (vacía si la publicación es válida). */
export function validatePost(input: PostInput): string[] {
  const errors: string[] = [];
  const media = normalizeMedia(input.media);
  const caption = input.caption ?? "";
  const imgs = media.filter((m) => m.type === "image").length;
  const vids = media.filter((m) => m.type === "video").length;

  if (!["image", "carousel", "reel", "story"].includes(input.kind)) errors.push(`Tipo no válido: ${input.kind}`);
  for (const m of media) {
    if (!/^https:\/\//.test(m.url)) errors.push(`El medio debe ser una URL https pública: ${m.url}`);
    if (/\.(png|webp|heic|heif|gif)(\?|#|$)/i.test(m.url)) errors.push(`Instagram solo acepta JPG para imágenes: ${m.url}`);
  }

  if (input.kind === "image" && !(media.length === 1 && imgs === 1)) errors.push("Un post de imagen lleva exactamente 1 imagen.");
  if (input.kind === "reel" && !(media.length === 1 && vids === 1)) errors.push("Un reel lleva exactamente 1 video.");
  if (input.kind === "story" && media.length !== 1) errors.push("Una historia lleva exactamente 1 imagen o video.");
  if (input.kind === "carousel" && (media.length < LIMITS.carouselMin || media.length > LIMITS.carouselMax)) {
    errors.push(`Un carrusel lleva de ${LIMITS.carouselMin} a ${LIMITS.carouselMax} imágenes o videos.`);
  }
  if (input.kind === "story" && caption) errors.push("Las historias no llevan caption por API; quítalo o usa un post.");
  if (caption.length > LIMITS.caption) errors.push(`Caption de ${caption.length} caracteres (máx. ${LIMITS.caption}).`);
  if (countHashtags(caption) > LIMITS.hashtags) errors.push(`Máximo ${LIMITS.hashtags} hashtags.`);
  if (countMentions(caption) > LIMITS.mentions) errors.push(`Máximo ${LIMITS.mentions} menciones.`);
  if (input.cover_url && input.kind !== "reel") errors.push("cover_url solo aplica a reels.");
  if (input.cover_url && !/^https:\/\//.test(input.cover_url)) errors.push("cover_url debe ser https.");
  if (input.first_comment && input.kind === "story") errors.push("Las historias no admiten comentarios.");
  if (input.keyword && input.kind === "story") errors.push("La palabra clave por comentario no aplica a historias.");
  if (input.keyword && !input.resource_slug) errors.push("Si pones palabra clave, indica el recurso que entrega.");
  return errors;
}

/**
 * Interpreta la fecha de programación. Sin zona horaria se toma como hora local de Rush
 * (Mérida/Carmen, UTC-6 todo el año). Vacío = ahora.
 */
export function parseSchedule(value: string | null | undefined, now: number, tzOffset = "-06:00"): Date {
  if (!value) return new Date(now);
  const v = value.trim().replace(" ", "T");
  const hasZone = /([zZ]|[+-]\d{2}:?\d{2})$/.test(v);
  const withTime = /T\d{2}:\d{2}/.test(v) ? v : `${v}T09:00`;
  const d = new Date(hasZone ? withTime : `${withTime}${withTime.length === 16 ? ":00" : ""}${tzOffset}`);
  if (isNaN(d.getTime())) throw new Error(`Fecha no válida: "${value}". Usa 2026-10-28 18:30 o ISO.`);
  return d;
}

/** Formatea en hora local de Rush para mostrarla en respuestas. */
export function localTime(iso: string, tzOffsetHours = -6): string {
  const d = new Date(new Date(iso).getTime() + tzOffsetHours * 3600e3);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

/** Convierte links de compartir de Google Drive en link de descarga directa. */
export function directDownloadUrl(url: string): string {
  const m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:export=download&)?id=)([A-Za-z0-9_-]+)/);
  if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
  const dbx = url.match(/^https:\/\/www\.dropbox\.com\/(.+?)(\?.*)?$/);
  if (dbx) return `https://dl.dropboxusercontent.com/${dbx[1]}`;
  return url;
}

export const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

/** Instagram solo acepta JPEG para imágenes; MP4/MOV para video. */
export function checkMime(contentType: string | null): { ok: boolean; mime: string; type?: "image" | "video"; error?: string } {
  const mime = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (mime === "image/jpeg" || mime === "image/jpg") return { ok: true, mime: "image/jpeg", type: "image" };
  if (mime === "video/mp4" || mime === "video/quicktime") return { ok: true, mime, type: "video" };
  if (mime.startsWith("image/")) {
    return { ok: false, mime, error: `Instagram solo acepta JPEG; este archivo es ${mime}. Expórtalo como .jpg.` };
  }
  if (mime === "text/html") {
    return { ok: false, mime, error: "El link devolvió una página web, no el archivo. Si es de Drive, compártelo como 'cualquiera con el link'." };
  }
  return { ok: false, mime, error: `Formato no soportado: ${mime || "desconocido"}. Usa JPG, MP4 o MOV.` };
}
