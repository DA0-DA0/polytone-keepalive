# Stage 1: Get Node.js binaries and build dependencies
FROM node:22-alpine AS node-builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY keepalive-rly.ts ./

# Stage 2: Final image with rly-docker base
FROM ghcr.io/noahsaso/rly-docker:latest

# Copy Node.js binary from the alpine node image
COPY --from=node-builder /usr/local/bin/node /bin/node

# Copy entire node_modules with npm
COPY --from=node-builder /usr/local/lib/node_modules /usr/local/lib/node_modules

# Copy musl dynamic linker and essential libraries (alpine/musl compatible)
COPY --from=node-builder /lib/ld-musl-x86_64.so.1 /lib/
COPY --from=node-builder /lib/libc.musl-x86_64.so.1 /lib/
COPY --from=node-builder /usr/lib/libstdc++.so.6 /usr/lib/
COPY --from=node-builder /usr/lib/libgcc_s.so.1 /usr/lib/

# Set working directory
WORKDIR /home/relayer

# Copy the built application and dependencies from the builder stage
COPY --from=node-builder /app .

# Copy the entrypoint script
COPY --chmod=755 docker-entrypoint-polytone-keepalive.sh /home/relayer/docker-entrypoint-polytone-keepalive.sh

# Default command (can be overridden)
CMD ["/home/relayer/docker-entrypoint-polytone-keepalive.sh"]
