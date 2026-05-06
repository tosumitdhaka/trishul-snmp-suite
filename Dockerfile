FROM python:3.10-slim

RUN apt-get update && apt-get install -y \
    snmp \
    procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY backend/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY backend /app/backend
COPY frontend/src /app/frontend/src

RUN sed -i 's/^mibs :/# mibs :/' /etc/snmp/snmp.conf && \
    echo "mibdirs +/app/backend/data/mibs" >> /etc/snmp/snmp.conf && \
    echo "mibs +ALL" >> /etc/snmp/snmp.conf

WORKDIR /app/backend

ENV MODULE_NAME="main"
ENV VARIABLE_NAME="app"
ENV PORT=8000

EXPOSE 8000 1061/udp 1162/udp

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
