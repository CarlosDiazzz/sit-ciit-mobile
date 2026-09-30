#!/usr/bin/env bash
# Arranca Expo anunciando la IP del Wi-Fi.
#
# Con Ethernet y Wi-Fi conectados a la vez, Metro elige la IP de la ruta
# por defecto (el cable) y el celular, que esta en el hotspot, no la
# alcanza: son redes distintas sin ruta entre ellas.
# REACT_NATIVE_PACKAGER_HOSTNAME fuerza la correcta.
#
# Uso: ./start-hotspot.sh [--clear]
set -euo pipefail

IFACE="$(ip -o link show | awk -F': ' '/wl[a-z0-9]*:/ {print $2; exit}')"
if [ -z "${IFACE:-}" ]; then
  echo "No se encontro una interfaz Wi-Fi en este equipo." >&2
  exit 1
fi

IP="$(ip -4 -o addr show "$IFACE" 2>/dev/null | awk '{print $4}' | cut -d/ -f1)"
if [ -z "${IP:-}" ]; then
  echo "La interfaz $IFACE no tiene IP." >&2
  echo "Conecta la laptop al hotspot del celular y vuelve a intentar." >&2
  exit 1
fi

echo "Metro se anunciara en $IP (interfaz $IFACE)"
echo "El celular debe estar en esa misma red."
echo
REACT_NATIVE_PACKAGER_HOSTNAME="$IP" exec npx expo start "$@"
