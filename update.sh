#!/usr/bin/env bash
# Actualización de RUSH Chat (no reinstala nada):
#   - liga PROMPTS / VENDER / COSTEO a las guías en Shopify
#   - agrega la biblioteca de archivos y las herramientas del Panel RUSH Chat
#   - activa la renovación automática del token de Instagram (cada lunes)
#   - sube las 3 funciones y deja en tu portapapeles la URL del MCP para Claude
#
# Uso (en la carpeta rush-chat):  ./update.sh <project-ref>
set -euo pipefail
cd "$(dirname "$0")"

REF="${1:?Uso: ./update.sh <PROJECT_REF>}"
[[ -f .secrets/supabase_token ]] || { echo "✗ Falta .secrets/supabase_token"; exit 1; }
TOKEN="$(tr -d '[:space:]' < .secrets/supabase_token)"
API="https://api.supabase.com/v1/projects/$REF"
BASE="https://$REF.supabase.co/functions/v1"
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

sql() {
  local body; body=$(node -e 'process.stdout.write(JSON.stringify({query:require("fs").readFileSync(process.argv[1],"utf8")}))' "$1")
  local out; out=$(curl -sS -w '\n%{http_code}' -X POST "$API/database/query" "${H[@]}" -d "$body")
  local code="${out##*$'\n'}"
  if [[ "$code" != 2* ]]; then echo "✗ $1 → HTTP $code"; echo "${out%$'\n'*}"; exit 1; fi
  echo "✓ $1"
}

echo "== 1. Base de datos (solo migraciones nuevas)"
for f in supabase/migrations/007_*.sql supabase/migrations/008_*.sql; do sql "$f"; done

echo "== 2. Claves internas (MCP y tareas programadas)"
GEN=.secrets/generated.env
gen() { node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))'; }
if [[ ! -f $GEN ]] || ! grep -q '^MCP_SECRET=' $GEN || ! grep -q '^CRON_SECRET=' $GEN; then
  # Se perdieron al reemplazar la carpeta: se generan nuevas (el webhook de Meta no se toca).
  { echo "MCP_SECRET=$(gen)"; echo "CRON_SECRET=$(gen)"; echo "PUBLISH_API_KEYS=grok:$(gen)"; } > $GEN
  chmod 600 $GEN
  echo "   claves nuevas generadas en $GEN"
fi
set -a; source $GEN; set +a
S=$(node -e 'const e=process.env;console.log(JSON.stringify(["MCP_SECRET","CRON_SECRET","PUBLISH_API_KEYS"].filter(k=>e[k]).map(k=>({name:k,value:e[k]}))))')
curl -sS -X POST "$API/secrets" "${H[@]}" -d "$S" -o /dev/null -w "   secrets: HTTP %{http_code}\n"

echo "== 3. Funciones"
for fn in ig-webhook rush-mcp rush-api; do
  SUPABASE_ACCESS_TOKEN="$TOKEN" npx --yes supabase@2 functions deploy "$fn" --project-ref "$REF" --no-verify-jwt --use-api
done

echo "== 4. Tareas programadas (publicar, seguimiento, renovar token)"
CRON=$(mktemp)
sed -e "s/<project-ref>/$REF/g" -e "s/<CRON_SECRET>/$CRON_SECRET/g" supabase/cron.sql > "$CRON"
sql "$CRON"; rm -f "$CRON"

echo "== 5. Primera renovación del token de Instagram"
sleep 5
R=$(curl -sS -X POST "$BASE/ig-webhook/cron/refresh-token" -H "x-cron-secret: $CRON_SECRET" || true)
if echo "$R" | grep -q '"ok":true'; then
  echo "   ✓ renovado, vence: $(echo "$R" | sed -E 's/.*"expires_at":"([^"]+)".*/\1/')"
else
  echo "   ⚠ Instagram no lo renovó todavía ($R)."
  echo "     Normal si el token tiene menos de 24 h; el lunes se renueva solo."
fi

echo "== 6. MCP para Claude"
URL="$BASE/rush-mcp/$MCP_SECRET"
printf '%s' "$URL" | pbcopy
CHECK=$(curl -sS -X POST "$URL" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).result.tools.length)}catch{console.log("?")}})')
echo "   ✓ MCP responde con $CHECK herramientas"
echo
echo "✅ Listo. La URL del MCP ya está copiada: pégala en claude.ai → Configuración → Conectores → Agregar conector personalizado."
echo "   Nómbralo exactamente: RUSH Chat   (así lo encuentra el Panel)."
echo "   (No la compartas: quien la tenga puede manejar el bot.)"
