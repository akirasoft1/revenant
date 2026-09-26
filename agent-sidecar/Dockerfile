# agent-sidecar/Dockerfile
FROM python:3.14-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY proto/ ./proto/

ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app:/app/src

USER 1000
EXPOSE 50051
CMD ["python", "-m", "src.server"]
