// RUSH DM Bot — webhook de Instagram (Supabase Edge Function, Deno)
//
// Rutas:
//   GET  /ig-webhook                  → verificación del webhook de Meta
//   POST /ig-webhook                  → eventos (comentarios, DMs, historias, botones)
//   GET  /ig-webhook/r/{slug}?c=…     → redirección con tracking de clic al recurso
//   POST /ig-webhook/cron/followups   → seguimiento "¿te sirvió?" (pg_cron cada 15 min)

import { createClient } from "npm:@supabase/supabase-js@2";
import { createBot } from "../_shared/bot.ts";
import { safeEqual, verifySignature } from "../_shared/logic.ts";
import { instagramGraph, supabaseStore } from "../_shared/supabase_store.ts";
import { igTokenProvider } from "../_shared/ig_token.ts";

const env = (k: string, fallback?: string) => {
  const v = Deno.env.get(k) ?? fallback;
  if (v === undefined) throw new Error(`Falta la variable de entorno ${k}`);
  return v;
};

const IG_USER_ID = env("IG_USER_ID");
const APP_SECRET = env("META_APP_SECRET");
const VERIFY_TOKEN = env("META_VERIFY_TOKEN");
const CRON_SECRET = Deno.env.get("CRON_SECRET");

async function postJson(url: string | undefined, payload: unknown) {
  if (!url) return;
  try {
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  } catch (e) {
    console.error("Webhook saliente falló", url, e);
  }
}

const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
  db: { schema: Deno.env.get("DB_SCHEMA") ?? "rush_chat" },
  auth: { persistSession: false },
});

const igToken = igTokenProvider(db, env("IG_ACCESS_TOKEN"));

const bot = createBot(
  supabaseStore(db),
  instagramGraph({
    base: `https://${env("GRAPH_HOST", "graph.instagram.com")}/${env("GRAPH_VERSION", "v23.0")}`,
    igUserId: IG_USER_ID,
    token: () => igToken.get(),
  }),
  {
    igUserId: IG_USER_ID,
    publicBaseUrl: env("PUBLIC_BASE_URL"),
    privacyUrl: Deno.env.get("PRIVACY_URL"),
    menuMode: (Deno.env.get("MENU_MODE") ?? "first_contact") as "first_contact" | "off",
    notify: (p) => postJson(Deno.env.get("NOTIFY_WEBHOOK_URL"), p),
    newsletter: (p) => postJson(Deno.env.get("NEWSLETTER_WEBHOOK_URL"), p),
  },
);

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;

  // Redirección con tracking
  const redirect = path.match(/\/r\/([^/]+)\/?$/);
  if (req.method === "GET" && redirect) {
    const target = await bot.resolveRedirect(decodeURIComponent(redirect[1]), url.searchParams.get("c"));
    return target ? Response.redirect(target, 302) : new Response("Recurso no encontrado", { status: 404 });
  }

  // Seguimiento programado
  if (path.endsWith("/cron/followups")) {
    if (!CRON_SECRET || !safeEqual(req.headers.get("x-cron-secret") ?? "", CRON_SECRET)) {
      return new Response("Forbidden", { status: 403 });
    }
    return Response.json(await bot.runFollowups());
  }

  // Renovación del token de Instagram (pg_cron semanal)
  if (path.endsWith("/cron/refresh-token")) {
    if (!CRON_SECRET || !safeEqual(req.headers.get("x-cron-secret") ?? "", CRON_SECRET)) {
      return new Response("Forbidden", { status: 403 });
    }
    const r = await igToken.refresh();
    if (!r.ok) console.error("refresh-token", r.error);
    return Response.json(r);
  }

  // Verificación de Meta
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN;
    return ok ? new Response(url.searchParams.get("hub.challenge") ?? "") : new Response("Forbidden", { status: 403 });
  }

  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get("x-hub-signature-256"), APP_SECRET))) {
    return new Response("Bad signature", { status: 401 });
  }
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return new Response("Bad JSON", { status: 400 }); }

  await bot.handleWebhook(body);
  return new Response("EVENT_RECEIVED"); // siempre 200 para que Meta no reintente en loop
});
