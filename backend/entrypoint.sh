#!/bin/sh
set -e

# Aplica el esquema a la BD (idempotente). El worker espera a que la API lo haya hecho
# usando un pequeño bucle si la BD aún no está lista.
if [ "$1" = "node" ] && [ "$2" = "dist/server.js" ]; then
  echo "[entrypoint] Sincronizando esquema Prisma..."
  npx prisma db push --skip-generate
fi

exec "$@"
