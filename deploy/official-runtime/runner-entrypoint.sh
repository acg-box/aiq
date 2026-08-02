#!/bin/sh
set -eu

requirements=/etc/codex/requirements.toml
expected='f9f21149d8b9b85f1f24fd9c4078b2b1d0dd214f771f2de3a5ad690ef84801de'

test "$(stat -c '%u:%g:%a' "$requirements")" = '0:0:444'
test "$(sha256sum "$requirements" | awk '{print $1}')" = "$expected"
test "$(cat "$requirements")" = 'allowed_permission_profiles.aiq_benchmark = true
default_permissions                       = "aiq_benchmark"'

case "${1:-}" in
  hold)
    exec sleep infinity
    ;;
  canary)
    exec /usr/local/bin/aiq-runtime-canary
    ;;
  *)
    exec "$@"
    ;;
esac
