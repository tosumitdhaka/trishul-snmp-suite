#!/bin/bash
# install-trishul-snmp.sh - Deploy Trishul SNMP from GHCR or local source
# Usage: ./install-trishul-snmp.sh [up|up-local|down|restart|restart-local|pull|build-local|logs|logs-frontend|status|backup|restore]

set -e

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
DEFAULT_APP_VERSION="$(grep -E '^APP_VERSION=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-)"
APP_VERSION="${APP_VERSION:-${DEFAULT_APP_VERSION:-1.3.0}}"

GHCR_USER="tosumitdhaka"
BACKEND_GHCR_IMAGE="ghcr.io/${GHCR_USER}/trishul-snmp-backend:latest"
FRONTEND_GHCR_IMAGE="ghcr.io/${GHCR_USER}/trishul-snmp-frontend:latest"
BACKEND_LOCAL_IMAGE="trishul-snmp-backend-local:${APP_VERSION}"
FRONTEND_LOCAL_IMAGE="trishul-snmp-frontend-local:${APP_VERSION}"
VOLUME_NAME="trishul-snmp-data"

BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-8080}"
IMAGE_SOURCE="${TRISHUL_IMAGE_SOURCE:-ghcr}"
BACKEND_IMAGE="$BACKEND_GHCR_IMAGE"
FRONTEND_IMAGE="$FRONTEND_GHCR_IMAGE"

# Scoped to port — no wildcard deletes  [fix #5]
NGINX_CONF_PATH="/tmp/trishul-nginx-${FRONTEND_PORT}.conf"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
BACKEND_ENV_ARGS=()

if [ -f "$ENV_FILE" ]; then
    BACKEND_ENV_ARGS+=(--env-file "$ENV_FILE")
fi

set_image_source() {
    case "$1" in
        ghcr)
            IMAGE_SOURCE="ghcr"
            BACKEND_IMAGE="$BACKEND_GHCR_IMAGE"
            FRONTEND_IMAGE="$FRONTEND_GHCR_IMAGE"
            ;;
        local)
            IMAGE_SOURCE="local"
            BACKEND_IMAGE="$BACKEND_LOCAL_IMAGE"
            FRONTEND_IMAGE="$FRONTEND_LOCAL_IMAGE"
            ;;
        *)
            echo -e "${RED}Error: Unsupported image source '$1'. Use 'ghcr' or 'local'.${NC}"
            exit 1
            ;;
    esac
}

require_commands() {
    command -v docker >/dev/null 2>&1 || {
        echo -e "${RED}Error: docker is not installed or not in PATH${NC}"
        exit 1
    }
    command -v python3 >/dev/null 2>&1 || {
        echo -e "${RED}Error: python3 is not installed or not in PATH${NC}"
        exit 1
    }
}

set_image_source "$IMAGE_SOURCE"

# ---------------------------------------------------------------------------
# GHCR Auth
# ---------------------------------------------------------------------------
check_ghcr_login() {
    docker pull "$BACKEND_IMAGE" >/dev/null 2>&1
}

login_ghcr() {
    echo -e "${BLUE}🔐 Checking GHCR access...${NC}"
    if check_ghcr_login; then
        echo -e "${GREEN}✅ GHCR access OK${NC}"; return 0
    fi
    echo -e "${YELLOW}⚠️  Authentication required${NC}"
    if [ -n "$GHCR_TOKEN" ]; then
        echo -e "${BLUE}Using GHCR_TOKEN from environment...${NC}"
        echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
    else
        echo ""
        echo -e "${BLUE}Enter GitHub PAT (or press Enter to skip):${NC}"
        read -r -s -p "Token: " token; echo ""
        [ -n "$token" ] && echo "$token" | docker login ghcr.io -u "$GHCR_USER" --password-stdin \
            || echo -e "${YELLOW}⚠️  Skipping login...${NC}"
    fi
    if check_ghcr_login; then
        echo -e "${GREEN}✅ GHCR login successful${NC}"
    else
        echo -e "${RED}❌ Failed to access images${NC}"; exit 1
    fi
}

pull_images() {
    require_commands
    set_image_source "ghcr"
    login_ghcr
    echo "📥 Pulling images..."
    docker pull "$BACKEND_IMAGE"
    docker pull "$FRONTEND_IMAGE"
    echo -e "${GREEN}✅ Images pulled${NC}"
}

build_local_images() {
    require_commands
    set_image_source "local"
    echo "🔨 Building local images from repo source..."
    echo "   Repo root:     $SCRIPT_DIR"
    echo "   App version:   $APP_VERSION"
    echo "   Backend image: $BACKEND_IMAGE"
    echo "   Frontend image: $FRONTEND_IMAGE"
    docker build -t "$BACKEND_IMAGE" "$SCRIPT_DIR/backend"
    docker build -t "$FRONTEND_IMAGE" "$SCRIPT_DIR/frontend"
    echo -e "${GREEN}✅ Local images built${NC}"
}

prepare_images() {
    if [ "$IMAGE_SOURCE" = "local" ]; then
        build_local_images
    else
        pull_images
    fi
}

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------
setup_environment() {
    require_commands
    if ! docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
        echo "📦 Creating Docker volume: $VOLUME_NAME"
        docker volume create "$VOLUME_NAME"
        echo -e "${GREEN}✅ Volume created${NC}"
    else
        echo -e "${GREEN}✅ Volume exists: $VOLUME_NAME${NC}"
    fi
}

write_nginx_conf() {
    cat > "$NGINX_CONF_PATH" << EOF
server {
    listen $FRONTEND_PORT;
    server_name localhost;
    client_max_body_size 50M;
    root /usr/share/nginx/html;
    index index.html;

    location / {
        try_files \$uri \$uri/ /index.html;
    }

    # WebSocket — must come before /api/ block  [fix #1]
    location /api/ws {
        proxy_pass http://localhost:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }

    # REST API
    location /api/ {
        proxy_pass http://localhost:$BACKEND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_connect_timeout 60s;
        proxy_read_timeout 120s;
    }

    location ~* \.html$ {
        add_header Cache-Control "no-store, no-cache, must-revalidate";
        expires off;
    }
}
EOF
    echo -e "${GREEN}✅ Nginx config written${NC}"
}

# ---------------------------------------------------------------------------
# Wait for backend before starting frontend  [fix #3]
# ---------------------------------------------------------------------------
wait_for_backend() {
    echo -n "⏳ Waiting for backend"
    local i=0
    while [ $i -lt 30 ]; do
        if python3 -c "
import urllib.request, sys
try:
    urllib.request.urlopen('http://localhost:${BACKEND_PORT}/api/health', timeout=2)
    sys.exit(0)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
            echo -e " ${GREEN}ready!${NC}"; return 0
        fi
        echo -n "."; sleep 2; i=$((i + 1))
    done
    echo -e " ${YELLOW}timed out — starting frontend anyway${NC}"
}

# ---------------------------------------------------------------------------
# Container lifecycle
# ---------------------------------------------------------------------------
cleanup_existing_containers() {
    docker stop trishul-snmp-backend trishul-snmp-frontend 2>/dev/null || true
    docker rm   trishul-snmp-backend trishul-snmp-frontend 2>/dev/null || true
}

run_containers() {
    require_commands
    prepare_images
    setup_environment
    write_nginx_conf

    echo "🚀 Starting containers..."
    echo "   Source:        $IMAGE_SOURCE"
    echo "   Backend port:  $BACKEND_PORT"
    echo "   Frontend port: $FRONTEND_PORT"
    echo "   Data volume:   $VOLUME_NAME"
    cleanup_existing_containers

    docker run -d \
        --name trishul-snmp-backend \
        --network host \
        "${BACKEND_ENV_ARGS[@]}" \
        -v "$VOLUME_NAME:/app/data" \
        --restart unless-stopped \
        "$BACKEND_IMAGE" \
        uvicorn main:app --host 0.0.0.0 --port "$BACKEND_PORT"

    wait_for_backend   # [fix #3]

    docker run -d \
        --name trishul-snmp-frontend \
        --network host \
        -v "$NGINX_CONF_PATH:/etc/nginx/conf.d/default.conf:ro" \
        --restart unless-stopped \
        "$FRONTEND_IMAGE"

    echo ""
    echo -e "${GREEN}✅ Trishul SNMP is running!${NC}"
    echo ""
    echo "🌐 Frontend:  http://localhost:$FRONTEND_PORT"
    echo "🔧 Backend:   http://localhost:$BACKEND_PORT/docs"
    echo "📦 Volume:    $VOLUME_NAME"
    echo ""
    echo "Default login: admin / admin123"
    echo -e "${YELLOW}⚠️  Change the default password immediately in Settings!${NC}"
    echo ""
}

stop_containers() {
    require_commands
    echo "🛑 Stopping containers..."
    cleanup_existing_containers
    rm -f "$NGINX_CONF_PATH"   # [fix #5] — scoped, not wildcard
    echo -e "${GREEN}✅ Containers stopped${NC}"
}

restart_containers() {
    stop_containers
    run_containers
}

# ---------------------------------------------------------------------------
# Logs  [fix #6 — added logs-frontend]
# ---------------------------------------------------------------------------
show_logs() {
    require_commands
    echo -e "${BLUE}📜 Backend logs (Ctrl+C to exit):${NC}"
    docker logs -f trishul-snmp-backend
}

show_frontend_logs() {
    require_commands
    echo -e "${BLUE}📜 Frontend (nginx) logs (Ctrl+C to exit):${NC}"
    docker logs -f trishul-snmp-frontend
}

# ---------------------------------------------------------------------------
# Status — includes image tags + live app version  [fix #7]
# ---------------------------------------------------------------------------
show_status() {
    require_commands
    echo "📊 Container status:"
    docker ps --filter "name=trishul-snmp" \
        --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null || true
    echo ""
    echo "⚙️  Configuration:"
    echo "   Backend port:  $BACKEND_PORT"
    echo "   Frontend port: $FRONTEND_PORT"
    echo "   Data volume:   $VOLUME_NAME"
    if docker volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
        local mount_point
        mount_point=$(docker volume inspect "$VOLUME_NAME" --format '{{.Mountpoint}}')
        echo "   Volume path:   $mount_point"
    fi
    echo ""
    echo "🏷️  Running images:"
    docker inspect trishul-snmp-backend  --format "   Backend:  {{.Config.Image}}" 2>/dev/null || echo "   Backend:  not running"
    docker inspect trishul-snmp-frontend --format "   Frontend: {{.Config.Image}}" 2>/dev/null || echo "   Frontend: not running"
    local version
    version=$(python3 -c "
import urllib.request, json, sys
try:
    r = urllib.request.urlopen('http://localhost:${BACKEND_PORT}/api/meta', timeout=3)
    print(json.loads(r.read()).get('version', 'unknown'))
except Exception:
    print('unavailable')
" 2>/dev/null)
    echo "   App version:  $version"
}

# ---------------------------------------------------------------------------
# Backup / Restore  [fix #8 — restore stops containers first]
# ---------------------------------------------------------------------------
backup_data() {
    require_commands
    local backup_file="trishul-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    echo "💾 Creating backup: $backup_file"
    docker run --rm \
        -v "$VOLUME_NAME:/data" \
        -v "$(pwd):/backup" \
        alpine tar czf "/backup/$backup_file" -C /data .
    echo -e "${GREEN}✅ Backup created: $backup_file${NC}"
}

restore_data() {
    require_commands
    local backup_file="$1"
    if [ -z "$backup_file" ]; then
        echo -e "${RED}Error: Backup file not specified${NC}"
        echo "Usage: $0 restore <backup-file.tar.gz>"; exit 1
    fi
    if [ ! -f "$backup_file" ]; then
        echo -e "${RED}Error: Backup file not found: $backup_file${NC}"; exit 1
    fi
    echo -e "${YELLOW}⚠️  Stopping containers before restore...${NC}"
    stop_containers
    echo "📥 Restoring from: $backup_file"
    docker run --rm \
        -v "$VOLUME_NAME:/data" \
        -v "$(pwd):/backup" \
        alpine sh -c "rm -rf /data/* && tar xzf /backup/$backup_file -C /data"
    echo -e "${GREEN}✅ Data restored${NC}"
    echo -e "${BLUE}💡 Run '$0 up' or '$0 up-local' to restart.${NC}"
}

# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
case "${1:-up}" in
    up)             run_containers ;;
    up-local)       set_image_source "local"; run_containers ;;
    down)           stop_containers ;;
    restart)        restart_containers ;;
    restart-local)  set_image_source "local"; restart_containers ;;
    pull)           pull_images ;;
    build-local)    build_local_images ;;
    logs)           show_logs ;;
    logs-frontend)  show_frontend_logs ;;
    status)         show_status ;;
    backup)         backup_data ;;
    restore)        restore_data "$2" ;;
    *)
        echo "Usage: $0 {up|up-local|down|restart|restart-local|pull|build-local|logs|logs-frontend|status|backup|restore}"
        echo ""
        echo "Commands:"
        echo "  up             - Pull GHCR images and start containers"
        echo "  up-local       - Build local images from this checkout and start containers"
        echo "  down           - Stop and remove containers"
        echo "  restart        - Stop then start GHCR-backed containers"
        echo "  restart-local  - Stop, rebuild local images, then start containers"
        echo "  pull           - Pull latest GHCR images"
        echo "  build-local    - Build local backend and frontend images only"
        echo "  logs           - Tail backend logs"
        echo "  logs-frontend  - Tail frontend (nginx) logs"
        echo "  status         - Show container status, image tags, app version"
        echo "  backup         - Backup data volume to tar.gz"
        echo "  restore        - Restore data from backup (stops containers first)"
        echo ""
        echo "Environment variables:"
        echo "  BACKEND_PORT   - Backend port (default: 8000)"
        echo "  FRONTEND_PORT  - Frontend port (default: 8080)"
        echo "  APP_VERSION    - Local image tag override (default: .env APP_VERSION)"
        echo "  GHCR_TOKEN     - GitHub PAT (optional, for private images)"
        echo "  TRISHUL_IMAGE_SOURCE - ghcr or local (default: ghcr)"
        echo ""
        echo "Examples:"
        echo "  $0 up"
        echo "  $0 up-local"
        echo "  TRISHUL_IMAGE_SOURCE=local $0 up"
        echo "  $0 status"
        echo "  $0 backup"
        echo "  $0 restore trishul-backup-20260222-123456.tar.gz"
        echo "  FRONTEND_PORT=3000 $0 up-local"
        exit 1
        ;;
esac
