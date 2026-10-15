import { prisma } from './prisma.js';
import { hashPassword } from './crypto.js';
import { config } from '../config.js';

/**
 * Garantiza que existan el admin y las claves de configuración por defecto.
 * Es idempotente: se puede llamar en cada arranque de la API.
 */
export async function ensureDefaults(): Promise<void> {
  const admin = await prisma.user.findUnique({ where: { username: config.admin.username } });
  if (!admin) {
    await prisma.user.create({
      data: {
        username: config.admin.username,
        email: config.admin.email,
        passwordHash: await hashPassword(config.admin.password),
        role: 'ADMIN',
        verified: true,
        name: 'Administrador',
      },
    });
    console.log('[defaults] Admin creado:', config.admin.username);
  }

  const defaults: Array<[string, unknown]> = [
    ['smtp', null],
    ['gemini', null],
    ['openrouter', null],
    ['bot', null],
    ['registration_token', null],
    ['turnstile', null],
  ];
  for (const [key, value] of defaults) {
    const existing = await prisma.setting.findUnique({ where: { key } });
    if (!existing) {
      await prisma.setting.create({ data: { key, value: value as object } });
    }
  }
}
