#!/usr/bin/env bash
# Hit POST /dql/internal/sweep-reservations. Fail closed: missing secrets
# or a non-2xx response is a job failure (never skip-success).
# Required env: DQL_SWEEP_URL and (DQL_CRON_SECRET or CRON_SECRET).
# Do not echo the bearer token or treat a missing secret as success.
set -euo pipefail

SECRET="${DQL_CRON_SECRET:-${CRON_SECRET:-}}"
URL="${DQL_SWEEP_URL:-}"

if [ -z "${SECRET}" ]; then
  echo "sweep-reservations: CRON_SECRET or DQL_CRON_SECRET is required" >&2
  exit 1
fi
if [ -z "${URL}" ]; then
  echo "sweep-reservations: DQL_SWEEP_URL is required" >&2
  exit 1
fi

BODY="$(mktemp)"
trap 'rm -f "${BODY}"' EXIT

set +e
CODE="$(curl -sS -o "${BODY}" -w '%{http_code}' -X POST \
  -H "Authorization: Bearer ${SECRET}" \
  -H "Accept: application/json" \
  --max-time 60 \
  "${URL}")"
CURL_STATUS=$?
set -e

if [ "${CURL_STATUS}" -ne 0 ]; then
  echo "sweep-reservations: request failed" >&2
  exit 1
fi

if [ "${CODE}" -lt 200 ] || [ "${CODE}" -ge 300 ]; then
  echo "sweep-reservations: HTTP ${CODE}" >&2
  exit 1
fi
