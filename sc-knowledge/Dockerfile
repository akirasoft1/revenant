FROM python:3.14-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ src/
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app
USER 1000
EXPOSE 8080
CMD ["python", "-m", "src.server"]
