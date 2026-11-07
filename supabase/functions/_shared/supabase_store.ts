// Implementación del Store y del cliente Graph sobre Supabase + API de Instagram.

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type { Contact, Delivery, Graph, Recipient, Store } from "./bot.ts";
import type { Keyword, Resource } from "./logic.ts";

const RESOURCE_COLS = "id,slug,title,description,url,requires_email,requires_follow,image_url,dm_text,once_per_contact,active";

export function supabaseStore(db: SupabaseClient<any, any, any>): Store {
  const must = <T>(r: { data: T | null; error: any }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data as T;
  };

  return {
    async loadCatalog() {
      const [k, r] = await Promise.all([
        db.from("keywords").select("keyword,resource_id,channel,media_id,public_reply,public_replies").eq("active", true),
        db.from("resources").select(RESOURCE_COLS).eq("active", true).order("created_at"),
      ]);
      return { keywords: (must(k) ?? []) as Keyword[], resources: (must(r) ?? []) as Resource[] };
    },
    async getSetting(key) {
      const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
      return (data?.value ?? null) as any;
    },
    async firstTime(id, kind, payload) {
      const { error } = await db.from("events").insert({ id, kind, payload });
      return !error; // choque de llave primaria = reintento de Meta
    },
    async getContactByIgsid(igsid) {
      const { data } = await db.from("contacts").select("*").eq("igsid", igsid).maybeSingle();
      return data as Contact | null;
    },
    async insertContact(row) {
      return must(await db.from("contacts").insert(row).select("*").single()) as Contact;
    },
    async updateContact(id, patch) {
      must(await db.from("contacts").update(patch).eq("id", id));
    },
    async getResourceBySlug(slug) {
      const { data } = await db.from("resources").select(RESOURCE_COLS).eq("slug", slug).maybeSingle();
      return data as any;
    },
    async getResourceById(id) {
      const { data } = await db.from("resources").select(RESOURCE_COLS).eq("id", id).maybeSingle();
      return data as Resource | null;
    },
    async insertDelivery(row) {
      return must(await db.from("deliveries").insert(row).select("id,contact_id,resource_id,created_at").single()) as Delivery;
    },
    async hasDelivery(contactId, resourceId) {
      const { data } = await db.from("deliveries").select("id")
        .eq("contact_id", contactId).eq("resource_id", resourceId).limit(1);
      return !!data?.length;
    },
    async getDelivery(id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
      const { data } = await db.from("deliveries").select("id,contact_id,resource_id,created_at,feedback").eq("id", id).maybeSingle();
      return data as Delivery | null;
    },
    async updateDelivery(id, patch) {
      must(await db.from("deliveries").update(patch).eq("id", id));
    },
    async markClicked(contactId, resourceId) {
      const { data: d } = await db.from("deliveries").select("id")
        .eq("contact_id", contactId).eq("resource_id", resourceId).is("clicked_at", null)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (d) await db.from("deliveries").update({ clicked_at: new Date().toISOString() }).eq("id", d.id);
    },
    async pendingFollowups(fromIso, toIso) {
      const rows = must(await db.from("deliveries")
        .select("id,contact_id,resource_id,created_at,feedback,contact:contacts!inner(*)")
        .is("followup_sent_at", null).gte("created_at", fromIso).lte("created_at", toIso)
        .not("contact.last_inbound_at", "is", null).limit(500)) as any[];
      return rows ?? [];
    },
    async markFollowupSent(contactId, atIso) {
      must(await db.from("deliveries").update({ followup_sent_at: atIso })
        .eq("contact_id", contactId).is("followup_sent_at", null));
    },
  };
}

export function instagramGraph(opts: { base: string; igUserId: string; token: () => Promise<string> }): Graph {
  const hdrs = async () => ({ "Content-Type": "application/json", Authorization: `Bearer ${await opts.token()}` });
  async function post(path: string, body: unknown) {
    const res = await fetch(`${opts.base}/${path}`, { method: "POST", headers: await hdrs(), body: JSON.stringify(body) });
    if (!res.ok) console.error("Graph error", path, res.status, await res.text());
    return res.ok;
  }
  return {
    send: (recipient: Recipient, message) => post(`${opts.igUserId}/messages`, { recipient, message }),
    replyComment: (commentId, text) => post(`${commentId}/replies`, { message: text }),
    async getProfile(igsid, fields) {
      try {
        const res = await fetch(`${opts.base}/${igsid}?fields=${encodeURIComponent(fields)}`, { headers: await hdrs() });
        return res.ok ? await res.json() : null;
      } catch {
        return null;
      }
    },
  };
}
