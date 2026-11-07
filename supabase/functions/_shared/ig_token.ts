// Token de Instagram con renovación automática.
// El token vigente vive en rush_chat.settings (key "ig_token"); si aún no existe, se usa el secret IG_ACCESS_TOKEN.
// Los tokens de larga duración de Instagram duran 60 días y se renuevan con refresh_access_token
// (requiere que el token tenga al menos 24 h). Un cron semanal llama a refresh().

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";

export type TokenProvider = { get(): Promise<string>; refresh(): Promise<Record<string, unknown>> };

export function igTokenProvider(db: SupabaseClient<any, any, any>, fallback: string): TokenProvider {
  let cache: { token: string; at: number } | null = null;

  async function get(): Promise<string> {
    if (cache && Date.now() - cache.at < 5 * 60_000) return cache.token;
    const { data } = await db.from("settings").select("value").eq("key", "ig_token").maybeSingle();
    const token = (data?.value as any)?.token || fallback;
    cache = { token, at: Date.now() };
    return token;
  }

  async function refresh() {
    const current = await get();
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(current)}`,
    );
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.access_token) {
      // Nunca se imprime el token, solo el error de Meta.
      return { ok: false, error: json?.error?.message ?? `HTTP ${res.status}` };
    }
    const now = Date.now();
    const value = {
      token: json.access_token,
      refreshed_at: new Date(now).toISOString(),
      expires_at: new Date(now + (json.expires_in ?? 5184000) * 1000).toISOString(),
    };
    const { error } = await db.from("settings").upsert({ key: "ig_token", value, updated_at: value.refreshed_at });
    if (error) return { ok: false, error: error.message };
    cache = { token: value.token, at: now };
    return { ok: true, expires_at: value.expires_at };
  }

  return { get, refresh };
}
