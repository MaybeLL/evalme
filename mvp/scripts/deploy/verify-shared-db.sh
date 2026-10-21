#!/bin/sh
set -eu
exec node "$(dirname "$0")/verify-shared-db.mjs" "$@"
