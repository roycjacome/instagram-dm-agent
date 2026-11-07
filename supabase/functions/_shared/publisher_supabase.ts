// Implementaciones reales del motor de publicación: Supabase (datos y Storage) + API de Instagram.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { ContainerStatus, Post, PublishGraph, PublishStore } from "./publisher.ts";
import { checkMime, directDownloadUrl, MIME_EXT } from "./publish_logic.ts";
import { normalize } from "./logic.ts";
import { DEFAULT_PUBLIC_REPLIES } from "./logic.ts";

export function publishStore(db: SupabaseClient<any, any, any>): PublishStore {
  const must = <T>(r: { data: T | null; error: any }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data as T;
  };
  return {
    async insertPost(row) {
      return must(await db.from("posts").insert(row).select("*").single()) as Post;
    },
    async getPost(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { data } = await db.from("posts").select("*").eq("id", id).maybeSingle();
      return data as Post | null;
    },
    async updatePost(id, patch) {
      must(await db.from("posts").update(patch).eq("id", id));
    },
    async claim(id, from, to) {
      const { data } = await db.from("posts").update({ status: to }).eq("id", id).eq("status", from).select("id");
      return !!data?.length;
    },
    async listPosts({ status, from, to, limit = 50 }) {
      let q = db.from("posts").select("*").order("scheduled_at", { ascending: true }).limit(limit);
      if (status?.length) q = q.in("status", status);
      if (from) q = q.gte("scheduled_at", from);
      if (to) q = q.lte("scheduled_at", to);
      return (must(await q) ?? []) as Post[];
    },
    async resourceExists(slug) {
      const { data } = await db.from("resources").select("id").eq("slug", slug).maybeSingle();
      return !!data;
    },
    async linkKeyword({ keyword, resourceSlug, mediaId, publicReplies }) {
      const { data: r } = await db.from("resources").select("id").eq("slug", resourceSlug).maybeSingle();
      if (!r) throw new Error(`Recurso ${resourceSlug} no existe`);
      const replies = publicReplies.length ? publicReplies : DEFAULT_PUBLIC_REPLIES;
      must(await db.from("keywords").insert({
        keyword: normalize(keyword), resource_id: r.id, channel: "comment", media_id: mediaId,
        public_replies: replies, public_reply: replies[0], active: true,
      }));
    },
  };
}

export function publishGraph(opts: { base: string; igUserId: string; token: () => Promise<string> }): PublishGraph {
  async function call(method: "GET" | "POST", path: string, body?: Record<string, unknown>) {
    const res = await fetch(`${opts.base}/${path}`, {
      method,
      headers: { Authorization: `Bearer ${await opts.token()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error?.error_user_msg ?? json?.error?.message ?? `HTTP ${res.status}`);
    return json;
  }
  return {
    async createContainer(params) {
      return (await call("POST", `${opts.igUserId}/media`, params)).id;
    },
    async containerStatus(id) {
      const j = await call("GET", `${id}?fields=status_code,status`);
      return { status: (j.status_code ?? "IN_PROGRESS") as ContainerStatus, detail: j.status };
    },
    async publish(creationId) {
      return (await call("POST", `${opts.igUserId}/media_publish`, { creation_id: creationId })).id;
    },
    async permalink(mediaId) {
      return (await call("GET", `${mediaId}?fields=permalink`)).permalink ?? null;
    },
    async comment(mediaId, text) {
      await call("POST", `${mediaId}/comments`, { message: text });
    },
    async publishingLimit() {
      const j = await call("GET", `${opts.igUserId}/content_publishing_limit?fields=quota_usage,config`);
      const d = j.data?.[0];
      return d ? { usage: d.quota_usage ?? 0, total: d.config?.quota_total ?? 0 } : null;
    },
  };
}

/** Sube archivos al bucket público que Instagram puede descargar. */
export function mediaStorage(opts: { supabaseUrl: string; serviceKey: string; bucket?: string; maxBytes?: number }) {
  const bucket = opts.bucket ?? "ig-media";
  const maxBytes = opts.maxBytes ?? 100 * 1024 * 1024;
  const base = opts.supabaseUrl.replace(/\/$/, "");

  async function store(bytes: Uint8Array, contentType: string, hint = "medio") {
    const check = checkMime(contentType);
    if (!check.ok) throw new Error(check.error);
    if (bytes.byteLength > maxBytes) throw new Error(`Archivo de ${(bytes.byteLength / 1048576).toFixed(1)} MB; máximo ${maxBytes / 1048576} MB.`);
    if (bytes.byteLength < 1024) throw new Error("El archivo está vacío o no es válido.");
    const d = new Date();
    const safe = normalize(hint).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "medio";
    const path = `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${safe}-${crypto.randomUUID().slice(0, 8)}.${MIME_EXT[check.mime]}`;
    const res = await fetch(`${base}/storage/v1/object/${bucket}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.serviceKey}`, "Content-Type": check.mime, "x-upsert": "false" },
      body: bytes as Uint8Array<ArrayBuffer>,
    });
    if (!res.ok) throw new Error(`Storage: ${res.status} ${await res.text()}`);
    return { url: `${base}/storage/v1/object/public/${bucket}/${path}`, type: check.type!, mime: check.mime, bytes: bytes.byteLength };
  }

  return {
    store,
    /** Descarga un link (Drive, Dropbox, web) y lo deja en una URL pública directa. */
    async importFromUrl(url: string) {
      if (!/^https?:\/\//.test(url)) throw new Error("URL no válida.");
      const direct = directDownloadUrl(url);
      const res = await fetch(direct, { redirect: "follow" });
      if (!res.ok) throw new Error(`No se pudo descargar (${res.status}). Revisa que el link sea público.`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > maxBytes) throw new Error(`Archivo de ${(len / 1048576).toFixed(1)} MB; máximo ${maxBytes / 1048576} MB.`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const name = decodeURIComponent(new URL(direct).pathname.split("/").pop() ?? "medio").replace(/\.[a-z0-9]+$/i, "");
      return store(bytes, res.headers.get("content-type") ?? "", name);
    },
  };
}
