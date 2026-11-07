// Simulación completa de flujos con Store y Graph en memoria.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createBot, type Contact, type Delivery, type Graph, type Store } from "../supabase/functions/_shared/bot.ts";
import type { Keyword, Resource } from "../supabase/functions/_shared/logic.ts";

function memoryStore(seed: { resources: (Resource & { active?: boolean })[]; keywords: Keyword[]; settings?: Record<string, any> }) {
  const contacts: Contact[] = [];
  const deliveries: (Delivery & { source: string; clicked_at?: string | null; followup_sent_at?: string | null })[] = [];
  const events = new Set<string>();
  let clock = 0;
  const store: Store = {
    loadCatalog: async () => ({ keywords: seed.keywords, resources: seed.resources.filter((r) => r.active !== false) }),
    getSetting: async (k) => seed.settings?.[k] ?? null,
    firstTime: async (id) => (events.has(id) ? false : (events.add(id), true)),
    getContactByIgsid: async (igsid) => contacts.find((c) => c.igsid === igsid) ?? null,
    insertContact: async (row) => {
      const c: Contact = { id: randomUUID(), username: null, email: null, newsletter_optin: false, state: "idle", pending_resource_id: null, tags: [], last_inbound_at: null, ...row } as Contact;
      contacts.push(c);
      return { ...c };
    },
    updateContact: async (id, patch) => { Object.assign(contacts.find((c) => c.id === id)!, patch); },
    getResourceBySlug: async (s) => seed.resources.find((r) => r.slug === s) ?? null,
    getResourceById: async (id) => seed.resources.find((r) => r.id === id) ?? null,
    insertDelivery: async (row) => {
      const d = { id: randomUUID(), created_at: new Date(Date.UTC(2026, 9, 24, 12) + clock++ * 1000).toISOString(), feedback: null, ...row };
      deliveries.push(d);
      return d;
    },
    hasDelivery: async (cid, rid) => deliveries.some((d) => d.contact_id === cid && d.resource_id === rid),
    getDelivery: async (id) => deliveries.find((d) => d.id === id) ?? null,
    updateDelivery: async (id, patch) => { Object.assign(deliveries.find((d) => d.id === id)!, patch); },
    markClicked: async (cid, rid) => {
      const d = [...deliveries].reverse().find((x) => x.contact_id === cid && x.resource_id === rid && !x.clicked_at);
      if (d) d.clicked_at = "now";
    },
    pendingFollowups: async (from, to) => deliveries
      .filter((d) => !d.followup_sent_at && d.created_at >= from && d.created_at <= to)
      .map((d) => ({ ...d, contact: contacts.find((c) => c.id === d.contact_id)! }))
      .filter((d) => d.contact.last_inbound_at),
    markFollowupSent: async (cid, at) => { deliveries.filter((d) => d.contact_id === cid && !d.followup_sent_at).forEach((d) => (d.followup_sent_at = at)); },
  };
  return { store, contacts, deliveries };
}

function fakeGraph(opts: { following?: Record<string, boolean | null>; rejectRich?: boolean } = {}) {
  const sent: { to: any; message: any }[] = [];
  const publicReplies: string[] = [];
  const graph: Graph = {
    send: async (to, message) => {
      if (opts.rejectRich && (message.attachment || message.quick_replies)) return false;
      sent.push({ to, message });
      return true;
    },
    replyComment: async (_id, text) => (publicReplies.push(text), true),
    getProfile: async (igsid, fields) => {
      if (fields === "username") return { username: `user_${igsid}` };
      const f = opts.following?.[igsid];
      return f === null || f === undefined ? null : { is_user_follow_business: f };
    },
  };
  return { graph, sent, publicReplies, last: () => sent[sent.length - 1]?.message };
}

const R1: Resource = { id: "r1", slug: "prompts", title: "Guía de Prompts", description: "30 prompts", url: "https://drive/x", requires_email: true };
const R2: Resource = { id: "r2", slug: "vip", title: "Checklist VIP", description: null, url: "https://drive/vip", requires_email: false, requires_follow: true, image_url: "https://img/vip.png" };
const KW: Keyword[] = [
  { keyword: "prompts", resource_id: "r1", channel: "any", media_id: null, public_replies: ["A", "B", "C"] },
  { keyword: "vip", resource_id: "r2", channel: "any", media_id: null },
];
const SETTINGS = {
  welcome: { text: "Bienvenido" },
  story_mention: { mode: "resource", resource_slug: "prompts", text: "Gracias por la mención" },
};
const NOW = Date.UTC(2026, 9, 24, 12);
const cfg = (extra: any = {}) => ({ igUserId: "ME", publicBaseUrl: "https://fn", now: () => NOW, ...extra });
const dm = (sender: string, message: any) => ({ entry: [{ messaging: [{ sender: { id: sender }, recipient: { id: "ME" }, message: { mid: randomUUID(), ...message } }] }] });
const postback = (sender: string, payload: string) => ({ entry: [{ messaging: [{ sender: { id: sender }, postback: { mid: randomUUID(), payload, title: "x" } }] }] });
const comment = (from: string, text: string, id = randomUUID()) => ({ entry: [{ changes: [{ field: "comments", value: { id, text, from: { id: from, username: "u" + from }, media: { id: "M1" } } }] }] });

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log("✓", name); };

await test("comentario → respuesta pública rotando + DM pide correo con botón", async () => {
  const s = memoryStore({ resources: [R1, R2], keywords: KW, settings: SETTINGS });
  const g = fakeGraph();
  const bot = createBot(s.store, g.graph, cfg());
  await bot.handleWebhook(comment("100", "Quiero los PROMPTS!"));
  assert.ok(["A", "B", "C"].includes(g.publicReplies[0]));
  assert.deepEqual(g.sent[0].to, { comment_id: g.sent[0].to.comment_id });
  assert.equal(g.last().quick_replies[0].payload, "SKIP_EMAIL");
  assert.equal(s.contacts[0].state, "awaiting_email");
  assert.equal(s.contacts[0].last_inbound_at, null, "comentario no abre ventana");
});

await test("reintento de Meta no duplica", async () => {
  const s = memoryStore({ resources: [R1], keywords: KW });
  const g = fakeGraph();
  const bot = createBot(s.store, g.graph, cfg());
  const ev = comment("100", "prompts", "C1");
  await bot.handleWebhook(ev); await bot.handleWebhook(ev);
  assert.equal(g.publicReplies.length, 1);
});

await test("correo → registro, tarjeta con botón y newsletter", async () => {
  const s = memoryStore({ resources: [R1], keywords: KW, settings: SETTINGS });
  const g = fakeGraph();
  const subs: any[] = [];
  const bot = createBot(s.store, g.graph, cfg({ newsletter: async (p: any) => { subs.push(p); } }));
  await bot.handleWebhook(dm("200", { text: "prompts" }));
  await bot.handleWebhook(dm("200", { text: "claro, Roy@Rush.mx" }));
  assert.equal(s.contacts[0].email, "roy@rush.mx");
  assert.equal(s.contacts[0].username, "user_200");
  assert.equal(g.last().attachment.payload.elements[0].buttons[0].url, `https://fn/r/prompts?c=${s.contacts[0].id}`);
  assert.equal(subs[0].resource, "prompts");
  assert.equal(s.deliveries.length, 1);
});

await test("botón 'Prefiero no darlo' entrega sin correo", async () => {
  const s = memoryStore({ resources: [R1], keywords: KW });
  const g = fakeGraph();
  const bot = createBot(s.store, g.graph, cfg());
  await bot.handleWebhook(dm("201", { text: "prompts" }));
  await bot.handleWebhook(dm("201", { text: "Prefiero no darlo", quick_reply: { payload: "SKIP_EMAIL" } }));
  assert.equal(s.deliveries.length, 1);
  assert.equal(s.contacts[0].email, null);
  assert.equal(s.contacts[0].state, "idle");
});

await test("gate de seguidor: no sigue → pide seguir; sigue → entrega", async () => {
  const s = memoryStore({ resources: [R1, R2], keywords: KW });
  const following: Record<string, boolean | null> = { "300": false };
  const g = fakeGraph({ following });
  const bot = createBot(s.store, g.graph, cfg());
  await bot.handleWebhook(dm("300", { text: "VIP" }));
  assert.equal(s.contacts[0].state, "awaiting_follow");
  assert.equal(g.last().quick_replies[0].payload, "FOLLOW_CHECK");
  await bot.handleWebhook(dm("300", { text: "Ya te sigo", quick_reply: { payload: "FOLLOW_CHECK" } }));
  assert.match(g.last().text, /Todavía no/);
  following["300"] = true;
  await bot.handleWebhook(dm("300", { text: "listo" }));
  assert.equal(g.last().attachment.payload.elements[0].image_url, "https://img/vip.png");
  assert.equal(s.deliveries.length, 1);
});

await test("gate desde comentario sin poder leer perfil → pide seguir", async () => {
  const s = memoryStore({ resources: [R2], keywords: KW });
  const g = fakeGraph({ following: { "301": null } });
  const bot = createBot(s.store, g.graph, cfg());
  await bot.handleWebhook(comment("301", "vip"));
  assert.equal(s.contacts[0].state, "awaiting_follow");
});

await test("respuesta a historia con palabra clave", async () => {
  const s = memoryStore({ resources: [R1], keywords: KW });
  const g = fakeGraph();
  const bot = createBot(s.store, g.graph, cfg());
  await bot.handleWebhook(dm("400", { text: "prompts 🔥", reply_to: { story: { id: "S1", url: "u" } } }));
  assert.equal(s.contacts[0].state, "awaiting_email");
});

await test("mención en historia → agradece, avisa al equipo y ofrece recurso", async () => {
  const s = memoryStore({ resources: [R1], keywords: KW, settings: SETTINGS });
  const g = fakeGraph();
  const notes: any[] = [];
  const bot = createBot(s.store, g.graph, cfg({ notify: async (p: any) => { notes.push(p); } }));
  await bot.handleWebhook(dm("500", { attachments: [{ type: "story_mention", payload: { url: "https://story" } }] }));
  assert.equal(notes[0].type, "story_mention");
  assert.equal(g.sent[0].message.text, "Gracias por la mención");
  assert.equal(s.contacts[0].state, "awaiting_email");
});

await test("primer DM sin palabra → bienvenida con botones; ice breaker (postback) entrega", async () => {
  const s = memoryStore({ resources: [R1, R2], keywords: KW, settings: SETTINGS });
  const g = fakeGraph({ following: { "600": true } });
  const bot = createBot(s.store, g.graph, cfg());
  await bot.handleWebhook(dm("600", { text: "hola" }));
  const qrs = g.last().quick_replies;
  assert.equal(g.last().text, "Bienvenido");
  assert.deepEqual(qrs.map((q: any) => q.payload), ["RES:prompts", "RES:vip", "HUMAN"]);
  assert.ok(qrs.every((q: any) => q.title.length <= 20));
  await bot.handleWebhook(dm("600", { text: "¿abren hoy?" }));
  assert.equal(g.sent.length, 1, "segundo mensaje libre: el bot no contesta");
  await bot.handleWebhook(postback("600", "RES:vip"));
  assert.ok(g.last().attachment);
});

await test("si Meta rechaza botones/tarjetas, cae a texto plano", async () => {
  const s = memoryStore({ resources: [R2], keywords: KW });
  const g = fakeGraph({ rejectRich: true, following: { "700": true } });
  const bot = createBot(s.store, g.graph, cfg());
  await bot.handleWebhook(dm("700", { text: "vip" }));
  assert.match(g.last().text, /https:\/\/fn\/r\/vip\?c=/);
});

await test("seguimiento a las ~23 h con botones, una sola vez", async () => {
  const s = memoryStore({ resources: [R1], keywords: KW });
  const g = fakeGraph();
  let t = NOW;
  const bot = createBot(s.store, g.graph, cfg({ now: () => t }));
  await bot.handleWebhook(dm("800", { text: "prompts" }));
  await bot.handleWebhook(dm("800", { text: "a@b.co" }));
  const before = g.sent.length;
  t = NOW + 10 * 3600e3;
  assert.equal((await bot.runFollowups()).enviados, 0, "a las 10 h todavía no");
  t = NOW + 22 * 3600e3;
  assert.equal((await bot.runFollowups()).enviados, 1);
  assert.equal((await bot.runFollowups()).enviados, 0, "no se repite");
  const fu = g.sent[before].message;
  assert.match(fu.text, /Te sirvió/);
  const payload = fu.quick_replies[0].payload;
  await bot.handleWebhook(dm("800", { text: "Me sirvió", quick_reply: { payload } }));
  assert.equal(s.deliveries[0].feedback, "util");
});

await test("feedback 'duda' pasa a humano; HUMANO silencia al bot; STOP da de baja", async () => {
  const s = memoryStore({ resources: [R1], keywords: KW, settings: SETTINGS });
  const g = fakeGraph();
  const notes: any[] = [];
  const bot = createBot(s.store, g.graph, cfg({ notify: async (p: any) => { notes.push(p); } }));
  await bot.handleWebhook(dm("900", { text: "quiero hablar con un humano" }));
  assert.equal(s.contacts[0].state, "handoff");
  assert.equal(notes[0].type, "handoff");
  const count = g.sent.length;
  await bot.handleWebhook(dm("900", { text: "¿tienen vacantes?" }));
  assert.equal(g.sent.length, count);
  await bot.handleWebhook(dm("900", { text: "STOP" }));
  assert.ok(s.contacts[0].tags.includes("stop"));
  await bot.handleWebhook(comment("900", "prompts"));
  assert.equal(g.publicReplies.length, 0, "dado de baja: no se responde");
});

await test("tracking de clic", async () => {
  const s = memoryStore({ resources: [R1], keywords: KW });
  const g = fakeGraph();
  const bot = createBot(s.store, g.graph, cfg());
  await bot.handleWebhook(dm("950", { text: "prompts" }));
  await bot.handleWebhook(dm("950", { text: "no gracias" }));
  const url = await bot.resolveRedirect("prompts", s.contacts[0].id);
  assert.equal(url, "https://drive/x");
  assert.equal(s.deliveries[0].clicked_at, "now");
  assert.equal(await bot.resolveRedirect("nada", null), null);
});

await test("campaña Huatusco: texto exacto, un solo DM por persona, sin importar mayúsculas/acentos/emojis", async () => {
  const H: Resource = { id: "h", slug: "huatusco-88", title: "Huatusco", description: null, url: "https://cdn/x.pdf",
    requires_email: false, once_per_contact: true, dm_text: "¡Gracias por comentar! ☕ https://cdn/x.pdf https://rushcafe.net/products/huatusco" };
  const HK: Keyword[] = [{ keyword: "huatusco", resource_id: "h", channel: "comment", media_id: null, public_replies: ["¡Te mandamos todo por DM! 📩"] }];
  const s = memoryStore({ resources: [H], keywords: HK });
  const g = fakeGraph();
  const bot = createBot(s.store, g.graph, cfg());
  await bot.handleWebhook(comment("h1", "HUATÚSCO 🔥☕"));
  assert.equal(g.sent.length, 1);
  assert.equal(g.sent[0].message.text, H.dm_text, "manda el texto tal cual, sin tarjeta");
  assert.ok("comment_id" in g.sent[0].to, "respuesta privada al comentario");
  assert.deepEqual(g.publicReplies, ["¡Te mandamos todo por DM! 📩"]);
  await bot.handleWebhook(comment("h1", "huatusco otra vez!!"));
  assert.equal(g.sent.length, 1, "segundo comentario de la misma persona: no hay otro DM");
  assert.equal(g.publicReplies.length, 1, "ni otra respuesta pública");
  await bot.handleWebhook(comment("h2", "  #Huatusco  "));
  assert.equal(g.sent.length, 2, "otra persona sí lo recibe");
  await bot.handleWebhook(comment("h3", "huatuscos"));
  assert.equal(g.sent.length, 2, "palabra distinta no dispara");
  await bot.handleWebhook(dm("h4", { text: "huatusco" }));
  assert.equal(g.sent.filter((x) => x.message.text === H.dm_text).length, 2, "regla solo de comentarios: un DM con la palabra no manda la campaña");
});

await test("si Instagram rechaza el DM (token malo), no se marca como entregado y se puede reintentar", async () => {
  const H: Resource = { id: "h", slug: "huatusco-88", title: "H", description: null, url: "u", requires_email: false, once_per_contact: true, dm_text: "hola" };
  const HK: Keyword[] = [{ keyword: "huatusco", resource_id: "h", channel: "comment", media_id: null }];
  const s = memoryStore({ resources: [H], keywords: HK });
  let fail = true;
  const sent: any[] = [];
  const graph: Graph = { send: async (_t, m) => (fail ? false : (sent.push(m), true)), replyComment: async () => !fail, getProfile: async () => null };
  const bot = createBot(s.store, graph, cfg());
  await bot.handleWebhook(comment("z1", "huatusco"));
  assert.equal(s.deliveries.length, 0);
  fail = false;
  await bot.handleWebhook(comment("z1", "huatusco"));
  assert.equal(sent.length, 1); assert.equal(s.deliveries.length, 1);
});

console.log(`\n${n} escenarios OK`);
