import assert from "node:assert/strict";
import { normalize, matchKeyword, extractEmail, isStop, wantsHuman, trackedLink, verifySignature, copy } from "../supabase/functions/_shared/logic.ts";
import { createHmac } from "node:crypto";

const kws = [
  { keyword: "prompts", resource_id: "r1", channel: "any", media_id: null, public_reply: null },
  { keyword: "vender", resource_id: "r2", channel: "comment", media_id: null, public_reply: null },
  { keyword: "guía", resource_id: "r3", channel: "any", media_id: "POST9", public_reply: null },
  { keyword: "costeo bebidas", resource_id: "r4", channel: "dm", media_id: null, public_reply: null },
] as any;

assert.equal(normalize("  ¡PROMPTS, Por Favor!! "), "prompts por favor");
assert.equal(matchKeyword("Quiero los PROMPTS 🙏", kws, "dm")?.resource_id, "r1");
assert.equal(matchKeyword("quiero vender más", kws, "comment")?.resource_id, "r2");
assert.equal(matchKeyword("quiero vender más", kws, "dm"), null, "vender solo aplica a comentarios");
assert.equal(matchKeyword("COSTEO BEBIDAS", kws, "story")?.resource_id, "r4", "historia acepta palabras de DM");
assert.equal(matchKeyword("GUIA", kws, "comment", "POST9")?.resource_id, "r3");
assert.equal(matchKeyword("GUIA", kws, "comment", "OTRO"), null, "guía ligada a otro post");
assert.equal(matchKeyword("mándame el costeo de bebidas", kws, "dm"), null);
assert.equal(matchKeyword("COSTEO BEBIDAS", kws, "dm")?.resource_id, "r4");
assert.equal(matchKeyword("promptsss", kws, "dm"), null, "palabra completa, no substring");
assert.equal(extractEmail("claro: Roy.Camacho+cafe@Gmail.com gracias"), "roy.camacho+cafe@gmail.com");
assert.equal(extractEmail("no tengo"), null);
assert.ok(isStop("STOP")); assert.ok(isStop("no gracias")); assert.ok(!isStop("stopper"));
assert.ok(wantsHuman("quiero hablar con un humano")); assert.ok(!wantsHuman("humanos ja"));
assert.equal(trackedLink("https://x.co/fn/", "vender-mas", "abc"), "https://x.co/fn/r/vender-mas?c=abc");

const body = '{"a":1}';
const good = "sha256=" + createHmac("sha256", "secreto").update(body).digest("hex");
assert.ok(await verifySignature(body, good, "secreto"));
assert.ok(!(await verifySignature(body, good, "otro")));
assert.ok(!(await verifySignature(body, null, "secreto")));

import { menuQuickReplies, parsePayload, actionToPayload, pickPublicReply, inFollowupSlot, qr, DEFAULT_PUBLIC_REPLIES } from "../supabase/functions/_shared/logic.ts";
const mq = menuQuickReplies([{ id: "r1", slug: "p", title: "Guía de Prompts para Cafeterías", description: null, url: "", requires_email: true }], kws);
assert.equal(mq[0].payload, "RES:p"); assert.equal(mq[0].title, "📥 PROMPTS"); assert.equal(mq.at(-1)!.payload, "HUMAN");
assert.equal(qr("Un título larguísimo de más", "X").title.length, 20);
assert.deepEqual(parsePayload("FB:util:abc"), { type: "feedback", value: "util", deliveryId: "abc" });
assert.deepEqual(parsePayload("RES:vip"), { type: "resource", slug: "vip" });
assert.equal(parsePayload("raro"), null);
assert.equal(actionToPayload("recurso:prompts"), "RES:prompts"); assert.equal(actionToPayload("Menú"), "MENU");
assert.throws(() => actionToPayload("otra"));
assert.equal(pickPublicReply({ ...kws[0], public_replies: ["x", "y"] }, () => 0.99), "y");
assert.ok(DEFAULT_PUBLIC_REPLIES.includes(pickPublicReply(kws[0])));
const T = Date.parse("2026-10-24T12:00:00Z");
assert.ok(inFollowupSlot("2026-10-23T14:00:00Z", T)); assert.ok(!inFollowupSlot("2026-10-24T02:00:00Z", T));
assert.ok(!inFollowupSlot("2026-10-23T12:10:00Z", T));
console.log("✓ todas las pruebas pasaron");

import { slugify, igShortcode, within24h } from "../supabase/functions/_shared/logic.ts";
assert.equal(slugify("Guía de Prompts para Cafeterías!"), "guia-de-prompts-para-cafeterias");
assert.equal(igShortcode("https://www.instagram.com/p/DAbc_12-x/?igsh=xyz"), "DAbc_12-x");
assert.equal(igShortcode("https://instagram.com/rushcafe/reel/C9zz1/"), "C9zz1");
assert.equal(igShortcode("https://rushcafe.net"), null);
const now = Date.parse("2026-10-24T12:00:00Z");
assert.ok(within24h("2026-10-24T00:00:00Z", now));
assert.ok(!within24h("2026-10-23T11:00:00Z", now));
assert.ok(!within24h(null, now));
console.log("✓ pruebas extra pasaron");
