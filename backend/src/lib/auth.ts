import type { FastifyReply, FastifyRequest } from 'fastify';
import { prisma } from './prisma.js';

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
    autoSince: user.autoSince ?? null,
    autoTotalSec: user.autoTotalSec ?? 0,
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
    // Retiro de ganancias por SPEI
    payoutEnabled: user.payoutEnabled ?? false,
    payoutClabe: user.payoutClabe ?? null,
    payoutBeneficiary: user.payoutBeneficiary ?? null,
    workingCapitalMxn: user.workingCapitalMxn?.toString() ?? null,
    createdAt: user.createdAt,
  };
}

/**
 * Verifica el JWT y ADEMÁS valida el usuario contra la BD en cada petición:
 * - usuario existente y con estado ACTIVE (deshabilitar/borrar surte efecto de inmediato),
 * - el rol se toma de la BD (evita privilegios obsoletos en el token).
 */
async function loadActiveUser(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  try {
    await request.jwtVerify();
  } catch {
    reply.code(401).send({ error: 'No autorizado' });
    return false;
  }
  const user = await prisma.user.findUnique({ where: { id: request.user.sub } });
  if (!user || user.status !== 'ACTIVE') {
    reply.code(401).send({ error: 'Sesión inválida' });
    return false;
  }
  (request.user as any).role = user.role;
  (request.user as any).status = user.status;
  return true;
}

/** preHandler: exige JWT válido y usuario activo. */
export async function authenticate(request: FastifyRequest, reply: FastifyReply) {
  await loadActiveUser(request, reply);
}

/** preHandler: exige JWT válido, usuario activo y rol ADMIN (leído de la BD). */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
  if (!(await loadActiveUser(request, reply))) return;
  if (request.user.role !== 'ADMIN') {
    return reply.code(403).send({ error: 'Requiere rol admin' });
  }
}
