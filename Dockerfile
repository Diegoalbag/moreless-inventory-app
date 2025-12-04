FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies (including dev dependencies for build)
RUN npm ci && npm cache clean --force

# Copy source code
COPY . .

# Generate Prisma client (migrations will run at startup)
RUN npx prisma generate

# Build the app
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --production

# Start the server (run migrations first)
CMD ["sh", "-c", "npm run setup && npm run start"]
