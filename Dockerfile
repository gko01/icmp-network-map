# ─── Build stage ────────────────────────────────────────────────────────────
FROM python:3.13-slim AS builder

WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# ─── Runtime stage ───────────────────────────────────────────────────────────
FROM python:3.13-slim

LABEL org.opencontainers.image.title="ICMP Network Map" \
      org.opencontainers.image.description="Browser-based ICMP ping topology monitor" \
      org.opencontainers.image.authors="garykoys"

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Create app directory and a non-root user
RUN useradd -m -u 1000 appuser
WORKDIR /app

# Copy application source
COPY app.py pinger.py ./
COPY templates/ templates/
COPY static/ static/

# Data directory — devices.json lives here and is mounted as a volume
RUN mkdir -p /data && chown appuser:appuser /data

# Give appuser permission to the app dir
RUN chown -R appuser:appuser /app

# ICMP raw sockets require NET_RAW capability (granted at runtime via cap_add).
# The container still runs as a non-root user for everything else.
USER appuser

ENV DEVICES_FILE=/data/devices.json \
    LINKS_FILE=/data/links.json \
    FLASK_HOST=0.0.0.0 \
    FLASK_PORT=5000 \
    PING_INTERVAL=10 \
    FLASK_HTTPS=false

EXPOSE 5000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "
import os, urllib.request, ssl
port = os.environ.get('FLASK_PORT', '5000')
if os.environ.get('FLASK_HTTPS', 'false').lower() == 'true':
    ctx = ssl._create_unverified_context()
    urllib.request.urlopen(f'https://localhost:{port}/api/devices', context=ctx)
else:
    urllib.request.urlopen(f'http://localhost:{port}/api/devices')
" || exit 1

CMD ["python", "app.py"]
