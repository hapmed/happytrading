# HappyTrading App 🤖⚡

Plataforma web multi-usuario para automatizar ganancias con cripto en **Bitso**:
rendimiento pasivo (Bitso+/staking) + trading automático guiado por IA (Gemini).

Frontend retro **8-bit**, animado y responsive. Todo corre en Docker.

## Stack
- **Backend**: Node.js + TypeScript (Fastify), Prisma ORM, BullMQ, Redis
- **Frontend**: React + Vite + TypeScript (estética 8-bit)
- **BD**: PostgreSQL 17 · **Cache/colas**: Redis
- **IA**: Gemini (prompts cortos, pocos tokens, resultados estadísticos en BD)
- **Exchange**: Bitso API v3 (REST + WebSocket)
- **Notificaciones**: SMTP

## Servicios (docker-compose)
| Servicio | Puerto interno | Expuesto |
|---|---|---|
| `web` (nginx + React) | 80 | `127.0.0.1:8082` |
| `api` (Fastify) | 4000 | `127.0.0.1:4000` |
| `worker` (bot IA) | — | — |
| `db` (postgres) | 5432 | — |
| `redis` | 6379 | — |

## Variables de entorno (`.env`)
Copiar `.env.example` a `.env` y rellenar. Importante:
- `ADMIN_PASSWORD`: contraseña del admin `hapmed`.
- `ENCRYPTION_KEY`: clave de 32 bytes (64 hex) para cifrar claves Bitso/Gemini en reposo.
- `JWT_SECRET`: secreto largo aleatorio.

> ⚠️ No versionar `.env` ni exponer secretos. Las claves de API se cifran con AES-256-GCM.

## Arranque
```bash
cp .env.example .env   # y edita los valores
docker compose up -d --build
```

El admin se crea automáticamente en el primer arranque (usuario `hapmed`).

## Roadmap
1. ✅ Base: auth JWT, admin, cifrado, SMTP, Docker
2. ✅ Integración Bitso (balance / ticker / órdenes)
3. ✅ Bot IA (worker + Gemini/OpenRouter + estadísticas)
4. ✅ Frontend 8-bit, PWA, dashboard financiero en vivo
5. ✅ Régimen de mercado cripto (filtro de riesgo)

## Créditos
- **Régimen de mercado cripto** adaptado de [`crypto-regime-analyzer`](https://github.com/tradermonty/claude-trading-skills) de **tradermonty/claude-trading-skills** (licencia MIT).
