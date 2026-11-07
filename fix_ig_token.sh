#!/usr/bin/env bash
# Arregla el token de Instagram, borra el intento de prueba fallido y vuelve a subir el webhook.
#
# Uso (en la carpeta rush-chat):
#   1) Pega el comando en la Terminal SIN Enter
#   2) Copia el token de Instagram ("Generar token" en Meta)
#   3) Regresa y presiona Enter
#   ./fix_ig_token.sh <project-ref>
set -euo pipefail
cd "$(dirname "$0")"
REF="${1:?Uso: ./fix_ig_token.sh <PROJECT_REF>}"
TOKEN="$(tr -d '[:space:]' < .secrets/supabase_token)"
API="https://api.supabase.com/v1/projects/$REF"
H=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

# 1. Token de Instagram desde el portapapeles, limpio de espacios y saltos de línea
IG="$(pbpaste | tr -d '[:space:]')"
case "$IG" in
  IG*) ;;
  *) echo "✗ Lo que tienes copiado no parece un token de Instagram (debe empezar con IG...)."
     echo "  Copia el token de 'Generar token' en Meta y vuelve a correr el comando."; exit 1 ;;
esac
echo "✓ Token de Instagram válido (${#IG} caracteres, empieza con ${IG:0:4})"

# 2. Comprobar con Instagram que el token sirve (no se imprime)
CHECK=$(curl -sS "https://graph.instagram.com/v23.0/me?fields=id,username&access_token=$IG")
if ! echo "$CHECK" | grep -q '"username"'; then
  echo "✗ Instagram rechazó el token: $(echo "$CHECK" | sed 's/access_token=[^&"]*//g')"; exit 1
fi
echo "✓ Instagram lo acepta: @$(echo "$CHECK" | sed -E 's/.*"username":"([^"]+)".*/\1/')"

# 3. Guardar en meta.env (conservando META_APP_SECRET) y subir a Supabase
SECRET_LINE=$(grep '^META_APP_SECRET=' .secrets/meta.env || true)
{ echo "IG_ACCESS_TOKEN=$IG"; [[ -n "$SECRET_LINE" ]] && echo "$SECRET_LINE"; } > .secrets/meta.env
chmod 600 .secrets/meta.env
BODY=$(IG="$IG" node -e 'console.log(JSON.stringify([{name:"IG_ACCESS_TOKEN",value:process.env.IG}]))')
curl -sS -X POST "$API/secrets" "${H[@]}" -d "$BODY" -o /dev/null -w "✓ Secret actualizado en Supabase (HTTP %{http_code})\n"

# 4. Borrar los intentos de prueba que fallaron por el token (solo entregas, no contactos)
Q='{"query":"delete from rush_chat.deliveries where created_at > now() - interval '"'"'1 day'"'"' returning id"}'
curl -sS -X POST "$API/database/query" "${H[@]}" -d "$Q" -o /dev/null -w "✓ Intentos de prueba limpiados (HTTP %{http_code})\n"

# 5. Subir la versión nueva del webhook
SUPABASE_ACCESS_TOKEN="$TOKEN" npx --yes supabase@2 functions deploy ig-webhook --project-ref "$REF" --no-verify-jwt --use-api
echo
echo "✅ Listo. Comenta 'Huatusco' de nuevo desde tu cuenta personal."
