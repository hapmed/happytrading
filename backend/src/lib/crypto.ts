import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

function getKey(): Buffer {
  const key = config.encryptionKey;
  if (!key) {
    // Sin ENCRYPTION_KEY no ciframos: mejor fallar que guardar con clave pública.
    throw new Error('ENCRYPTION_KEY no configurada: no se pueden cifrar/descifrar secretos');
  }
  if (/^[0-9a-fA-F]{64}$/.test(key)) return Buffer.from(key, 'hex');
  return createHash('sha256').update(key).digest();
}

function decryptWith(key: Buffer, data: string): string {
  const buf = Buffer.from(data, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Cifra una cadena con AES-256-GCM y la devuelve en base64 (iv|tag|ciphertext). */
export function encrypt(plain: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decrypt(data: string): string {
  try {
    return decryptWith(getKey(), data);
  } catch (err) {
    // Compatibilidad con datos antiguos cifrados con la clave legacy de desarrollo.
    const legacy = createHash('sha256').update('bitsobot-dev-key').digest();
    try {
      return decryptWith(legacy, data);
    } catch {
      throw err;
    }
  }
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

export function hmacSha256Hex(secret: string, message: string): string {
  return createHmac('sha256', secret).update(message).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
