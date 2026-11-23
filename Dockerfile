# One image, two roles: `npm run start` serves the app, `npm run worker` consumes the queue.
# Keeping them in one image means the worker and the API cannot drift apart on schema or
# pipeline code, which is the usual failure when they are built separately.

FROM node:22-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# Dependencies first, so a code change does not reinstall node_modules.
COPY package.json package-lock.json* ./
RUN npm ci || npm install

COPY . .

# Next.js inlines NEXT_PUBLIC_* into the client bundle at build time, so Clerk's publishable key
# has to be present when `next build` runs, not only at run time. docker-compose.yml passes it in
# from .env as a build arg. It is a publishable key, safe to appear in the bundle by design.
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ENV NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=${NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY}
RUN npm run build

RUN mkdir -p /data/uploads

EXPOSE 3000
CMD ["npm", "run", "start"]
