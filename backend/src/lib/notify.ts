import { prisma } from './prisma.js';
import { getSmtpSettings, sendMail } from './email.js';

/** Guarda una notificación y, si hay SMTP, envía el correo. */
export async function queueNotification(
  userId: string,
  type: string,
  subject: string,
  body: string,
): Promise<void> {
  const notif = await prisma.notification.create({
    data: { userId, type, subject, body },
  });

  const smtp = await getSmtpSettings();
  if (!smtp) {
    await prisma.notification.update({ where: { id: notif.id }, data: { status: 'FAILED' } });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  try {
    await sendMail(user.email, subject, body);
    await prisma.notification.update({
      where: { id: notif.id },
      data: { status: 'SENT', sentAt: new Date() },
    });
  } catch (err) {
    await prisma.notification.update({ where: { id: notif.id }, data: { status: 'FAILED' } });
    console.error('[notify] error enviando correo:', (err as Error).message);
  }
}
