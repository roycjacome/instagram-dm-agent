#!/usr/bin/env bash
# Deploy de RUSH Chat al proyecto de Supabase de Expresos, sin tocar las tablas de Expresos.
# Todo vive en el esquema rush_chat + bucket ig-media + 3 edge functions.
#
# Requisitos:
#   - .secrets/supabase_token  → Access token de Supabase (Dashboard → Account → Access Tokens)
#   - PROJECT_REF del proyecto de Expresos (Dashboard → Project Settings → General → Reference ID)
#
# Uso:  ./deploy.sh <PROJECT_REF>
set -euo pipefail
cd "$(dirname "$0")"

REF="${1:?Uso: ./deploy.sh <PROJECT_REF del proyecto de Expresos>}"
TOKEN="$(tr -d '[:space:]' < .secrets/supabase_token)"
API="https://api.supabase.com/v1/projects/$REF"
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
mkdir -p .secrets && chmod 700 .secrets

sql() { # ejecuta un archivo SQL en la base del proyecto
  local body; body=$(node -e 'process.stdout.write(JSON.stringify({query:require("fs").readFileSync(process.argv[1],"utf8")}))' "$1")
  local out; out=$(curl -sS -w '\n%{http_code}' -X POST "$API/database/query" "${H[@]}" -d "$body")
  local code="${out##*$'\n'}"
  if [[ "$code" != 2* ]]; then echo "✗ $1 → HTTP $code"; echo "${out%$'\n'*}"; exit 1; fi
  echo "✓ $1"
}

echo "== 1. Proyecto"
curl -sS "$API" "${H[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);if(!p.id){console.error(s);process.exit(1)}console.log("   ",p.name,"·",p.region)})'

echo "== 2. Base de datos (esquema rush_chat)"
for f in supabase/migrations/00*.sql supabase/seed.sql; do sql "$f"; done

echo "== 3. Exponer rush_chat a la API (sin quitar los esquemas que ya usa Expresos)"
CUR=$(curl -sS "$API/postgrest" "${H[@]}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).db_schema||"public"))')
if [[ ",$CUR," != *",rush_chat,"* ]]; then
  NEW="$CUR,rush_chat"
  curl -sS -X PATCH "$API/postgrest" "${H[@]}" -d "{\"db_schema\":\"$NEW\"}" >/dev/null
  echo "   db_schema: $CUR → $NEW"
else
  echo "   ya expuesto ($CUR)"
fi

echo "== 4. Secrets"
gen() { node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))'; }
GEN=.secrets/generated.env
if [[ ! -f $GEN ]]; then
  {
    echo "MCP_SECRET=$(gen)"
    echo "CRON_SECRET=$(gen)"
    echo "META_VERIFY_TOKEN=$(gen)"
    echo "PUBLISH_API_KEYS=grok:$(gen)"
  } > $GEN
  chmod 600 $GEN
fi
set -a; source $GEN; set +a
BASE="https://$REF.supabase.co/functions/v1"
SECRETS=$(node -e '
  const e=process.env, base=process.argv[1];
  const s={MCP_SECRET:e.MCP_SECRET,CRON_SECRET:e.CRON_SECRET,META_VERIFY_TOKEN:e.META_VERIFY_TOKEN,
    PUBLISH_API_KEYS:e.PUBLISH_API_KEYS,PUBLIC_BASE_URL:base+"/ig-webhook",DB_SCHEMA:"rush_chat",
    GRAPH_HOST:"graph.instagram.com",GRAPH_VERSION:"v23.0",TZ_OFFSET:"-06:00",MEDIA_MAX_MB:"50",
    IG_USER_ID:"17841402245454563",PRIVACY_URL:"https://rushcafe.net/policies/privacy-policy"};
  console.log(JSON.stringify(Object.entries(s).map(([name,value])=>({name,value}))));' "$BASE")
curl -sS -X POST "$API/secrets" "${H[@]}" -d "$SECRETS" -o /dev/null -w "   secrets base: HTTP %{http_code}\n"
if [[ -f .secrets/meta.env ]]; then
  META=$(node -e '
    const lines=require("fs").readFileSync(".secrets/meta.env","utf8").split(/\r?\n/).filter(l=>/^[A-Z_]+=/.test(l));
    console.log(JSON.stringify(lines.map(l=>({name:l.slice(0,l.indexOf("=")),value:l.slice(l.indexOf("=")+1).trim()}))));')
  curl -sS -X POST "$API/secrets" "${H[@]}" -d "$META" -o /dev/null -w "   secrets de Meta: HTTP %{http_code}\n"
else
  echo "   ⚠ Falta .secrets/meta.env (IG_ACCESS_TOKEN y META_APP_SECRET). El bot no arranca sin ellos."
fi

echo "== 5. Edge functions"
for fn in ig-webhook rush-mcp rush-api; do
  SUPABASE_ACCESS_TOKEN="$TOKEN" npx --yes supabase@2 functions deploy "$fn" --project-ref "$REF" --no-verify-jwt --use-api
done

echo "== 6. Tareas programadas (publicar cada min, seguimiento cada 15 min)"
CRON=$(mktemp)
sed -e "s/<project-ref>/$REF/g" -e "s/<CRON_SECRET>/$CRON_SECRET/g" supabase/cron.sql \
  | sed -e "s/^select cron.schedule('rush-ig-publish'/select cron.unschedule('rush-ig-publish') where exists (select 1 from cron.job where jobname='rush-ig-publish');\nselect cron.schedule('rush-ig-publish'/" \
        -e "s/^select cron.schedule('rush-dm-followups'/select cron.unschedule('rush-dm-followups') where exists (select 1 from cron.job where jobname='rush-dm-followups');\nselect cron.schedule('rush-dm-followups'/" > "$CRON"
sql "$CRON"; rm -f "$CRON"

cat <<EOF

✅ Listo.
   Webhook (pegar en Meta):  $BASE/ig-webhook
   Verify token (en Meta):   está en .secrets/generated.env → META_VERIFY_TOKEN
   MCP para Claude:          $BASE/rush-mcp/<MCP_SECRET de .secrets/generated.env>
   API REST (Grok):          $BASE/rush-api  (clave en PUBLISH_API_KEYS)
EOF
