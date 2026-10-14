# Exemplo de empacotamento FUTURO: não usar até revisão de segurança, auth e lockfile.
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
FROM node:22-alpine
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3333
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY specs/foundation ./specs/foundation
USER node
EXPOSE 3333
CMD ["node", "dist/server.js"]
