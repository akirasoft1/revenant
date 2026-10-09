# hangar-service + the hangar-editor web SPA in ONE image.
# BUILD CONTEXT = REPO ROOT (the editor lives next to the service):
#   docker build -f hangar-service/Dockerfile --build-arg GIT_SHA=$(git rev-parse --short HEAD) \
#     -t <image>:<sha> .
# The context is filtered by hangar-service/Dockerfile.dockerignore (allow-list:
# only hangar-service/requirements.txt + src/ and the hangar-editor sources; never
# .env*, key files, OrgGuides/ or node_modules).

# ---- stage 1: build the SPA (Vite 8 needs Node >= 22.12) ----
FROM node:24-slim AS editor
WORKDIR /app/hangar-editor
COPY hangar-editor/package.json hangar-editor/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY hangar-editor/ ./
# Optional Dynatrace RUM script URL baked into index.html (empty = no RUM tag).
# Its origins must also be allowed at runtime via HANGAR_RUM_ORIGINS (CSP).
ARG VITE_DT_RUM_SRC=""
RUN VITE_DT_RUM_SRC="$VITE_DT_RUM_SRC" npm run build

# ---- stage 2: the API (serves the SPA from /app/static) ----
FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin hangar
WORKDIR /app
COPY hangar-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY hangar-service/src/ src/
COPY --from=editor /app/hangar-editor/dist /app/static
# The git short SHA: reported by /health and /version.txt (deploys also pass
# HANGAR_VERSION=$SHA; an explicit env var wins).
ARG GIT_SHA=dev
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app PORT=8080 \
    HANGAR_STATIC_DIR=/app/static HANGAR_VERSION=${GIT_SHA}
USER 10001
EXPOSE 8080
# Cloud Run injects $PORT; src.main reads it (default 8080).
CMD ["python", "-m", "src.main"]
