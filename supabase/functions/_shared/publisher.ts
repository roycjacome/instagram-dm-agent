// Motor de publicación en Instagram: contenedores, espera de video, publicación,
// primer comentario y palabra clave del bot ligada al post recién publicado.
// Sin dependencias de Deno/Supabase: recibe Store y Graph, se prueba en memoria.

import { localTime, normalizeMedia, parseSchedule, validatePost } from "./publish_logic.ts";
import type { MediaItem, PostInput, PostKind } from "./publish_logic.ts";

export type PostStatus = "draft" | "scheduled" | "processing" | "publishing" | "published" | "failed" | "canceled";

export type Post = {
  id: string;
  kind: PostKind;
  caption: string | null;
  media: MediaItem[];
  cover_url: string | null;
  share_to_feed: boolean;
  first_comment: string | null;
  scheduled_at: string;
  status: PostStatus;
  container_id: string | null;
  children_ids: string[];
  ig_media_id: string | null;
  permalink: string | null;
  error: string | null;
  attempts: number;
  keyword: string | null;
  resource_slug: string | null;
  public_replies: string[];
  created_by: string;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

export interface PublishStore {
  insertPost(row: Partial<Post>): Promise<Post>;
  getPost(id: string): Promise<Post | null>;
  updatePost(id: string, patch: Partial<Post>): Promise<void>;
  /** Cambia el estado solo si sigue en `from` (evita doble publicación entre corridas). */
  claim(id: string, from: PostStatus, to: PostStatus): Promise<boolean>;
  listPosts(filter: { status?: PostStatus[]; from?: string; to?: string; limit?: number }): Promise<Post[]>;
  resourceExists(slug: string): Promise<boolean>;
  linkKeyword(args: { keyword: string; resourceSlug: string; mediaId: string; publicReplies: string[] }): Promise<void>;
}

export type ContainerStatus = "FINISHED" | "IN_PROGRESS" | "ERROR" | "EXPIRED" | "PUBLISHED";

export interface PublishGraph {
  createContainer(params: Record<string, unknown>): Promise<string>;      // devuelve container id
  containerStatus(id: string): Promise<{ status: ContainerStatus; detail?: string }>;
  publish(creationId: string): Promise<string>;                           // devuelve media id
  permalink(mediaId: string): Promise<string | null>;
  comment(mediaId: string, text: string): Promise<void>;
  publishingLimit(): Promise<{ usage: number; total: number } | null>;
}

export type PublisherConfig = { now?: () => number; tzOffset?: string; maxAttempts?: number };

export class ValidationError extends Error {
  errors: string[];
  constructor(errors: string[]) {
    super(errors.join(" "));
    this.errors = errors;
  }
}

export function createPublisher(store: PublishStore, graph: PublishGraph, cfg: PublisherConfig = {}) {
  const now = () => (cfg.now ? cfg.now() : Date.now());
  const maxAttempts = cfg.maxAttempts ?? 3;
  const nowIso = () => new Date(now()).toISOString();

  /** Resumen legible para Claude/Grok. */
  function view(p: Post) {
    return {
      id: p.id, tipo: p.kind, estado: p.status,
      programado: `${localTime(p.scheduled_at)} (hora Rush)`,
      caption: p.caption ? (p.caption.length > 120 ? p.caption.slice(0, 120) + "…" : p.caption) : null,
      medios: p.media.length, link: p.permalink, error: p.error,
      palabra_clave: p.keyword ? `${p.keyword.toUpperCase()} → ${p.resource_slug}` : null,
      creado_por: p.created_by,
    };
  }

  async function createPost(input: PostInput, createdBy: string) {
    const errors = validatePost(input);
    if (input.resource_slug && !(await store.resourceExists(input.resource_slug))) {
      errors.push(`No existe el recurso "${input.resource_slug}".`);
    }
    let when = new Date(now());
    try {
      when = parseSchedule(input.scheduled_at, now(), cfg.tzOffset);
      if (when.getTime() < now() - 5 * 60e3) errors.push("La fecha programada ya pasó.");
      if (when.getTime() > now() + 75 * 864e5) errors.push("Se puede programar hasta 75 días adelante.");
    } catch (e) {
      errors.push((e as Error).message);
    }
    if (errors.length) throw new ValidationError(errors);

    const post = await store.insertPost({
      kind: input.kind,
      caption: input.caption ?? null,
      media: normalizeMedia(input.media),
      cover_url: input.cover_url ?? null,
      share_to_feed: input.share_to_feed ?? true,
      first_comment: input.first_comment ?? null,
      scheduled_at: when.toISOString(),
      status: input.draft ? "draft" : "scheduled",
      keyword: input.keyword ? input.keyword.trim().toLowerCase() : null,
      resource_slug: input.resource_slug ?? null,
      public_replies: (input.public_replies ?? []).filter(Boolean),
      created_by: createdBy,
    });
    // Si es para ya, avanzamos en el momento (las imágenes salen en esta misma llamada).
    if (post.status === "scheduled" && when.getTime() <= now()) await step(post.id);
    return view((await store.getPost(post.id))!);
  }

  // ---------- pasos de la máquina de estados ----------

  /** scheduled → processing: crea los contenedores en Instagram. */
  async function createContainers(p: Post) {
    if (!(await store.claim(p.id, "scheduled", "processing"))) return;
    try {
      const children: string[] = [];
      let containerId: string;
      if (p.kind === "carousel") {
        for (const m of p.media) {
          children.push(await graph.createContainer(
            m.type === "video"
              ? { media_type: "VIDEO", video_url: m.url, is_carousel_item: true }
              : { image_url: m.url, is_carousel_item: true },
          ));
        }
        containerId = await graph.createContainer({ media_type: "CAROUSEL", children: children.join(","), caption: p.caption ?? "" });
      } else if (p.kind === "reel") {
        containerId = await graph.createContainer({
          media_type: "REELS", video_url: p.media[0].url, caption: p.caption ?? "",
          share_to_feed: p.share_to_feed, ...(p.cover_url ? { cover_url: p.cover_url } : {}),
        });
      } else if (p.kind === "story") {
        const m = p.media[0];
        containerId = await graph.createContainer(
          m.type === "video" ? { media_type: "STORIES", video_url: m.url } : { media_type: "STORIES", image_url: m.url },
        );
      } else {
        containerId = await graph.createContainer({ image_url: p.media[0].url, caption: p.caption ?? "" });
      }
      await store.updatePost(p.id, { container_id: containerId, children_ids: children, error: null });
    } catch (e) {
      await fail(p, `No se pudo preparar en Instagram: ${(e as Error).message}`);
    }
  }

  /** processing → published: espera a que Instagram procese y publica. */
  async function tryPublish(p: Post) {
    if (!p.container_id) return;
    try {
      // En carruseles con video, cada hijo también tiene que terminar de procesarse.
      for (const id of [...p.children_ids, p.container_id]) {
        const s = await graph.containerStatus(id);
        if (s.status === "PUBLISHED" && id === p.container_id) {
          // Ya salió (p. ej. un intento previo publicó pero se cortó la respuesta): no duplicar.
          await store.updatePost(p.id, { status: "published", published_at: nowIso(), error: null });
          return;
        }
        if (s.status === "IN_PROGRESS") return; // siguiente corrida
        if (s.status === "ERROR" || s.status === "EXPIRED") {
          return await fail(p, `Instagram rechazó el medio (${s.status}${s.detail ? ": " + s.detail : ""}).`, true);
        }
      }
      if (!(await store.claim(p.id, "processing", "publishing"))) return;
      const mediaId = await graph.publish(p.container_id);
      const permalink = await graph.permalink(mediaId).catch(() => null);
      await store.updatePost(p.id, {
        status: "published", ig_media_id: mediaId, permalink, published_at: nowIso(), error: null,
      });
      // Extras: no deben tumbar una publicación que ya salió.
      if (p.first_comment) await graph.comment(mediaId, p.first_comment).catch((e) => console.error("first_comment", e));
      if (p.keyword && p.resource_slug) {
        await store.linkKeyword({
          keyword: p.keyword, resourceSlug: p.resource_slug, mediaId, publicReplies: p.public_replies,
        }).catch((e) => console.error("linkKeyword", e));
      }
    } catch (e) {
      // Volvemos a 'processing' para reintentar en la siguiente corrida.
      await store.updatePost(p.id, { status: "processing" });
      await fail(p, `Error al publicar: ${(e as Error).message}`);
    }
  }

  /** Cuenta un intento fallido; tras maxAttempts (o si es definitivo) queda en 'failed'. */
  async function fail(p: Post, message: string, final = false) {
    const attempts = p.attempts + 1;
    const giveUp = final || attempts >= maxAttempts;
    await store.updatePost(p.id, {
      attempts, error: message,
      status: giveUp ? "failed" : p.container_id ? "processing" : "scheduled",
    });
  }

  async function step(id: string) {
    let p = await store.getPost(id);
    if (!p) return;
    if (p.status === "scheduled") {
      await createContainers(p);
      p = (await store.getPost(id))!;
    }
    if (p.status === "processing") await tryPublish(p);
  }

  /** Corre cada minuto (pg_cron): publica lo que ya toca y avanza lo que está procesando. */
  async function processQueue() {
    const due = await store.listPosts({ status: ["scheduled"], to: nowIso(), limit: 10 });
    const processing = await store.listPosts({ status: ["processing"], limit: 20 });
    // Contenedores de más de 23 h caducan en Instagram: los damos por fallidos.
    const alive = [];
    for (const p of processing) {
      if (now() - new Date(p.updated_at).getTime() > 23 * 3600e3) {
        await fail(p, "El contenedor caducó en Instagram (más de 24 h).", true);
      } else alive.push(p);
    }
    const ids = [...new Set([...due, ...alive].map((p) => p.id))];
    for (const id of ids) await step(id).catch((e) => console.error("step", id, e));
    return { revisadas: ids.length };
  }

  async function publishNow(id: string) {
    const p = await store.getPost(id);
    if (!p) throw new Error("No existe esa publicación.");
    if (!["draft", "scheduled", "failed"].includes(p.status)) throw new Error(`No se puede publicar en estado ${p.status}.`);
    await store.updatePost(id, {
      status: "scheduled", scheduled_at: nowIso(), attempts: 0, error: null,
      ...(p.status === "failed" ? { container_id: null, children_ids: [] } : {}),
    });
    await step(id);
    return view((await store.getPost(id))!);
  }

  async function reschedule(id: string, when: string) {
    const p = await store.getPost(id);
    if (!p) throw new Error("No existe esa publicación.");
    if (!["draft", "scheduled"].includes(p.status)) throw new Error(`No se puede reprogramar en estado ${p.status}.`);
    const d = parseSchedule(when, now(), cfg.tzOffset);
    if (d.getTime() < now()) throw new Error("La nueva fecha ya pasó; usa publicar ahora.");
    await store.updatePost(id, { scheduled_at: d.toISOString(), status: "scheduled" });
    return view((await store.getPost(id))!);
  }

  async function cancel(id: string) {
    const p = await store.getPost(id);
    if (!p) throw new Error("No existe esa publicación.");
    if (!["draft", "scheduled", "failed"].includes(p.status)) {
      throw new Error(p.status === "published" ? "Ya se publicó; bórrala desde la app de Instagram." : `No se puede cancelar en estado ${p.status}.`);
    }
    await store.updatePost(id, { status: "canceled" });
    return view({ ...p, status: "canceled" });
  }

  async function calendar(opts: { days?: number; includePast?: boolean } = {}) {
    const days = opts.days ?? 14;
    const from = opts.includePast ? new Date(now() - days * 864e5).toISOString() : undefined;
    const to = new Date(now() + days * 864e5).toISOString();
    const rows = await store.listPosts({
      status: opts.includePast
        ? ["draft", "scheduled", "processing", "publishing", "published", "failed"]
        : ["draft", "scheduled", "processing", "publishing", "failed"],
      from, to, limit: 100,
    });
    return rows.map(view);
  }

  async function limits() {
    const l = await graph.publishingLimit();
    return l ? { usadas_24h: l.usage, limite_24h: l.total, disponibles: Math.max(0, l.total - l.usage) } : null;
  }

  return { createPost, processQueue, publishNow, reschedule, cancel, calendar, limits, get: async (id: string) => {
    const p = await store.getPost(id);
    return p ? view(p) : null;
  } };
}
