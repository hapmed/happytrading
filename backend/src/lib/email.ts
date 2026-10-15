import nodemailer from 'nodemailer';
import { prisma } from './prisma.js';

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from?: string;
}

export async function getSmtpSettings(): Promise<SmtpSettings | null> {
  const s = await prisma.setting.findUnique({ where: { key: 'smtp' } });
  if (!s) return null;
  const v = s.value as Partial<SmtpSettings>;
  if (!v?.host) return null;
  return {
    host: v.host,
    port: Number(v.port ?? 587),
    secure: v.secure === true || v.secure === 'true',
    user: v.user,
    pass: v.pass,
    from: v.from,
  };
}

export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
  const smtp = await getSmtpSettings();
  if (!smtp) throw new Error('SMTP no configurado');
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  await transporter.sendMail({
    from: smtp.from ?? 'HappyTrading <noreply@happytrading.app>',
    to,
    subject,
    text,
    html,
  });
}
