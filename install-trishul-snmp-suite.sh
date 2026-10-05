#!/bin/bash
# install-trishul-snmp-suite.sh - Deploy Trishul SNMP Suite from GHCR or local source
# Usage: ./install-trishul-snmp-suite.sh <command> [--platform PLATFORM] [--image IMAGE]

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

read_env_default() {
    local key="$1"
    local fallback="$2"
    local value=""

    if [ -f "$ENV_FILE" ]; then
        value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2-)"
    fi

    if [ -n "$value" ]; then
        printf '%s\n' "$value"
    else
        printf '%s\n' "$fallback"
    fi
}

join_by() {
    local separator="$1"
    shift
    local first=1
    local item

    for item in "$@"; do
        if [ $first -eq 1 ]; then
            printf '%s' "$item"
            first=0
        else
            printf '%s%s' "$separator" "$item"
        fi
    done
    printf '\n'
}

DEFAULT_APP_VERSION="$(read_env_default APP_VERSION 2.2.0)"
DEFAULT_APP_PORT="$(read_env_default APP_PORT 8980)"
DEFAULT_FRONTEND_PORT="$(read_env_default FRONTEND_PORT "$DEFAULT_APP_PORT")"
DEFAULT_BACKEND_PORT="$(read_env_default BACKEND_PORT "")"
DEFAULT_SNMP_PORT="$(read_env_default SNMP_PORT 1061)"
DEFAULT_TRAP_PORT="$(read_env_default TRAP_PORT 1162)"
DEFAULT_LOG_DESTINATION="$(read_env_default LOG_DESTINATION stdout)"
DEFAULT_DOCKER_LOG_MAX_SIZE="$(read_env_default DOCKER_LOG_MAX_SIZE 10m)"
DEFAULT_DOCKER_LOG_MAX_FILE="$(read_env_default DOCKER_LOG_MAX_FILE 5)"

APP_VERSION="${APP_VERSION:-${DEFAULT_APP_VERSION}}"

GHCR_USER="tosumitdhaka"
APP_GHCR_IMAGE="ghcr.io/${GHCR_USER}/trishul-snmp-suite:latest"
APP_LOCAL_IMAGE="trishul-snmp-suite-local:${APP_VERSION}"
CONTAINER_NAME="trishul-snmp-suite"
VOLUME_NAME="trishul-snmp-suite-data"
LEGACY_CONTAINER_BACKEND="trishul-snmp-backend"
LEGACY_CONTAINER_FRONTEND="trishul-snmp-frontend"
LEGACY_VOLUME_NAME="trishul-snmp-data"

EXPLICIT_APP_PORT="${APP_PORT:-}"
EXPLICIT_FRONTEND_PORT="${FRONTEND_PORT:-}"
EXPLICIT_BACKEND_PORT="${BACKEND_PORT:-}"

APP_PORT=""
BACKEND_COMPAT_PORT=""
SNMP_PORT="${SNMP_PORT:-${DEFAULT_SNMP_PORT}}"
TRAP_PORT="${TRAP_PORT:-${DEFAULT_TRAP_PORT}}"
CONTAINER_LOG_DESTINATION="${LOG_DESTINATION:-${DEFAULT_LOG_DESTINATION}}"
DOCKER_LOG_MAX_SIZE="${DOCKER_LOG_MAX_SIZE:-${DEFAULT_DOCKER_LOG_MAX_SIZE}}"
DOCKER_LOG_MAX_FILE="${DOCKER_LOG_MAX_FILE:-${DEFAULT_DOCKER_LOG_MAX_FILE}}"
IMAGE_SOURCE="${TRISHUL_IMAGE_SOURCE:-ghcr}"
IMAGE_OVERRIDE="${TRISHUL_IMAGE:-}"
DOCKER_PLATFORM="${DOCKER_PLATFORM:-${TRISHUL_DOCKER_PLATFORM:-}}"
SKIP_LEGACY_MIGRATION="${TRISHUL_SKIP_LEGACY_MIGRATION:-0}"
APP_IMAGE="$APP_GHCR_IMAGE"
COMMAND="up"
POSITIONAL_ARGS=()
RESTORE_FILE=""

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
ENV_ARGS=()

if [ -f "$ENV_FILE" ]; then
    ENV_ARGS+=(--env-file "$ENV_FILE")
fi

fail() {
    echo -e "${RED}Error: $*${NC}" >&2
    exit 1
}

normalize_platform() {
    case "${1:-}" in
        "")
            ;;
        linux/*)
            printf '%s\n' "$1"
            ;;
        amd64|arm64)
            printf 'linux/%s\n' "$1"
            ;;
        *)
            printf '%s\n' "$1"
            ;;
    esac
}

docker_platform_args() {
    if [ -n "$DOCKER_PLATFORM" ]; then
        printf '%s\n' --platform "$DOCKER_PLATFORM"
    fi
}

skip_legacy_migration_requested() {
    case "${SKIP_LEGACY_MIGRATION,,}" in
        1|true|yes|on)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

default_allowed_origins() {
    local origins=(
        "http://localhost:${APP_PORT}"
        "http://localhost:8000"
        "http://localhost:5173"
    )

    if [ -n "$BACKEND_COMPAT_PORT" ] && [ "$BACKEND_COMPAT_PORT" != "$APP_PORT" ]; then
        origins+=("http://localhost:${BACKEND_COMPAT_PORT}")
    fi

    join_by "," "${origins[@]}"
}

resolve_allowed_origins() {
    if [ -n "${ALLOWED_ORIGINS:-}" ]; then
        printf '%s\n' "$ALLOWED_ORIGINS"
        return 0
    fi

    default_allowed_origins
}

image_uses_ghcr() {
    case "$APP_IMAGE" in
        ghcr.io/*)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

refresh_app_image() {
    case "$IMAGE_SOURCE" in
        ghcr)
            APP_IMAGE="$APP_GHCR_IMAGE"
            ;;
        local)
            APP_IMAGE="$APP_LOCAL_IMAGE"
            ;;
        *)
            fail "Unsupported image source '$IMAGE_SOURCE'. Use 'ghcr' or 'local'."
            ;;
    esac

    if [ -n "$IMAGE_OVERRIDE" ]; then
        APP_IMAGE="$IMAGE_OVERRIDE"
    fi
}

set_image_source() {
    case "$1" in
        ghcr|local)
            IMAGE_SOURCE="$1"
            refresh_app_image
            ;;
        *)
            fail "Unsupported image source '$1'. Use 'ghcr' or 'local'."
            ;;
    esac
}

parse_cli_args() {
    while [ $# -gt 0 ]; do
        case "$1" in
            --image)
                [ $# -ge 2 ] || fail "--image requires a value."
                IMAGE_OVERRIDE="$2"
                shift 2
                ;;
            --platform)
                [ $# -ge 2 ] || fail "--platform requires a value."
                DOCKER_PLATFORM="$2"
                shift 2
                ;;
            --no-migrate)
                SKIP_LEGACY_MIGRATION=1
                shift
                ;;
            --help|-h|help)
                COMMAND="help"
                shift
                ;;
            --)
                shift
                while [ $# -gt 0 ]; do
                    POSITIONAL_ARGS+=("$1")
                    shift
                done
                ;;
            -*)
                fail "Unknown option '$1'."
                ;;
            *)
                POSITIONAL_ARGS+=("$1")
                shift
                ;;
        esac
    done
}

validate_command_args() {
    if [ "$COMMAND" = "restore" ]; then
        if [ ${#POSITIONAL_ARGS[@]} -gt 1 ]; then
            fail "restore accepts only one backup filename."
        fi
        RESTORE_FILE="${POSITIONAL_ARGS[0]:-}"
        return 0
    fi

    if [ ${#POSITIONAL_ARGS[@]} -gt 0 ]; then
        fail "Unexpected argument(s): ${POSITIONAL_ARGS[*]}"
    fi
}

show_usage() {
    echo "Usage: $0 <command> [--platform PLATFORM] [--image IMAGE] [--no-migrate]"
    echo ""
    echo "By default this script uses ghcr.io/${GHCR_USER}/trishul-snmp-suite:latest for published deployments."
    echo "Use --platform to select a specific manifest when pulling or running the selected image."
    echo "Use --image to override the published image reference or local build tag."
    echo ""
    echo "Commands:"
    echo "  up             - Pull GHCR image and start the suite"
    echo "  up-local       - Build the local image from this checkout and start the suite"
    echo "  down           - Stop and remove current or legacy containers"
    echo "  restart        - Stop then start the GHCR-backed suite container"
    echo "  restart-local  - Stop, rebuild local image, then start the suite container"
    echo "  pull           - Pull the selected image"
    echo "  build-local    - Build the local suite image only"
    echo "  logs           - Tail suite container logs"
    echo "  status         - Show container status, image, volume, and live app version"
    echo "  backup         - Backup the data volume to tar.gz"
    echo "  restore        - Restore data from backup"
    echo ""
    echo "CLI options:"
    echo "  --platform PLATFORM - Docker platform override, for example linux/amd64 or linux/arm64"
    echo "  --image IMAGE       - Override the image reference or local build tag"
    echo "  --no-migrate        - Skip automatic copy from legacy volume ${LEGACY_VOLUME_NAME}"
    echo ""
    echo "Environment variables:"
    echo "  APP_PORT                - Canonical app port (default: current deployed app port, else 8980)"
    echo "  FRONTEND_PORT           - Legacy alias for APP_PORT"
    echo "  BACKEND_PORT            - Optional compatibility port mapped to the same app"
    echo "  SNMP_PORT               - SNMP UDP port (default: 1061)"
    echo "  TRAP_PORT               - Trap receiver UDP port (default: 1162)"
    echo "  LOG_DESTINATION         - App log destination inside the container (default: stdout)"
    echo "  DOCKER_LOG_MAX_SIZE     - Docker json-file max-size rotation limit (default: 10m)"
    echo "  DOCKER_LOG_MAX_FILE     - Docker json-file max-file rotation count (default: 5)"
    echo "  APP_VERSION             - Local image tag override (default: .env APP_VERSION)"
    echo "  GHCR_TOKEN              - GitHub PAT for GHCR if needed"
    echo "  TRISHUL_IMAGE_SOURCE    - ghcr or local (default: ghcr)"
    echo "  TRISHUL_IMAGE           - Image reference override"
    echo "  DOCKER_PLATFORM         - Docker platform override"
    echo "  TRISHUL_DOCKER_PLATFORM - Alternate env name for Docker platform override"
    echo "  TRISHUL_SKIP_LEGACY_MIGRATION - Set to 1/true/yes/on to skip legacy volume migration"
    echo ""
    echo "Examples:"
    echo "  $0 up"
    echo "  $0 up --platform linux/arm64"
    echo "  $0 up --image ghcr.io/${GHCR_USER}/trishul-snmp-suite:latest"
    echo "  $0 up-local --image trishul-snmp-suite-local:test-arm --platform linux/arm64"
    echo "  APP_PORT=9080 $0 up-local"
    echo "  APP_PORT=9080 BACKEND_PORT=9000 $0 up-local"
    echo "  BACKEND_PORT=none $0 restart-local"
    echo "  FRONTEND_PORT=9080 BACKEND_PORT=9000 $0 up-local --no-migrate"
    echo "  $0 backup"
}

require_commands() {
    command -v docker >/dev/null 2>&1 || fail "docker is not installed or not in PATH"
    command -v python3 >/dev/null 2>&1 || fail "python3 is not installed or not in PATH"
}

docker_accessible() {
    docker ps >/dev/null 2>&1
}

container_available_for_inspection() {
    command -v docker >/dev/null 2>&1 \
        && docker_accessible \
        && docker inspect "$CONTAINER_NAME" >/dev/null 2>&1
}

container_label_value() {
    local label_key="$1"
    local value=""

    if ! container_available_for_inspection; then
        return 0
    fi

    value="$(docker inspect "$CONTAINER_NAME" --format "{{ with index .Config.Labels \"$label_key\" }}{{ . }}{{ end }}" 2>/dev/null || true)"
    printf '%s\n' "$value"
}

normalize_optional_port_value() {
    case "${1:-}" in
        ""|none|NONE|off|OFF|false|FALSE|disable|DISABLE|disabled|DISABLED|0)
            printf '\n'
            ;;
        *)
            printf '%s\n' "$1"
            ;;
    esac
}

resolve_running_app_port() {
    local label_value=""
    label_value="$(container_label_value "trishul.app_port")"
    if [ -n "$label_value" ]; then
        printf '%s\n' "$label_value"
        return 0
    fi

    local ports=()
    mapfile -t ports < <(discover_running_http_ports)
    if [ ${#ports[@]} -eq 0 ]; then
        return 0
    fi

    local port
    for port in "${ports[@]}"; do
        if [ "$port" = "$DEFAULT_FRONTEND_PORT" ]; then
            printf '%s\n' "$port"
            return 0
        fi
    done

    printf '%s\n' "${ports[$((${#ports[@]} - 1))]}"
}

resolve_running_compat_port() {
    local primary_port="$1"
    local label_value=""
    label_value="$(normalize_optional_port_value "$(container_label_value "trishul.compat_port")")"
    if [ -n "$label_value" ]; then
        printf '%s\n' "$label_value"
        return 0
    fi

    local ports=()
    mapfile -t ports < <(discover_running_http_ports)
    if [ ${#ports[@]} -eq 0 ]; then
        return 0
    fi

    local port
    for port in "${ports[@]}"; do
        if [ -n "$primary_port" ] && [ "$port" = "$primary_port" ]; then
            continue
        fi
        printf '%s\n' "$port"
        return 0
    done
}

resolve_port_configuration() {
    local resolved_app_port=""
    local resolved_compat_port=""

    if [ -n "$EXPLICIT_APP_PORT" ]; then
        resolved_app_port="$EXPLICIT_APP_PORT"
    elif [ -n "$EXPLICIT_FRONTEND_PORT" ]; then
        resolved_app_port="$EXPLICIT_FRONTEND_PORT"
    else
        resolved_app_port="$(resolve_running_app_port)"
        if [ -z "$resolved_app_port" ]; then
            resolved_app_port="$DEFAULT_FRONTEND_PORT"
        fi
    fi

    if [ -n "$EXPLICIT_BACKEND_PORT" ]; then
        resolved_compat_port="$(normalize_optional_port_value "$EXPLICIT_BACKEND_PORT")"
    else
        resolved_compat_port="$(normalize_optional_port_value "$(resolve_running_compat_port "$resolved_app_port")")"
        if [ -z "$resolved_compat_port" ]; then
            resolved_compat_port="$(normalize_optional_port_value "$DEFAULT_BACKEND_PORT")"
        fi
    fi

    if [ -n "$resolved_compat_port" ] && [ "$resolved_compat_port" = "$resolved_app_port" ]; then
        resolved_compat_port=""
    fi

    APP_PORT="$resolved_app_port"
    BACKEND_COMPAT_PORT="$resolved_compat_port"
}

check_ghcr_login() {
    mapfile -t DOCKER_PLATFORM_ARGS < <(docker_platform_args)
    docker pull "${DOCKER_PLATFORM_ARGS[@]}" "$APP_IMAGE" >/dev/null 2>&1
}

login_ghcr() {
    echo -e "${BLUE}Checking GHCR access for ${APP_IMAGE}...${NC}"
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
        fail "Failed to access image ${APP_IMAGE}"
    fi
}

pull_images() {
    require_commands
    set_image_source "ghcr"
    if image_uses_ghcr; then
        login_ghcr
    fi

    mapfile -t DOCKER_PLATFORM_ARGS < <(docker_platform_args)
    echo "Pulling image..."
    if [ -n "$DOCKER_PLATFORM" ]; then
        echo "   Platform:     $DOCKER_PLATFORM"
    fi
    echo "   Image:        $APP_IMAGE"
    docker pull "${DOCKER_PLATFORM_ARGS[@]}" "$APP_IMAGE"
    echo -e "${GREEN}Image pulled${NC}"
}

build_local_images() {
    require_commands
    set_image_source "local"
    mapfile -t DOCKER_PLATFORM_ARGS < <(docker_platform_args)

    echo "Building local image from repo source..."
    echo "   Repo root:    $SCRIPT_DIR"
    echo "   App version:  $APP_VERSION"
    echo "   App image:    $APP_IMAGE"
    if [ -n "$DOCKER_PLATFORM" ]; then
        echo "   Platform:     $DOCKER_PLATFORM"
    fi
    docker build "${DOCKER_PLATFORM_ARGS[@]}" -t "$APP_IMAGE" "$SCRIPT_DIR"
    echo -e "${GREEN}Local image built${NC}"
}

prepare_images() {
    if [ "$IMAGE_SOURCE" = "local" ]; then
        build_local_images
    else
        pull_images
    fi
}

volume_exists() {
    docker volume inspect "$1" >/dev/null 2>&1
}

volume_has_data() {
    local volume_name="$1"
    mapfile -t DOCKER_PLATFORM_ARGS < <(docker_platform_args)
    docker run --rm \
        "${DOCKER_PLATFORM_ARGS[@]}" \
        -v "${volume_name}:/data" \
        "$APP_IMAGE" \
        sh -c 'find /data -mindepth 1 -print -quit 2>/dev/null | grep -q .'
}

ensure_volume() {
    if ! volume_exists "$VOLUME_NAME"; then
        echo "Creating Docker volume: $VOLUME_NAME"
        docker volume create "$VOLUME_NAME" >/dev/null
        echo -e "${GREEN}Volume created${NC}"
    fi
}

migrate_legacy_volume() {
    if skip_legacy_migration_requested; then
        echo -e "${BLUE}Skipping legacy volume migration by request.${NC}"
        return 0
    fi

    if ! volume_exists "$LEGACY_VOLUME_NAME"; then
        return 0
    fi

    ensure_volume

    if volume_has_data "$VOLUME_NAME"; then
        echo -e "${BLUE}Target volume already contains data; skipping legacy copy.${NC}"
        return 0
    fi

    mapfile -t DOCKER_PLATFORM_ARGS < <(docker_platform_args)
    echo -e "${BLUE}Migrating data from ${LEGACY_VOLUME_NAME} to ${VOLUME_NAME}...${NC}"
    docker run --rm \
        "${DOCKER_PLATFORM_ARGS[@]}" \
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
    urllib.request.urlopen('http://127.0.0.1:${port}/api/health', timeout=2)
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

discover_running_http_ports() {
    if ! container_available_for_inspection; then
        return 0
    fi
    docker port "$CONTAINER_NAME" 8000/tcp 2>/dev/null | awk -F: '{print $NF}' | awk 'NF' | sort -n | uniq
}

status_probe_ports() {
    local ports=()
    local seen=""
    local port

    for port in "$APP_PORT" "$BACKEND_COMPAT_PORT"; do
        if [ -n "$port" ] && [[ ",$seen," != *",$port,"* ]]; then
            ports+=("$port")
            seen="${seen},${port}"
        fi
    done

    while IFS= read -r port; do
        if [ -n "$port" ] && [[ ",$seen," != *",$port,"* ]]; then
            ports+=("$port")
            seen="${seen},${port}"
        fi
    done < <(discover_running_http_ports)

    printf '%s\n' "${ports[@]}"
}

probe_meta_version_for_port() {
    local port="$1"
    python3 -c "
import urllib.request, json
try:
    response = urllib.request.urlopen('http://127.0.0.1:${port}/api/meta', timeout=3)
    print(json.loads(response.read()).get('version', 'unknown'))
except Exception:
    print('unavailable')
" 2>/dev/null
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
    echo "Image:         ${APP_IMAGE}"
    if [ -n "$DOCKER_PLATFORM" ]; then
        echo "Platform:      ${DOCKER_PLATFORM}"
    fi
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
    mapfile -t DOCKER_PLATFORM_ARGS < <(docker_platform_args)

    echo "Starting container..."
    echo "   Image source: $IMAGE_SOURCE"
    echo "   Image:        $APP_IMAGE"
    echo "   App port:     $APP_PORT"
    if [ -n "$BACKEND_COMPAT_PORT" ] && [ "$BACKEND_COMPAT_PORT" != "$APP_PORT" ]; then
        echo "   Compat port:  $BACKEND_COMPAT_PORT"
    fi
    echo "   SNMP port:    $SNMP_PORT/udp"
    echo "   Trap port:    $TRAP_PORT/udp"
    echo "   Data volume:  $VOLUME_NAME"
    echo "   Log mode:     $CONTAINER_LOG_DESTINATION"
    echo "   Log rotate:   ${DOCKER_LOG_MAX_SIZE} x ${DOCKER_LOG_MAX_FILE}"
    if [ -n "$DOCKER_PLATFORM" ]; then
        echo "   Platform:     $DOCKER_PLATFORM"
    fi

    docker run -d \
        "${DOCKER_PLATFORM_ARGS[@]}" \
        --name "$CONTAINER_NAME" \
        --label "trishul.app_port=${APP_PORT}" \
        --label "trishul.compat_port=${BACKEND_COMPAT_PORT}" \
        --log-driver json-file \
        --log-opt "max-size=${DOCKER_LOG_MAX_SIZE}" \
        --log-opt "max-file=${DOCKER_LOG_MAX_FILE}" \
        "${ENV_ARGS[@]}" \
        -e PYTHONUNBUFFERED=1 \
        -e TRISHUL_CONTAINER=1 \
        -e LOG_DESTINATION="${CONTAINER_LOG_DESTINATION}" \
        -e ALLOWED_ORIGINS="$(resolve_allowed_origins)" \
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
    local docker_ok=0
    if docker_accessible; then
        docker_ok=1
    fi

    echo "Container status:"
    if [ "$docker_ok" -eq 1 ]; then
        docker ps --filter "name=${CONTAINER_NAME}" --format "table {{.Names}}\t{{.Status}}\t{{.Image}}" 2>/dev/null || true
    else
        echo "Docker API unavailable (daemon not reachable or permission denied)"
    fi
    echo ""
    echo "Requested configuration:"
    echo "   Image source: $IMAGE_SOURCE"
    echo "   Image:        $APP_IMAGE"
    echo "   App port:     $APP_PORT"
    if [ -n "$BACKEND_COMPAT_PORT" ] && [ "$BACKEND_COMPAT_PORT" != "$APP_PORT" ]; then
        echo "   Compat port:  $BACKEND_COMPAT_PORT"
    fi
    echo "   SNMP port:    $SNMP_PORT/udp"
    echo "   Trap port:    $TRAP_PORT/udp"
    echo "   Data volume:  $VOLUME_NAME"
    echo "   Log mode:     $CONTAINER_LOG_DESTINATION"
    echo "   Log rotate:   ${DOCKER_LOG_MAX_SIZE} x ${DOCKER_LOG_MAX_FILE}"
    echo "   Platform:     ${DOCKER_PLATFORM:-auto}"
    if [ "$docker_ok" -eq 1 ] && volume_exists "$VOLUME_NAME"; then
        local mount_point
        mount_point=$(docker volume inspect "$VOLUME_NAME" --format '{{.Mountpoint}}')
        echo "   Volume path:  $mount_point"
    fi
    echo ""
    echo "Running container:"
    if [ "$docker_ok" -ne 1 ]; then
        echo "   Docker:       unavailable"
        echo "   App version:  unavailable"
        return 0
    fi

    local running_image
    running_image=$(docker inspect "$CONTAINER_NAME" --format '{{.Config.Image}}' 2>/dev/null || true)
    if [ -n "$running_image" ]; then
        echo "   Image:        $running_image"
    else
        echo "   Image:        not running"
    fi

    local running_http_ports=()
    mapfile -t running_http_ports < <(discover_running_http_ports)
    if [ ${#running_http_ports[@]} -gt 0 ]; then
        local joined_ports
        joined_ports="$(join_by ', ' "${running_http_ports[@]}")"
        echo "   Host ports:   ${joined_ports}"
    fi

    local version="unavailable"
    local version_port=""
    local port
    while IFS= read -r port; do
        [ -n "$port" ] || continue
        version=$(probe_meta_version_for_port "$port")
        if [ "$version" != "unavailable" ]; then
            version_port="$port"
            break
        fi
    done < <(status_probe_ports)

    if [ -n "$version_port" ]; then
        echo "   App version:  ${version} (via ${version_port})"
    else
        echo "   App version:  ${version}"
    fi
}

backup_data() {
    require_commands
    mapfile -t DOCKER_PLATFORM_ARGS < <(docker_platform_args)
    local backup_file="trishul-snmp-suite-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
    echo "Creating backup: $backup_file"
    docker run --rm \
        "${DOCKER_PLATFORM_ARGS[@]}" \
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
        fail "backup file not specified. Usage: $0 restore <backup-file.tar.gz>"
    fi
    if [ ! -f "$backup_file" ]; then
        fail "backup file not found: ${backup_file}"
    fi

    mapfile -t DOCKER_PLATFORM_ARGS < <(docker_platform_args)
    stop_container
    ensure_volume
    echo "Restoring from: $backup_file"
    docker run --rm \
        "${DOCKER_PLATFORM_ARGS[@]}" \
        -v "${VOLUME_NAME}:/data" \
        -v "${PWD}:/backup" \
        "$APP_IMAGE" \
        sh -c "rm -rf /data/* && tar xzf /backup/${backup_file} -C /data"
    echo -e "${GREEN}Data restored${NC}"
    echo -e "${BLUE}Run '$0 up' or '$0 up-local' to restart.${NC}"
}

if [ $# -gt 0 ]; then
    COMMAND="$1"
    shift
fi

parse_cli_args "$@"
DOCKER_PLATFORM="$(normalize_platform "$DOCKER_PLATFORM")"
validate_command_args
resolve_port_configuration
set_image_source "$IMAGE_SOURCE"

case "$COMMAND" in
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
    restore)        restore_data "$RESTORE_FILE" ;;
    help|-h|--help) show_usage ;;
    *)
        show_usage
        exit 1
        ;;
esac
