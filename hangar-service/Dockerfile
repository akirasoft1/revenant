FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin hangar
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ src/
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app PORT=8080
USER 10001
EXPOSE 8080
# Cloud Run injects $PORT; src.main reads it (default 8080).
CMD ["python", "-m", "src.main"]
