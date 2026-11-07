// Simulación del motor de publicación con Store y Graph en memoria.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createPublisher, type Post, type PublishGraph, type PublishStore, ValidationError } from "../supabase/functions/_shared/publisher.ts";
import { checkMime, countHashtags, directDownloadUrl, localTime, normalizeMedia, parseSchedule, validatePost } from "../supabase/functions/_shared/publish_logic.ts";

// ---------- lógica pura ----------
const T0 = Date.parse("2026-10-24T18:00:00Z"); // 12:00 hora Rush
assert.equal(parseSchedule("2026-10-28 18:30", T0).toISOString(), "2026-10-29T00:30:00.000Z");
assert.equal(parseSchedule("2026-10-28", T0).toISOString(), "2026-10-28T15:00:00.000Z", "solo fecha = 9:00 local");
assert.equal(parseSchedule("2026-10-28T18:30:00Z", T0).toISOString(), "2026-10-28T18:30:00.000Z");
assert.equal(parseSchedule(null, T0).getTime(), T0);
assert.throws(() => parseSchedule("mañana", T0));
assert.equal(localTime("2026-10-29T00:30:00.000Z"), "2026-10-28 18:30");
assert.equal(directDownloadUrl("https://drive.google.com/file/d/1AbC_x-9/view?usp=sharing"), "https://drive.google.com/uc?export=download&id=1AbC_x-9");
assert.equal(directDownloadUrl("https://www.dropbox.com/s/abc/v.mp4?dl=0"), "https://dl.dropboxusercontent.com/s/abc/v.mp4");
assert.deepEqual(normalizeMedia(["https://x/a.MP4", "https://x/b.jpg"]).map((m) => m.type), ["video", "image"]);
assert.equal(countHashtags("café #cafe #CoffeeLover y #espresso_mx"), 3);
assert.ok(checkMime("image/jpeg").ok); assert.ok(!checkMime("image/png").ok); assert.match(checkMime("text/html; charset=utf-8").error!, /página web/);
assert.match(validatePost({ kind: "carousel", media: ["https://x/1.jpg"] }).join(), /de 2 a 10/);
assert.match(validatePost({ kind: "reel", media: ["https://x/1.jpg"] }).join(), /1 video/);
assert.match(validatePost({ kind: "image", media: ["http://x/1.jpg"] }).join(), /https/);
assert.match(validatePost({ kind: "story", caption: "hola", media: ["https://x/1.jpg"] }).join(), /historias no llevan caption/);
assert.match(validatePost({ kind: "image", media: ["https://x/1.jpg"], caption: "#a ".repeat(31) }).join(), /30 hashtags/);
assert.match(validatePost({ kind: "image", media: ["https://x/1.jpg"], keyword: "guia" }).join(), /recurso/);
assert.equal(validatePost({ kind: "carousel", media: ["https://x/1.jpg", "https://x/2.mp4"], caption: "ok #cafe" }).length, 0);
console.log("✓ lógica de publicación");

// ---------- dobles ----------
function memStore() {
  const posts: Post[] = [];
  const keywords: any[] = [];
  let clock = 0;
  const store: PublishStore = {
    insertPost: async (row) => {
      const p = { id: randomUUID(), cover_url: null, share_to_feed: true, first_comment: null, container_id: null, children_ids: [], ig_media_id: null, permalink: null, error: null, attempts: 0, keyword: null, resource_slug: null, public_replies: [], created_at: "", updated_at: new Date(T0 + clock++).toISOString(), published_at: null, ...row } as Post;
      posts.push(p);
      return { ...p };
    },
    getPost: async (id) => { const p = posts.find((x) => x.id === id); return p ? structuredClone(p) : null; },
    updatePost: async (id, patch) => { Object.assign(posts.find((x) => x.id === id)!, patch); },
    claim: async (id, from, to) => { const p = posts.find((x) => x.id === id)!; if (p.status !== from) return false; p.status = to; return true; },
    listPosts: async ({ status, from, to, limit = 50 }) => posts
      .filter((p) => (!status || status.includes(p.status)) && (!from || p.scheduled_at >= from) && (!to || p.scheduled_at <= to))
      .sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at)).slice(0, limit).map((p) => structuredClone(p)),
    resourceExists: async (slug) => slug === "prompts",
    linkKeyword: async (k) => { keywords.push(k); },
  };
  return { store, posts, keywords };
}

function fakeGraph(opts: { videoPolls?: number; failCreate?: number; failPublishOnce?: boolean; errorStatus?: boolean } = {}) {
  const containers = new Map<string, { params: any; polls: number; published?: boolean }>();
  const calls = { create: [] as any[], publish: 0, comments: [] as string[] };
  let failCreate = opts.failCreate ?? 0;
  let failPublish = !!opts.failPublishOnce;
  const graph: PublishGraph = {
    async createContainer(params) {
      if (failCreate > 0) { failCreate--; throw new Error("image_url no accesible"); }
      const id = "C" + (containers.size + 1);
      containers.set(id, { params, polls: 0 });
      calls.create.push(params);
      return id;
    },
    async containerStatus(id) {
      const c = containers.get(id)!;
      if (c.published) return { status: "PUBLISHED" };
      if (opts.errorStatus) return { status: "ERROR", detail: "formato" };
      const isVideo = c.params.video_url || c.params.media_type === "REELS";
      if (isVideo && c.polls++ < (opts.videoPolls ?? 0)) return { status: "IN_PROGRESS" };
      return { status: "FINISHED" };
    },
    async publish(creationId) {
      containers.get(creationId)!.published = true;
      calls.publish++;
      if (failPublish) { failPublish = false; throw new Error("timeout"); }
      return "M_" + creationId;
    },
    permalink: async (m) => `https://instagram.com/p/${m}`,
    comment: async (_m, t) => { calls.comments.push(t); },
    publishingLimit: async () => ({ usage: 3, total: 100 }),
  };
  return { graph, calls };
}

let n = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); n++; console.log("✓", name); };

await test("imagen para ya → sale en la misma llamada con primer comentario y palabra clave", async () => {
  const s = memStore(); const g = fakeGraph();
  const pub = createPublisher(s.store, g.graph, { now: () => T0 });
  const r = await pub.createPost({ kind: "image", media: ["https://cdn/x.jpg"], caption: "Nuevo latte", first_comment: "#cafe", keyword: "GUIA", resource_slug: "prompts", public_replies: ["¡Va por DM!"] }, "claude");
  assert.equal(r.estado, "published");
  assert.equal(r.link, "https://instagram.com/p/M_C1");
  assert.deepEqual(g.calls.comments, ["#cafe"]);
  assert.deepEqual(s.keywords[0], { keyword: "guia", resourceSlug: "prompts", mediaId: "M_C1", publicReplies: ["¡Va por DM!"] });
});

await test("reel programado: espera la hora, espera el procesamiento y publica una vez", async () => {
  const s = memStore(); const g = fakeGraph({ videoPolls: 2 });
  let t = T0;
  const pub = createPublisher(s.store, g.graph, { now: () => t });
  const r = await pub.createPost({ kind: "reel", media: ["https://cdn/v.mp4"], caption: "Cold brew", scheduled_at: "2026-10-25 08:00", cover_url: "https://cdn/c.jpg" }, "grok");
  assert.equal(r.estado, "scheduled");
  assert.equal(r.programado, "2026-10-25 08:00 (hora Rush)");
  await pub.processQueue();
  assert.equal(g.calls.create.length, 0, "todavía no es hora");
  t = Date.parse("2026-10-25T14:00:00Z");
  await pub.processQueue();
  assert.equal(s.posts[0].status, "processing");
  assert.equal(g.calls.create[0].media_type, "REELS");
  assert.equal(g.calls.create[0].cover_url, "https://cdn/c.jpg");
  await pub.processQueue();
  assert.equal(s.posts[0].status, "processing", "video sigue procesando");
  await pub.processQueue();
  assert.equal(s.posts[0].status, "published");
  await pub.processQueue();
  assert.equal(g.calls.publish, 1, "no se duplica");
});

await test("carrusel mixto: hijos con is_carousel_item y espera de videos hijos", async () => {
  const s = memStore(); const g = fakeGraph({ videoPolls: 1 });
  const pub = createPublisher(s.store, g.graph, { now: () => T0 });
  const r = await pub.createPost({ kind: "carousel", media: ["https://cdn/1.jpg", "https://cdn/2.mp4", "https://cdn/3.jpg"], caption: "Menú de otoño" }, "claude");
  assert.equal(r.estado, "processing");
  assert.deepEqual(g.calls.create.slice(0, 3).map((c) => c.is_carousel_item), [true, true, true]);
  assert.equal(g.calls.create[1].media_type, "VIDEO");
  assert.equal(g.calls.create[3].children, "C1,C2,C3");
  await pub.processQueue();
  assert.equal(s.posts[0].status, "published");
});

await test("historia de imagen", async () => {
  const s = memStore(); const g = fakeGraph();
  const pub = createPublisher(s.store, g.graph, { now: () => T0 });
  const r = await pub.createPost({ kind: "story", media: ["https://cdn/s.jpg"] }, "claude");
  assert.equal(r.estado, "published");
  assert.deepEqual(g.calls.create[0], { media_type: "STORIES", image_url: "https://cdn/s.jpg" });
});

await test("falla al preparar → reintenta y a los 3 intentos queda 'failed'; publicar ahora la revive", async () => {
  const s = memStore(); const g = fakeGraph({ failCreate: 3 });
  const pub = createPublisher(s.store, g.graph, { now: () => T0 });
  const r = await pub.createPost({ kind: "image", media: ["https://cdn/x.jpg"] }, "api");
  assert.equal(r.estado, "scheduled"); assert.match(r.error!, /no accesible/);
  await pub.processQueue(); await pub.processQueue();
  assert.equal(s.posts[0].status, "failed");
  const again = await pub.publishNow(s.posts[0].id);
  assert.equal(again.estado, "published");
});

await test("Instagram rechaza el video (ERROR) → failed definitivo con motivo", async () => {
  const s = memStore(); const g = fakeGraph({ errorStatus: true });
  const pub = createPublisher(s.store, g.graph, { now: () => T0 });
  const r = await pub.createPost({ kind: "reel", media: ["https://cdn/v.mp4"] }, "api");
  assert.equal(r.estado, "failed"); assert.match(r.error!, /ERROR: formato/);
});

await test("publish se cae después de publicar → detecta PUBLISHED y no duplica", async () => {
  const s = memStore(); const g = fakeGraph({ failPublishOnce: true });
  const pub = createPublisher(s.store, g.graph, { now: () => T0 });
  await pub.createPost({ kind: "image", media: ["https://cdn/x.jpg"] }, "api");
  assert.equal(s.posts[0].status, "processing");
  await pub.processQueue();
  assert.equal(s.posts[0].status, "published");
  assert.equal(g.calls.publish, 1);
});

await test("validación, borrador, reprogramar, cancelar y calendario", async () => {
  const s = memStore(); const g = fakeGraph();
  const pub = createPublisher(s.store, g.graph, { now: () => T0 });
  await assert.rejects(pub.createPost({ kind: "image", media: ["https://cdn/x.jpg"], keyword: "x", resource_slug: "nope" }, "api"), ValidationError);
  await assert.rejects(pub.createPost({ kind: "image", media: ["https://cdn/x.jpg"], scheduled_at: "2026-10-01 10:00" }, "api"), /ya pasó/);
  const d = await pub.createPost({ kind: "image", media: ["https://cdn/x.jpg"], draft: true }, "claude");
  assert.equal(d.estado, "draft");
  const rs = await pub.reschedule(d.id, "2026-10-30 19:00");
  assert.equal(rs.estado, "scheduled"); assert.equal(rs.programado, "2026-10-30 19:00 (hora Rush)");
  assert.equal((await pub.calendar()).length, 1);
  await pub.cancel(d.id);
  assert.equal((await pub.calendar()).length, 0);
  assert.deepEqual(await pub.limits(), { usadas_24h: 3, limite_24h: 100, disponibles: 97 });
});

console.log(`\n${n} escenarios de publicación OK`);

{
  assert.match(validatePost({ kind: "image", media: ["https://x/a.PNG"] }).join(), /solo acepta JPG/);
  const s = memStore(); const g = fakeGraph();
  const pub = createPublisher(s.store, g.graph, { now: () => T0 });
  await assert.rejects(pub.createPost({ kind: "reel", media: ["https://x/a.jpg"], scheduled_at: "ayer" }, "api"),
    (e: any) => e instanceof ValidationError && e.errors.length === 2);
  console.log("✓ errores de fecha y formato se juntan en una sola respuesta");
}
