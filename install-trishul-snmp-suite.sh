#!/bin/bash
# install-trishul-snmp-suite.sh - Deploy Trishul SNMP Suite from GHCR or local source
# Usage: ./install-trishul-snmp-suite.sh [up|up-local|down|restart|restart-local|pull|build-local|logs|status|backup|restore]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
DEFAULT_APP_VERSION="$(grep -E '^APP_VERSION=' "$ENV_FILE" 2>/dev/null | head -n1 | cut -d= -f2-)"
APP_VERSION="${APP_VERSION:-${DEFAULT_APP_VERSION:-1.4.0}}"

GHCR_USER="tosumitdhaka"
APP_GHCR_IMAGE="ghcr.io/${GHCR_USER}/trishul-snmp-suite:latest"
APP_LOCAL_IMAGE="trishul-snmp-suite-local:${APP_VERSION}"
CONTAINER_NAME="trishul-snmp-suite"
VOLUME_NAME="trishul-snmp-suite-data"
LEGACY_CONTAINER_BACKEND="trishul-snmp-backend"
LEGACY_CONTAINER_FRONTEND="trishul-snmp-frontend"
LEGACY_VOLUME_NAME="trishul-snmp-data"

APP_PORT="${APP_PORT:-${FRONTEND_PORT:-8080}}"
BACKEND_COMPAT_PORT="${BACKEND_PORT:-}"
SNMP_PORT="${SNMP_PORT:-1061}"
TRAP_PORT="${TRAP_PORT:-1162}"
IMAGE_SOURCE="${TRISHUL_IMAGE_SOURCE:-ghcr}"
APP_IMAGE="$APP_GHCR_IMAGE"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ENV_ARGS=()

if [ -f "$ENV_FILE" ]; then
    ENV_ARGS+=(--env-file "$ENV_FILE")
fi

set_image_source() {
    case "$1" in
        ghcr)
            IMAGE_SOURCE="ghcr"
            APP_IMAGE="$APP_GHCR_IMAGE"
            ;;
        local)
            IMAGE_SOURCE="local"
            APP_IMAGE="$APP_LOCAL_IMAGE"
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

check_ghcr_login() {
    docker pull "$APP_IMAGE" >/dev/null 2>&1
}

login_ghcr() {
    echo -e "${BLUE}Checking GHCR access...${NC}"
    if check_ghcr_login; then
        echo -e "${GREEN}GHCR access OK${NC}"
        return 0
    fi
    echo -e "${YELLOW}Authentication may be required${NC}"
    if [ -n "$GHCR_TOKEN" ]; then
        echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
    else
        echo ""
        echo -e "${BLUE}Enter GitHub PAT (or press Enter to skip):${NC}"
        read -r -s -p "Token: " token
        echo ""
        if [ -n "$token" ]; then
            echo "$token" | docker login ghcr.io -u "$GHCR_USER" --password-stdin
        else
            echo -e "${YELLOW}Skipping login...${NC}"
        fi
    fi
    if check_ghcr_login; then
        echo -e "${GREEN}GHCR login successful${NC}"
    else
        echo -e "${RED}Failed to access image ${APP_IMAGE}${NC}"
        exit 1
    fi
}

pull_images() {
    require_commands
    set_image_source "ghcr"
    login_ghcr
    echo "Pulling image..."
    docker pull "$APP_IMAGE"
    echo -e "${GREEN}Image pulled${NC}"
}

build_local_images() {
    require_commands
    set_image_source "local"
    echo "Building local image from repo source..."
    echo "   Repo root:    $SCRIPT_DIR"
    echo "   App version:  $APP_VERSION"
    echo "   App image:    $APP_IMAGE"
    docker build -t "$APP_IMAGE" "$SCRIPT_DIR"
    echo -e "${GREEN}Local image built${NC}"
}

prepare_images() {
    if [ "$IMAGE_SOURCE" = "local" ]; then
        build_local_images
    else
        pull_images
    fi
}

container_exists() {
    docker container inspect "$1" >/dev/null 2>&1
}

volume_exists() {
    docker volume inspect "$1" >/dev/null 2>&1
}

volume_has_data() {
    local volume_name="$1"
    docker run --rm -v "${volume_name}:/data" "$APP_IMAGE" sh -c 'find /data -mindepth 1 -print -quit 2>/dev/null | grep -q .'
}

ensure_volume() {
    if ! volume_exists "$VOLUME_NAME"; then
        echo "Creating Docker volume: $VOLUME_NAME"
        docker volume create "$VOLUME_NAME" >/dev/null
        echo -e "${GREEN}Volume created${NC}"
    fi
}

migrate_legacy_volume() {
    if ! volume_exists "$LEGACY_VOLUME_NAME"; then
        return 0
    fi

    ensure_volume

    if volume_has_data "$VOLUME_NAME"; then
        echo -e "${BLUE}Target volume already contains data; skipping legacy copy.${NC}"
        return 0
    fi

    echo -e "${BLUE}Migrating data from ${LEGACY_VOLUME_NAME} to ${VOLUME_NAME}...${NC}"
    docker run --rm \
        -v "${LEGACY_VOLUME_NAME}:/from" \
        -v "${VOLUME_NAME}:/to" \
        "$APP_IMAGE" \
        sh -c 'cp -a /from/. /to/'
    echo -e "${GREEN}Legacy volume copied. Old volume preserved for rollback.${NC}"
}

cleanup_legacy_containers() {
    docker stop "$LEGACY_CONTAINER_BACKEND" "$LEGACY_CONTAINER_FRONTEND" 2>/dev/null || true
    docker rm "$LEGACY_CONTAINER_BACKEND" "$LEGACY_CONTAINER_FRONTEND" 2>/dev/null || true
}

cleanup_current_container() {
    docker stop "$CONTAINER_NAME" 2>/dev/null || true
    docker rm "$CONTAINER_NAME" 2>/dev/null || true
}

port_args() {
    local args=(
        -p "${APP_PORT}:8000"
        -p "${SNMP_PORT}:${SNMP_PORT}/udp"
        -p "${TRAP_PORT}:${TRAP_PORT}/udp"
    )

    if [ -n "$BACKEND_COMPAT_PORT" ] && [ "$BACKEND_COMPAT_PORT" != "$APP_PORT" ]; then
        args+=(-p "${BACKEND_COMPAT_PORT}:8000")
    fi

    printf '%s\n' "${args[@]}"
}

wait_for_app() {
    local port="$1"
    echo -n "Waiting for application on port ${port}"
    local i=0
    while [ $i -lt 30 ]; do
        if python3 -c "
import urllib.request, sys
try:
    urllib.request.urlopen('http://localhost:${port}/api/health', timeout=2)
    sys.exit(0)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
            echo -e " ${GREEN}ready${NC}"
            return 0
        fi
        echo -n "."
        sleep 2
        i=$((i + 1))
    done
    echo -e " ${RED}timed out${NC}"
    return 1
}

print_access_info() {
    echo ""
    echo -e "${GREEN}Trishul SNMP Suite is running.${NC}"
    echo ""
    echo "App URL:       http://localhost:${APP_PORT}"
    echo "API docs:      http://localhost:${APP_PORT}/docs"
    if [ -n "$BACKEND_COMPAT_PORT" ] && [ "$BACKEND_COMPAT_PORT" != "$APP_PORT" ]; then
        echo "Compat URL:    http://localhost:${BACKEND_COMPAT_PORT}"
    fi
    echo "SNMP UDP:      ${SNMP_PORT}"
    echo "Trap UDP:      ${TRAP_PORT}"
    echo "Data volume:   ${VOLUME_NAME}"
    echo ""
    echo "Default login: admin / admin123"
    echo -e "${YELLOW}Change the default password in Settings after first login.${NC}"
    echo ""
}

run_container() {
    require_commands
    prepare_images
    ensure_volume
    cleanup_legacy_containers
    cleanup_current_container
    migrate_legacy_volume

    mapfile -t PORT_ARGS < <(port_args)

    echo "Starting container..."
    echo "   Image source: $IMAGE_SOURCE"
    echo "   App port:     $APP_PORT"
    if [ -n "$BACKEND_COMPAT_PORT" ] && [ "$BACKEND_COMPAT_PORT" != "$APP_PORT" ]; then
        echo "   Compat port:  $BACKEND_COMPAT_PORT"
    fi
    echo "   SNMP port:    $SNMP_PORT/udp"
    echo "   Trap port:    $TRAP_PORT/udp"
    echo "   Data volume:  $VOLUME_NAME"

    docker run -d \
        --name "$CONTAINER_NAME" \
        "${ENV_ARGS[@]}" \
        -e ALLOWED_ORIGINS="${ALLOWED_ORIGINS:-http://localhost:${APP_PORT},http://localhost:8000,http://localhost:8900,http://localhost:8980}" \
        -v "${VOLUME_NAME}:/app/backend/data" \
        --restart unless-stopped \
        "${PORT_ARGS[@]}" \
        "$APP_IMAGE"

    wait_for_app "$APP_PORT"
    print_access_info
}

stop_container() {
    require_commands
    echo "Stopping Trishul SNMP Suite..."
    cleanup_current_container
    cleanup_legacy_containers
    echo -e "${GREEN}Containers stopped${NC}"
}

restart_container() {
    stop_container
    run_container
}

show_logs() {
    require_commands
    echo -e "${BLUE}Container logs (Ctrl+C to exit):${NC}"
    docker logs -f "$CONTAINER_NAME"
}

show_status() {
    require_commands
    echo "Container status:"
    docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null || true
    echo ""
    echo "Configuration:"
    echo "   App port:     $APP_PORT"
    if [ -n "$BACKEND_COMPAT_PORT" ] && [ "$BACKEND_COMPAT_PORT" != "$APP_PORT" ]; then
        echo "   Compat port:  $BACKEND_COMPAT_PORT"
    fi
    echo "   SNMP port:    $SNMP_PORT/udp"
    echo "   Trap port:    $TRAP_PORT/udp"
    echo "   Data volume:  $VOLUME_NAME"
    if volume_exists "$VOLUME_NAME"; then
        local mount_point
        mount_point=$(docker volume inspect "$VOLUME_NAME" --format '{{.Mountpoint}}')
        echo "   Volume path:  $mount_point"
    fi
    echo ""
    echo "Running image:"
    docker inspect "$CONTAINER_NAME" --format "   App: {{.Config.Image}}" 2>/dev/null || echo "   App: not running"
    local version
    version=$(python3 -c "
import urllib.request, json
try:
    response = urllib.request.urlopen('http://localhost:${APP_PORT}/api/meta', timeout=3)
    print(json.loads(response.read()).get('version', 'unknown'))
except Exception:
    print('unavailable')
" 2>/dev/null)
    echo "   App version: ${version}"
}

backup_data() {
    require_commands
    local backup_file="trishul-snmp-suite-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    echo "Creating backup: $backup_file"
    docker run --rm \
        -v "${VOLUME_NAME}:/data" \
        -v "${PWD}:/backup" \
        "$APP_IMAGE" \
        tar czf "/backup/${backup_file}" -C /data .
    echo -e "${GREEN}Backup created: ${backup_file}${NC}"
}

restore_data() {
    require_commands
    local backup_file="$1"
    if [ -z "$backup_file" ]; then
        echo -e "${RED}Error: backup file not specified${NC}"
        echo "Usage: $0 restore <backup-file.tar.gz>"
        exit 1
    fi
    if [ ! -f "$backup_file" ]; then
        echo -e "${RED}Error: backup file not found: ${backup_file}${NC}"
        exit 1
    fi
    stop_container
    ensure_volume
    echo "Restoring from: $backup_file"
    docker run --rm \
        -v "${VOLUME_NAME}:/data" \
        -v "${PWD}:/backup" \
        "$APP_IMAGE" \
        sh -c "rm -rf /data/* && tar xzf /backup/${backup_file} -C /data"
    echo -e "${GREEN}Data restored${NC}"
    echo -e "${BLUE}Run '$0 up' or '$0 up-local' to restart.${NC}"
}

case "${1:-up}" in
    up)             run_container ;;
    up-local)       set_image_source "local"; run_container ;;
    down)           stop_container ;;
    restart)        restart_container ;;
    restart-local)  set_image_source "local"; restart_container ;;
    pull)           pull_images ;;
    build-local)    build_local_images ;;
    logs|logs-frontend) show_logs ;;
    status)         show_status ;;
    backup)         backup_data ;;
    restore)        restore_data "$2" ;;
    *)
        echo "Usage: $0 {up|up-local|down|restart|restart-local|pull|build-local|logs|status|backup|restore}"
        echo ""
        echo "Commands:"
        echo "  up             - Pull GHCR image and start the suite"
        echo "  up-local       - Build the local image from this checkout and start the suite"
        echo "  down           - Stop and remove current or legacy containers"
        echo "  restart        - Stop then start the GHCR-backed suite container"
        echo "  restart-local  - Stop, rebuild local image, then start the suite container"
        echo "  pull           - Pull the latest GHCR image"
        echo "  build-local    - Build the local suite image only"
        echo "  logs           - Tail suite container logs"
        echo "  status         - Show container status, image, volume, and live app version"
        echo "  backup         - Backup the data volume to tar.gz"
        echo "  restore        - Restore data from backup"
        echo ""
        echo "Environment variables:"
        echo "  APP_PORT       - Canonical app port (default: FRONTEND_PORT or 8080)"
        echo "  FRONTEND_PORT  - Legacy alias for APP_PORT"
        echo "  BACKEND_PORT   - Optional compatibility port mapped to the same app"
        echo "  SNMP_PORT      - SNMP UDP port (default: 1061)"
        echo "  TRAP_PORT      - Trap receiver UDP port (default: 1162)"
        echo "  APP_VERSION    - Local image tag override (default: .env APP_VERSION)"
        echo "  GHCR_TOKEN     - GitHub PAT for GHCR if needed"
        echo "  TRISHUL_IMAGE_SOURCE - ghcr or local (default: ghcr)"
        echo ""
        echo "Examples:"
        echo "  $0 up"
        echo "  $0 up-local"
        echo "  APP_PORT=8980 $0 up-local"
        echo "  FRONTEND_PORT=8980 BACKEND_PORT=8900 $0 up-local"
        echo "  $0 backup"
        exit 1
        ;;
esac
