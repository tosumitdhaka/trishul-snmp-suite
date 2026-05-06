# API Reference

This is the practical API reference for the merged `1.4.0` runtime.

## Base URLs

- App metadata: `/api/meta`
- Health: `/api/health`
- REST API: `/api/...`
- WebSocket: `/api/ws`
- OpenAPI docs: `/docs`

## Authentication

Login is session-token based.

1. `POST /api/settings/login`
2. Store the returned token
3. Send it in the `X-Auth-Token` header for authenticated REST calls
4. Pass it as `?token=` for WebSocket connections

### Login Request

`POST /api/settings/login`

```json
{
  "username": "admin",
  "password": "admin123"
}
```

### Login Response

```json
{
  "token": "<session-token>",
  "username": "admin"
}
```

## Public Endpoints

### GET `/api/meta`

Returns:

- app name
- version
- author
- description

### GET `/api/health`

Returns a simple health payload for deployment checks.

## Settings And Authentication

### POST `/api/settings/logout`

Requires `X-Auth-Token`.

### GET `/api/settings/check`

Returns the authenticated username if the token is valid.

### POST `/api/settings/auth`

Updates username and password.

Body:

```json
{
  "current_password": "admin123",
  "username": "new-admin",
  "password": "new-password"
}
```

### GET `/api/settings/app`

Returns persisted application behavior settings.

### POST `/api/settings/app`

Supported fields:

- `auto_start_simulator`
- `auto_start_trap_receiver`
- `session_timeout`
- `mib_auto_fetch`
- `mib_remote_sources`

## Simulator

### GET `/api/simulator/status`

Returns enriched simulator state including:

- running
- pid
- port
- community
- uptime_seconds
- requests
- last_activity

### POST `/api/simulator/start`

Optional body:

```json
{
  "port": 1061,
  "community": "public"
}
```

### POST `/api/simulator/stop`

Stops the running simulator if present.

### POST `/api/simulator/restart`

Restarts the simulator and preserves lifecycle stats.

### GET `/api/simulator/data`

Returns the saved custom OID override JSON.

### POST `/api/simulator/data`

Accepts an arbitrary JSON object keyed by OID.

Example:

```json
{
  "IF-MIB::ifDescr.1": "eth0",
  "IF-MIB::ifSpeed.1": 1000000000
}
```

## Walker

### POST `/api/walk/execute`

Body:

```json
{
  "target": "127.0.0.1",
  "port": 1061,
  "community": "public",
  "oid": "IF-MIB::ifTable",
  "parse": true,
  "use_mibs": true
}
```

Response includes:

- `mode`
- `count`
- `data`

`mode` can be `parsed`, `raw`, or `label`.

## Trap Manager

### POST `/api/traps/send`

Body:

```json
{
  "target": "127.0.0.1",
  "port": 1162,
  "community": "public",
  "oid": "1.3.6.1.6.3.1.1.5.3",
  "varbinds": [
    {
      "oid": "1.3.6.1.2.1.1.3.0",
      "type": "TimeTicks",
      "value": "123"
    }
  ]
}
```

Important:

- trap OIDs must be numeric at the API layer
- varbind OIDs must also be numeric

### GET `/api/traps/status`

Returns trap receiver runtime state.

### POST `/api/traps/start`

Body:

```json
{
  "port": 1162,
  "community": "public",
  "resolve_mibs": true
}
```

### POST `/api/traps/stop`

Stops the receiver.

### GET `/api/traps/`

Returns received traps. Supports `limit`.

### DELETE `/api/traps/`

Clears received trap history.

## MIB Manager

### GET `/api/mibs/status`

Returns loaded and failed MIB summary plus per-module details.

### GET `/api/mibs/list`

Returns saved MIB filenames from the MIB directory.

### POST `/api/mibs/validate-batch`

Multipart upload endpoint for validation only.

Behavior:

- sanitizes filenames
- writes temporary validation files safely
- does not fetch remote dependencies

### POST `/api/mibs/fetch-dependencies`

Body:

```json
{
  "dependencies": ["IF-MIB", "IANAifType-MIB"],
  "reload_after_fetch": true
}
```

### POST `/api/mibs/upload`

Multipart upload endpoint for actual save and reload.

### POST `/api/mibs/reload`

Reloads the MIB service and restarts dependent workers if needed.

### DELETE `/api/mibs/{filename}`

Deletes a saved MIB file by sanitized filename.

### GET `/api/mibs/traps`

Returns available trap definitions across loaded and system MIBs.

### GET `/api/mibs/objects`

Returns browsable object definitions for use in other UI flows.

### GET `/api/mibs/resolve`

Resolves OIDs between symbolic and numeric forms.

## MIB Browser

### GET `/api/mibs/browse/modules`

Returns module-level stats for the browser.

### GET `/api/mibs/browse/tree/module`

Optional query:

- `module`

### GET `/api/mibs/browse/tree/oid`

Queries:

- `root_oid` default `1.3.6.1`
- `depth` from `1` to `5`
- `module` optional

### GET `/api/mibs/browse/node/{oid}`

Returns node details and related trap objects where applicable.

### GET `/api/mibs/browse/search`

Queries:

- `query`
- `limit`
- `module`
- `type_filter`

## Stats

### GET `/api/stats/`

Returns all stats with runtime enrichment.

### GET `/api/stats/{module}`

Valid module values:

- `simulator`
- `traps`
- `walker`
- `mibs`

### DELETE `/api/stats/`

Resets all counters to zero defaults.

## WebSocket

Connect to:

```text
ws://<host>/api/ws?token=<session-token>
```

Client keepalive:

- send text `ping`
- server replies with text `pong`

Message types:

- `full_state`
- `status`
- `trap`
- `simulator_log`
- `stats`
- `mibs`

### `full_state`

Sent immediately after connect. Includes:

- simulator state
- trap receiver state
- full stats payload
- MIB summary

### `status`

Sent on simulator or trap lifecycle changes.

### `trap`

Sent when a trap is received.

### `simulator_log`

Sent for live simulator activity and lifecycle events.

### `stats`

Sent when counters change.

### `mibs`

Sent after MIB upload, reload, delete, or dependency changes.
