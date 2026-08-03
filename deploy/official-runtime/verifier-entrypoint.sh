#!/bin/sh
set -eu

case "${1:-}" in
  hold)
    exec sleep infinity
    ;;
  canary)
    exec /usr/local/bin/aiq-verifier-canary
    ;;
  worker)
    shift
    token_file=/run/secrets/verifier-token
    signing_key_file=/run/secrets/verifier-signing-key
    test "$(stat -c '%a' "$token_file")" = 600
    test "$(stat -c '%a' "$signing_key_file")" = 600
    AIQ_VERIFIER_INGRESS_TOKEN="$(cat "$token_file")"
    AIQ_VERIFIER_SIGNING_KEY="$(cat "$signing_key_file")"
    export AIQ_VERIFIER_INGRESS_TOKEN AIQ_VERIFIER_SIGNING_KEY
    umask 077
    set -C
    record="/records/worker-$(date -u +%Y%m%dT%H%M%SZ)-$$.jsonl"
    exec /inputs/bin/aiq-verifier \
      --endpoint https://aiq.wiki \
      --tasks /inputs/tasks \
      --environment /inputs/verifier-environment.json \
      --evaluator-root /inputs/evaluators \
      --corpus-commitment /inputs/corpus-commitment.json \
      --codex-toolchain-root /inputs/toolchain \
      --evaluator-runtime /inputs/evaluator-runtime \
      --replay-root /replay \
      "$@" >"$record"
    ;;
  *)
    exec "$@"
    ;;
esac
