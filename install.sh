#!/usr/bin/env bash
# Instalador del FIDELYA Print Bridge — macOS.
#
# Saltea el flujo "descargar.zip → arrastrar → doble click" que dispara
# Gatekeeper, porque el binario no está notarizado por Apple. Bajamos
# directo desde Terminal y limpiamos el xattr de cuarentena.
#
# Uso:
#   curl -fsSL https://raw.githubusercontent.com/4mser/fidelya-print-bridge/main/install.sh | bash
#
# Requiere: macOS 10.15+, curl, unzip (todo viene preinstalado).

set -e

REPO="4mser/fidelya-print-bridge"
APP_NAME="FIDELYA Print Bridge"
APP_DIR="/Applications/$APP_NAME.app"

OS=$(uname -s)
if [ "$OS" != "Darwin" ]; then
  echo "Este instalador es para macOS. Para Windows descargá el .exe desde el dashboard."
  exit 1
fi

ARCH=$(uname -m)
case "$ARCH" in
  arm64) ZIP="FIDELYA-Print-Bridge-macos-arm64.zip" ;;
  x86_64) ZIP="FIDELYA-Print-Bridge-macos-x64.zip" ;;
  *) echo "Arquitectura no soportada: $ARCH"; exit 1 ;;
esac

URL="https://github.com/$REPO/releases/latest/download/$ZIP"
TMP=$(mktemp -d)
trap "rm -rf '$TMP'" EXIT

echo "→ Descargando FIDELYA Print Bridge ($ARCH)..."
curl -fsSL "$URL" -o "$TMP/bridge.zip"

echo "→ Extrayendo..."
unzip -q -o "$TMP/bridge.zip" -d "$TMP"

# Si ya estaba corriendo, lo cerramos antes de pisar
if pgrep -f "fidelya-print-bridge" >/dev/null 2>&1; then
  echo "→ Cerrando instancia anterior..."
  pkill -f "fidelya-print-bridge" || true
  sleep 1
fi

echo "→ Instalando en /Applications..."
rm -rf "$APP_DIR"
mv "$TMP/$APP_NAME.app" "$APP_DIR"

echo "→ Quitando atributo de cuarentena (Gatekeeper)..."
xattr -cr "$APP_DIR" 2>/dev/null || true

echo "→ Iniciando..."
open -a "$APP_DIR"

# Esperar un poquito y validar que el bridge respondió.
sleep 2
if curl -fsS "http://127.0.0.1:9100/health" >/dev/null 2>&1; then
  echo ""
  echo "✓ FIDELYA Print Bridge corriendo en http://127.0.0.1:9100"
  echo "  Va a quedar abierto en background. Para confirmar desde el dashboard,"
  echo "  abrí Estaciones de Impresión — vas a ver 'Bridge activo'."
else
  echo ""
  echo "⚠ El bridge se instaló pero todavía no responde en 127.0.0.1:9100."
  echo "  Dale unos segundos y refrescá el dashboard. Si sigue sin aparecer,"
  echo "  abrí 'Aplicaciones' y doble click en '$APP_NAME'."
fi
