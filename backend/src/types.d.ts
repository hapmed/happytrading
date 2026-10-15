import '@fastify/jwt';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; username?: string; role: string; type?: string };
    user: { sub: string; username?: string; role: string; type?: string };
  }
}
