FROM node:20-slim AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build


FROM python:3.12-slim

RUN apt-get update && apt-get install -y \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY alembic.ini /app/alembic.ini
COPY backend/requirements.txt /tmp/requirements.txt
# Upgrade pip first: the image's bundled pip 25.0.1 cannot parse the trishul
# packages' dev-extra metadata (packaging InvalidVersion: 'dev'); 26.x can.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /tmp/requirements.txt

COPY backend/alembic /app/backend/alembic
COPY backend/app /app/backend/app
COPY backend/mibs_bundled /app/backend/mibs_bundled
COPY --from=frontend-build /app/frontend/dist /app/frontend/dist

WORKDIR /app/backend

ENV PORT=8000

EXPOSE 8000 1061/udp 1162/udp

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
