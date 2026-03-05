# GET /health Endpoint Specification

## Purpose
Provide a lightweight health check endpoint for load balancers, orchestration systems, and uptime monitors.

## Endpoint
- Method: `GET`
- Path: `/health`
- Authentication: None

## Request Requirements
- The endpoint MUST accept a request body but MUST ignore it.
- The endpoint MUST be safe and idempotent.
- The endpoint SHOULD return within 100 ms under normal operating conditions.

## Success Response
- Status code: `200 OK`
- Content-Type: `application/json; charset=utf-8`

Response body:

```json
{
  "status": "ok",
  "service": "api",
  "timestamp": "2026-03-05T00:00:00Z",
  "uptimeSeconds": 12345
}
```

## Response Field Requirements
- `status` (string): MUST be `"ok"` when service is healthy.
- `service` (string): Logical service name.
- `timestamp` (string): RFC 3339 UTC timestamp.
- `uptimeSeconds` (integer): Process uptime in whole seconds, `>= 0`.

## Failure Behavior
- If the service cannot report healthy state, it SHOULD return `503 Service Unavailable`.
- Failure payload SHOULD preserve JSON shape where possible and include `status: "degraded"` or `"error"`.

## Caching and Observability
- Response MUST include `Cache-Control: no-store`.
- Endpoint SHOULD be excluded from verbose application logs to reduce noise.
