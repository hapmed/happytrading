import type { FastifyReply, FastifyRequest } from 'fastify';

/** Quita campos sensibles (hash de contraseña, claves cifradas) de un usuario. */
export function serializeUser(user: any) {
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    verified: user.verified,
    profile: user.profile ?? 'balanced',
    hasBitso: Boolean(user.bitsoApiKey),
    tradingEnabled: user.tradingEnabled,
    autoTrade: user.autoTrade,
    rotate: user.rotate ?? true,
    volatileTop: user.volatileTop ?? 3,
    maxOrderAmount: user.maxOrderAmount?.toString() ?? null,
    stopLossPct: user.stopLossPct?.toString() ?? null,
    takeProfitPct: user.takeProfitPct?.toString() ?? null,
    initialCapital: user.initialCapital?.toString() ?? null,
    riskPct: user.riskPct?.toString() ?? null,
    cashReservePct: user.cashReservePct?.toString() ?? null,
    symbols: user.symbols ?? null,
    dcaLevels: user.dcaLevels ?? null,
    dcaStepPct: user.dcaStepPct?.toString() ?? null,
    createdAt: user.createdAt,
  };
}

/** preHandler: exige JWT válido. */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'No autorizado' });
  }
}

/** preHandler: exige JWT válido con rol ADMIN. */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    if (request.user.role !== 'ADMIN') {
      return reply.code(403).send({ error: 'Requiere rol admin' });
    }
  } catch {
    return reply.code(401).send({ error: 'No autorizado' });
  }
}
