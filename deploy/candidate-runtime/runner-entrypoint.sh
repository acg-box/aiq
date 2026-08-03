#!/bin/sh
set -eu
umask 077

read_secret() {
  file=$1
  expected=$2
  test "$(stat -c '%u:%g:%a:%h' "$file")" = "$expected"
  cat "$file"
}

load_trust_pin() {
  case "${AIQ_TRUST_POLICY_DIGEST:-}" in
    sha256:????????????????????????????????????????????????????????????????) ;;
    *) exit 64 ;;
  esac
  case "${AIQ_TRUST_POLICY_DIGEST#sha256:}" in *[!0-9a-f]*|0000000000000000000000000000000000000000000000000000000000000000) exit 64 ;; esac
  test "$(read_secret /run/secrets/trust-policy-pin '10001:10001:600:1')" = "$AIQ_TRUST_POLICY_DIGEST"
  AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256=$AIQ_TRUST_POLICY_DIGEST
  export AIQ_CORE_1_0_2_RELEASE_TRUST_POLICY_SHA256
}

case "${1:-}" in
  hold) test "$#" -eq 1 || exit 64; exec sleep infinity ;;
  canary) test "$#" -eq 1 || exit 64; exec /usr/local/bin/aiq-candidate-canary runner ;;
  plan)
    test "$#" -eq 1 || exit 64
    load_trust_pin
    exec /inputs/bin/aiq-runner candidate plan \
      --admission /inputs/signed-admission.json \
      --release-trust-policy /inputs/release-trust-policy.json \
      --inputs /inputs/plan-inputs.json \
      --output /control/execution-plan.json
    ;;
  authorize)
    test "$#" -eq 1 || exit 64
    load_trust_pin
    AIQ_CANDIDATE_AUTHORIZATION_KEY="$(read_secret /run/secrets/authorization-key '10001:10001:600:1')"
    export AIQ_CANDIDATE_AUTHORIZATION_KEY
    exec /inputs/bin/aiq-runner candidate authorize \
      --admission /inputs/signed-admission.json \
      --release-trust-policy /inputs/release-trust-policy.json \
      --plan /control/execution-plan.json \
      --output /control/authorization.json
    ;;
  validate-core)
    test "$#" -eq 1 || exit 64
    load_trust_pin
    exec /inputs/bin/aiq-runner candidate validate-corpus \
      --expectations /control/expectations-preparation.json \
      --hidden-tasks /inputs/core-tasks \
      --corpus-commitment /inputs/core-commitment.json \
      --source-root /inputs/candidate-source \
      --evaluator-root /inputs/evaluators \
      --evaluator-runtime /inputs/evaluator-runtime \
      --codex-toolchain-root /inputs/toolchain
    ;;
  validate-contrast)
    test "$#" -eq 1 || exit 64
    load_trust_pin
    exec /inputs/bin/aiq-runner candidate validate-contrast-corpus \
      --expectations /control/expectations-preparation.json \
      --hidden-tasks /inputs/contrast-tasks \
      --corpus-commitment /inputs/contrast-commitment.json \
      --source-root /inputs/candidate-source \
      --evaluator-root /inputs/evaluators \
      --evaluator-runtime /inputs/evaluator-runtime \
      --codex-toolchain-root /inputs/toolchain
    ;;
  run-repeat|finalize-repeat)
    case "$1:$#" in run-repeat:4|finalize-repeat:3) ;; *) exit 64 ;; esac
    action=$1; expectations=$2; repeat_id=$3; shift 3
    case "$action:$expectations:$repeat_id" in
      run-repeat:/control/expectations-repeat-01-run.json:repeat-01|run-repeat:/control/expectations-repeat-02-run.json:repeat-02|run-repeat:/control/expectations-repeat-03-run.json:repeat-03) ;;
      finalize-repeat:/control/expectations-repeat-01-finalize.json:repeat-01|finalize-repeat:/control/expectations-repeat-02-finalize.json:repeat-02|finalize-repeat:/control/expectations-repeat-03-finalize.json:repeat-03) ;;
      *) exit 64 ;;
    esac
    load_trust_pin
    AIQ_CANDIDATE_RUNNER_SIGNING_KEY="$(read_secret /run/secrets/runner-key '10001:10001:600:1')"
    export AIQ_CANDIDATE_RUNNER_SIGNING_KEY
    if test "$action" = run-repeat; then
      mode=$1
      case "$mode" in fresh|resume-exact-plan) ;; *) exit 64 ;; esac
      exec /inputs/bin/aiq-runner candidate run-repeat \
        --expectations "$expectations" --repeat-id "$repeat_id" --reservation-mode "$mode"
    fi
    exec /inputs/bin/aiq-runner candidate finalize-repeat \
      --expectations "$expectations" --repeat-id "$repeat_id"
    ;;
  derive-source)
    test "$#" -eq 2 || exit 64
    test "$2" = /control/expectations-aggregate.json || exit 64
    load_trust_pin
    exec /inputs/bin/aiq-runner candidate derive-aggregate-source --expectations "$2"
    ;;
  authority-input)
    test "$#" -eq 3 || exit 64
    test "$2" = /control/expectations-aggregate.json || exit 64
    key_id=$3
    case "$key_id" in [a-z0-9]* ) ;; *) exit 64 ;; esac
    case "$key_id" in *[!a-z0-9._-]* ) exit 64 ;; esac
    test "${#key_id}" -le 128 || exit 64
    load_trust_pin
    exec /inputs/bin/aiq-runner candidate release-authority-input \
      --expectations "$2" --signer-key-id "$3" --output /control/release-authority-input.json
    ;;
  aggregate-expectations)
    test "$#" -eq 2 || exit 64
    test "$2" = /control/expectations-aggregate.json || exit 64
    load_trust_pin
    exec /inputs/bin/aiq-runner candidate aggregate-expectations \
      --execution-expectations "$2" \
      --release-authority /control/release-authority.json \
      --release-trust-policy /inputs/release-trust-policy.json \
      --output /control/aggregate-expectations.json
    ;;
  aggregate)
    test "$#" -eq 1 || exit 64
    load_trust_pin
    exec /inputs/bin/aiq-runner candidate aggregate --expectations /control/aggregate-expectations.json
    ;;
  *) exit 64 ;;
esac
