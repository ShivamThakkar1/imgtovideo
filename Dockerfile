FROM node:18-alpine

# Install FFmpeg and fonts
RUN apk add --no-cache \
    ffmpeg \
    ttf-dejavu \
    && rm -rf /var/cache/apk/*

# Create app directory
WORKDIR /usr/src/app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy app source
COPY . .

# Create directories for temp and output files
RUN mkdir -p temp output && \
    chmod 755 temp output

# Add healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Expose port
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
