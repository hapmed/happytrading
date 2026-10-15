# ===== Backend build =====
FROM node:20-alpine AS backend
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install
COPY backend/prisma ./prisma
COPY backend/src ./src
COPY backend/tsconfig.json backend/tsup.config.ts ./
RUN npx prisma generate
RUN npm run build

# ===== Frontend build =====
FROM node:20-alpine AS frontend
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install
COPY frontend .
RUN npm run build

# ===== Runtime (un solo contenedor: API + bot + web) =====
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=backend /app/node_modules ./node_modules
COPY --from=backend /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=backend /app/dist ./dist
COPY --from=backend /app/prisma ./prisma
COPY --from=backend /app/package.json ./package.json
COPY --from=frontend /web/dist ./public
COPY backend/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
EXPOSE 4000
ENTRYPOINT ["./entrypoint.sh"]
CMD ["node", "dist/server.js"]
