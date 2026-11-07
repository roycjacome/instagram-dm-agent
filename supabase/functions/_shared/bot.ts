// Motor del bot: flujos de comentarios, DMs, historias, botones y seguimiento.
// Sin dependencias de Deno ni Supabase: recibe un Store y un cliente Graph,
// así se puede probar completo con dobles en memoria.

import {
  copy, extractEmail, inFollowupSlot, isFollowDone, isSkipEmail, isStop, matchKeyword, menuQuickReplies,
  parsePayload, pickPublicReply, qr, resourceCard, trackedLink, wantsHuman,
} from "./logic.ts";
import type { Channel, Intent, Keyword, QuickReply, Resource } from "./logic.ts";

export type ContactState = "idle" | "awaiting_email" | "awaiting_follow" | "handoff";

export type Contact = {
  id: string;
  igsid: string;
  username: string | null;
  email: string | null;
  newsletter_optin: boolean;
  state: ContactState;
  pending_resource_id: string | null;
  tags: string[];
  last_inbound_at: string | null;
};

export type Delivery = { id: string; contact_id: string; resource_id: string; created_at: string; feedback?: string | null };

export interface Store {
  loadCatalog(): Promise<{ keywords: Keyword[]; resources: Resource[] }>;
  getSetting<T = any>(key: string): Promise<T | null>;
  firstTime(id: string, kind: string, payload: unknown): Promise<boolean>;
  getContactByIgsid(igsid: string): Promise<Contact | null>;
  insertContact(row: Partial<Contact> & { igsid: string }): Promise<Contact>;
  updateContact(id: string, patch: Partial<Contact> & Record<string, unknown>): Promise<void>;
  getResourceBySlug(slug: string): Promise<(Resource & { active?: boolean }) | null>;
  getResourceById(id: string): Promise<Resource | null>;
  insertDelivery(row: { contact_id: string; resource_id: string; source: string }): Promise<Delivery>;
  hasDelivery(contactId: string, resourceId: string): Promise<boolean>;
  getDelivery(id: string): Promise<Delivery | null>;
  updateDelivery(id: string, patch: Record<string, unknown>): Promise<void>;
  markClicked(contactId: string, resourceId: string): Promise<void>;
  /** Entregas sin seguimiento, creadas entre `from` y `to`, de contactos activos. */
  pendingFollowups(fromIso: string, toIso: string): Promise<Array<Delivery & { contact: Contact }>>;
  markFollowupSent(contactId: string, atIso: string): Promise<void>;
}

export type Recipient = { id: string } | { comment_id: string };

export interface Graph {
  send(recipient: Recipient, message: Record<string, unknown>): Promise<boolean>;
  replyComment(commentId: string, text: string): Promise<boolean>;
  getProfile(igsid: string, fields: string): Promise<Record<string, any> | null>;
}

export type BotConfig = {
  igUserId: string;
  publicBaseUrl: string;
  privacyUrl?: string;
  menuMode?: "first_contact" | "off";
  notify?: (payload: Record<string, unknown>) => Promise<void>;
  newsletter?: (payload: Record<string, unknown>) => Promise<void>;
  now?: () => number;
};

export function createBot(store: Store, graph: Graph, cfg: BotConfig) {
  const now = () => (cfg.now ? cfg.now() : Date.now());
  const iso = () => new Date(now()).toISOString();
  const notify = (p: Record<string, unknown>) => (cfg.notify ? cfg.notify(p) : Promise.resolve());

  // ---------- envío ----------

  /** Intenta el mensaje enriquecido; si Meta lo rechaza, manda el texto plano. */
  async function sendRich(to: Recipient, message: Record<string, unknown>, fallbackText?: string) {
    const ok = await graph.send(to, message);
    if (!ok && fallbackText) return graph.send(to, { text: fallbackText });
    return ok;
  }

  const sendText = (to: Recipient, text: string) => graph.send(to, { text });
  const sendQR = (to: Recipient, text: string, quick_replies: QuickReply[]) =>
    sendRich(to, { text, quick_replies }, text);

  async function sendMenu(to: Recipient, text: string) {
    const { keywords, resources } = await store.loadCatalog();
    if (!resources.length) return;
    await sendQR(to, text, menuQuickReplies(resources, keywords));
  }

  // ---------- contactos ----------

  /** fromDm = true solo en DMs/botones: un comentario no abre la ventana de 24 h. */
  async function upsertContact(igsid: string, username?: string, fromDm = false) {
    const existing = await store.getContactByIgsid(igsid);
    if (!username && fromDm && !existing?.username) {
      username = (await graph.getProfile(igsid, "username"))?.username;
    }
    if (existing) {
      const patch: Partial<Contact> = fromDm ? { last_inbound_at: iso() } : {};
      if (username && username !== existing.username) patch.username = username;
      if (Object.keys(patch).length) await store.updateContact(existing.id, patch);
      return { contact: { ...existing, ...patch } as Contact, isNew: false };
    }
    const contact = await store.insertContact({ igsid, username: username ?? null, last_inbound_at: fromDm ? iso() : null });
    return { contact, isNew: true };
  }

  async function setContact(c: Contact, patch: Partial<Contact>) {
    Object.assign(c, patch);
    await store.updateContact(c.id, patch);
  }

  async function isFollower(igsid: string): Promise<boolean | null> {
    const p = await graph.getProfile(igsid, "is_user_follow_business");
    return p && typeof p.is_user_follow_business === "boolean" ? p.is_user_follow_business : null;
  }

  // ---------- recursos ----------

  /** Gate de seguidor → correo → entrega. */
  async function offerResource(c: Contact, r: Resource, to: Recipient, source: Channel) {
    if (r.once_per_contact && (await store.hasDelivery(c.id, r.id))) return; // ya lo recibió
    if (r.requires_follow) {
      const following = await isFollower(c.igsid);
      // Desde un comentario Meta a veces no deja leer el perfil: en ese caso pedimos seguir.
      if (following === false || (following === null && source === "comment")) {
        await setContact(c, { state: "awaiting_follow", pending_resource_id: r.id });
        await sendQR(to, copy.askFollow(r), [qr("✅ Ya te sigo", "FOLLOW_CHECK")]);
        return;
      }
    }
    await afterFollow(c, r, to, source);
  }

  async function afterFollow(c: Contact, r: Resource, to: Recipient, source: Channel) {
    if (r.requires_email && !c.email) {
      await setContact(c, { state: "awaiting_email", pending_resource_id: r.id });
      await sendQR(to, copy.askEmail(r, cfg.privacyUrl), [qr("Prefiero no darlo", "SKIP_EMAIL")]);
      return;
    }
    await deliver(c, r, to, source);
  }

  async function deliver(c: Contact, r: Resource, to: Recipient, source: Channel) {
    await setContact(c, { state: "idle", pending_resource_id: null });
    let ok: boolean;
    if (r.dm_text) {
      // campaña con texto y links exactos; {link} = link con tracking de aperturas
      const text = r.dm_text.includes("{link}")
        ? r.dm_text.replaceAll("{link}", trackedLink(cfg.publicBaseUrl, r.slug, c.id))
        : r.dm_text;
      ok = await sendText(to, text);
    } else {
      const link = trackedLink(cfg.publicBaseUrl, r.slug, c.id);
      ok = await sendRich(to, resourceCard(r, link), copy.deliverText(r, link));
    }
    // Solo cuenta como entregado si Instagram aceptó el DM (si falla, la persona puede reintentar).
    if (ok) await store.insertDelivery({ contact_id: c.id, resource_id: r.id, source }).catch(() => {});
  }

  async function pendingResource(c: Contact) {
    return c.pending_resource_id ? await store.getResourceById(c.pending_resource_id) : null;
  }

  async function handoff(c: Contact, to: Recipient, text: string, reason: string, message?: string) {
    await setContact(c, { state: "handoff", pending_resource_id: null });
    await sendText(to, text);
    await notify({
      type: "handoff", reason, username: c.username, igsid: c.igsid, text: message ?? null,
      inbox: "https://www.instagram.com/direct/inbox/",
    });
  }

  // ---------- intents de botones ----------

  async function handleIntent(c: Contact, intent: Intent, to: Recipient): Promise<boolean> {
    if (!intent) return false;
    switch (intent.type) {
      case "resource": {
        const r = await store.getResourceBySlug(intent.slug);
        if (r && r.active !== false) await offerResource(c, r, to, "dm");
        else await sendMenu(to, "Ese recurso ya no está disponible, pero tenemos estos:");
        return true;
      }
      case "skip_email": {
        const r = await pendingResource(c);
        if (!r) return false;
        await sendText(to, copy.skipEmail());
        await deliver(c, r, to, "dm");
        return true;
      }
      case "follow_check": {
        const r = await pendingResource(c);
        if (!r) return false;
        const following = await isFollower(c.igsid);
        if (following === false) {
          await sendQR(to, copy.notFollowingYet(), [qr("✅ Ya te sigo", "FOLLOW_CHECK")]);
          return true;
        }
        await afterFollow(c, r, to, "dm"); // true o no verificable → dejamos pasar
        return true;
      }
      case "human":
        await handoff(c, to, copy.handoff(), "boton");
        return true;
      case "menu": {
        const welcome = await store.getSetting<{ text: string }>("welcome");
        await sendMenu(to, welcome?.text ?? "Estos son nuestros recursos gratis:");
        return true;
      }
      case "feedback": {
        const d = await store.getDelivery(intent.deliveryId);
        if (!d || d.contact_id !== c.id) return false;
        await store.updateDelivery(d.id, { feedback: intent.value });
        if (intent.value === "util") await sendText(to, copy.feedback.util());
        if (intent.value === "otra") await sendMenu(to, copy.feedback.otra());
        if (intent.value === "duda") await handoff(c, to, copy.feedback.duda(), "duda_guia");
        return true;
      }
    }
  }

  // ---------- eventos ----------

  async function handleComment(value: any) {
    const commentId: string = value?.id;
    const from = value?.from;
    const text: string = value?.text ?? "";
    if (!commentId || !from?.id || from.id === cfg.igUserId) return; // ignora nuestros comentarios
    if (!(await store.firstTime(commentId, "comment", value))) return;

    const { keywords, resources } = await store.loadCatalog();
    const kw = matchKeyword(text, keywords, "comment", value?.media?.id);
    if (!kw) return;
    const r = resources.find((x) => x.id === kw.resource_id);
    if (!r) return;

    const { contact } = await upsertContact(from.id, from.username, false);
    if (contact.tags?.includes("stop")) return;
    // Campañas de "un DM por persona": si ya lo recibió, ni respuesta pública ni DM.
    if (r.once_per_contact && (await store.hasDelivery(contact.id, r.id))) return;

    await graph.replyComment(commentId, pickPublicReply(kw));
    // Respuesta privada: Meta permite 1 DM por comentario.
    await offerResource(contact, r, { comment_id: commentId }, "comment");
  }

  async function handleStoryMention(c: Contact, to: Recipient, url?: string) {
    const s = await store.getSetting<{ mode: string; resource_slug?: string | null; text?: string }>("story_mention");
    await notify({ type: "story_mention", username: c.username, igsid: c.igsid, url: url ?? null });
    if (!s || s.mode === "off" || c.tags?.includes("stop")) return;
    const text = s.text ?? "¡Gracias por mencionarnos! 🙌";
    if (s.mode === "resource" && s.resource_slug) {
      const r = await store.getResourceBySlug(s.resource_slug);
      if (r && r.active !== false) {
        await sendText(to, text);
        await offerResource(c, r, to, "story");
        return;
      }
    }
    await sendMenu(to, text);
  }

  async function handlePostback(ev: any) {
    const senderId: string = ev?.sender?.id;
    const pb = ev?.postback;
    if (!senderId || senderId === cfg.igUserId || !pb) return;
    if (pb.mid && !(await store.firstTime(pb.mid, "postback", ev))) return;
    const { contact } = await upsertContact(senderId, undefined, true);
    const handled = await handleIntent(contact, parsePayload(pb.payload), { id: senderId });
    if (!handled) await handleIntent(contact, { type: "menu" }, { id: senderId });
  }

  async function handleMessage(ev: any) {
    const msg = ev?.message;
    const senderId: string = ev?.sender?.id;
    if (!msg || msg.is_echo || !senderId || senderId === cfg.igUserId) return;
    if (msg.mid && !(await store.firstTime(msg.mid, "message", ev))) return;

    const to = { id: senderId };
    const { contact: c, isNew } = await upsertContact(senderId, undefined, true);

    // Mención en historia
    const mention = (msg.attachments ?? []).find((a: any) => a?.type === "story_mention");
    if (mention) return handleStoryMention(c, to, mention?.payload?.url);

    // Botón (quick reply)
    if (msg.quick_reply?.payload && (await handleIntent(c, parsePayload(msg.quick_reply.payload), to))) return;

    if (!msg.text) return; // stickers, audios, reacciones: los atiende el equipo
    const text: string = msg.text;
    const channel: Channel = msg.reply_to?.story ? "story" : "dm";
    const { keywords, resources } = await store.loadCatalog();
    const kw = matchKeyword(text, keywords, channel);
    const kwResource = kw ? resources.find((r) => r.id === kw.resource_id) : undefined;

    // 1) Esperando que nos siga
    if (c.state === "awaiting_follow" && isFollowDone(text)) {
      await handleIntent(c, { type: "follow_check" }, to);
      return;
    }

    // 2) Esperando correo
    if (c.state === "awaiting_email" && c.pending_resource_id) {
      const pending = await pendingResource(c);
      const email = extractEmail(text);
      if (pending && email) {
        await setContact(c, { email, newsletter_optin: true, optin_at: iso() } as Partial<Contact>);
        await sendText(to, copy.thanksEmail(email));
        await deliver(c, pending, to, "dm");
        if (cfg.newsletter) {
          await cfg.newsletter({
            email, username: c.username, igsid: c.igsid, source: "instagram_dm",
            resource: pending.slug, tags: ["instagram", pending.slug],
          });
        }
        return;
      }
      if (pending && isSkipEmail(text)) {
        await handleIntent(c, { type: "skip_email" }, to);
        return;
      }
      if (!kwResource && !wantsHuman(text) && !isStop(text)) {
        await sendQR(to, copy.invalidEmail(), [qr("Prefiero no darlo", "SKIP_EMAIL")]);
        return;
      }
    }

    // 3) Baja
    if (isStop(text)) {
      await setContact(c, {
        state: "idle", pending_resource_id: null, newsletter_optin: false,
        tags: [...new Set([...(c.tags ?? []), "stop"])],
      });
      await sendText(to, copy.stop());
      return;
    }

    // 4) Palabra clave → recurso (funciona incluso en modo humano)
    if (kwResource) {
      if (c.tags?.includes("stop")) await setContact(c, { tags: c.tags.filter((t) => t !== "stop") });
      await offerResource(c, kwResource, to, channel);
      return;
    }

    // 5) Modo humano: el bot se queda callado
    if (c.state === "handoff") return;

    // 6) Pide hablar con alguien
    if (wantsHuman(text)) {
      await handoff(c, to, copy.handoff(), "texto", text);
      return;
    }

    // 7) Primer contacto sin palabra clave → bienvenida con botones (una sola vez)
    if (isNew && (cfg.menuMode ?? "first_contact") === "first_contact") {
      await handleIntent(c, { type: "menu" }, to);
    }
    // Lo demás ("¿abren hoy?", pedidos) lo contesta el equipo.
  }

  async function handleWebhook(body: any) {
    for (const entry of body?.entry ?? []) {
      for (const change of entry?.changes ?? []) {
        if (change?.field === "comments") await handleComment(change.value).catch((e) => console.error("comment", e));
      }
      for (const ev of entry?.messaging ?? []) {
        const run = ev?.postback ? handlePostback(ev) : handleMessage(ev);
        await run.catch((e) => console.error("messaging", e));
      }
    }
  }

  /** Seguimiento "¿te sirvió?" antes de que cierre la ventana de 24 h. Correr cada 15 min. */
  async function runFollowups() {
    const t = now();
    const rows = await store.pendingFollowups(new Date(t - 24 * 3600e3).toISOString(), new Date(t - 3600e3).toISOString());
    const latest = new Map<string, Delivery & { contact: Contact }>();
    for (const r of rows) {
      const c = r.contact;
      if (c.state === "handoff" || c.tags?.includes("stop") || r.feedback) continue;
      if (!inFollowupSlot(c.last_inbound_at, t)) continue;
      const prev = latest.get(c.id);
      if (!prev || prev.created_at < r.created_at) latest.set(c.id, r);
    }
    let sent = 0;
    for (const d of latest.values()) {
      const r = await store.getResourceById(d.resource_id);
      if (!r) continue;
      await store.markFollowupSent(d.contact.id, iso()); // primero marcar: nunca duplicar
      const ok = await sendQR({ id: d.contact.igsid }, copy.followup(r), [
        qr("🙌 Me sirvió", `FB:util:${d.id}`),
        qr("📥 Quiero otra", `FB:otra:${d.id}`),
        qr("💬 Tengo una duda", `FB:duda:${d.id}`),
      ]);
      if (ok) sent++;
    }
    return { candidatos: rows.length, enviados: sent };
  }

  async function resolveRedirect(slug: string, contactId: string | null): Promise<string | null> {
    const r = await store.getResourceBySlug(slug);
    if (!r) return null;
    if (contactId && /^[0-9a-f-]{36}$/i.test(contactId)) await store.markClicked(contactId, r.id);
    return r.url;
  }

  return { handleWebhook, runFollowups, resolveRedirect };
}
