#!/bin/sh
set -eu
umask 077

load_trust_pin() {
  case "${AIQ_TRUST_POLICY_DIGEST:-}" in
    sha256:????????????????????????????????????????????????????????????????) ;;
    *) exit 64 ;;
  esac
  case "${AIQ_TRUST_POLICY_DIGEST#sha256:}" in *[!0-9a-f]*|0000000000000000000000000000000000000000000000000000000000000000) exit 64 ;; esac
  test "$(stat -c '%u:%g:%a:%h' /run/secrets/trust-policy-pin)" = '10003:10003:600:1'
  test "$(cat /run/secrets/trust-policy-pin)" = "$AIQ_TRUST_POLICY_DIGEST"
  AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256=$AIQ_TRUST_POLICY_DIGEST
  export AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256
}

case "${1:-}" in
  hold) test "$#" -eq 1 || exit 64; exec sleep infinity ;;
  canary) test "$#" -eq 1 || exit 64; exec /usr/local/bin/aiq-candidate-canary verifier ;;
  verify-unit)
    test "$#" -eq 3 || exit 64
    unit_id=$2
    expectations=$3
    case "$expectations:$unit_id" in
      /control/expectations-repeat-01-verify.json:repeat-01-core|/control/expectations-repeat-02-verify.json:repeat-02-core|/control/expectations-repeat-03-verify.json:repeat-03-core) tasks=/inputs/core-tasks ;;
      /control/expectations-repeat-01-verify.json:repeat-01-contrast-0[123]-reference|/control/expectations-repeat-02-verify.json:repeat-02-contrast-0[123]-reference|/control/expectations-repeat-03-verify.json:repeat-03-contrast-0[123]-reference) tasks=/inputs/contrast-tasks ;;
      /control/expectations-repeat-01-verify.json:repeat-01-contrast-0[123]-challenge|/control/expectations-repeat-02-verify.json:repeat-02-contrast-0[123]-challenge|/control/expectations-repeat-03-verify.json:repeat-03-contrast-0[123]-challenge) tasks=/inputs/contrast-tasks ;;
      *) exit 64 ;;
    esac
    load_trust_pin
    key=/run/secrets/verifier-key
    test "$(stat -c '%u:%g:%a:%h' "$key")" = '10003:10003:600:1'
    AIQ_CANDIDATE_VERIFIER_SIGNING_KEY="$(cat "$key")"
    export AIQ_CANDIDATE_VERIFIER_SIGNING_KEY
    exec /inputs/bin/aiq-verifier verify-candidate-unit \
      --expectations "$expectations" --unit-id "$unit_id" --tasks "$tasks" \
      --source-root /inputs/candidate-source --artifact-root /candidate/artifacts \
      --evaluator-root /inputs/evaluators --evaluator-runtime /inputs/evaluator-runtime \
      --replay-root /candidate/verifier-replay
    ;;
  *) exit 64 ;;
esac
