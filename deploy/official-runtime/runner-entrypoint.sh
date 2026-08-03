#!/bin/sh
set -eu

requirements=/etc/codex/requirements.toml
expected='f9f21149d8b9b85f1f24fd9c4078b2b1d0dd214f771f2de3a5ad690ef84801de'
runner=/inputs/bin/aiq-runner
signing_key_file=/run/secrets/runner-signing-key
submission_token_file=/run/secrets/runner-submission-token

test "$(stat -c '%u:%g:%a' "$requirements")" = '0:0:444'
test "$(sha256sum "$requirements" | awk '{print $1}')" = "$expected"
test "$(cat "$requirements")" = 'allowed_permission_profiles.aiq_benchmark = true
default_permissions                       = "aiq_benchmark"'

require_secret_file() {
  secret_file=$1
  test "$(stat -c '%u:%g:%a:%h' "$secret_file")" = '10001:10001:600:1'
  test -s "$secret_file"
}

read_signing_key() {
  require_secret_file "$signing_key_file"
  key_bytes=$(stat -c '%s' "$signing_key_file")
  case "$key_bytes" in
    64|65) ;;
    *)
      echo 'official-runtime: runner signing key must contain exactly 64 lowercase hexadecimal characters and at most one terminal newline' >&2
      exit 2
      ;;
  esac
  key_value=$(cat "$signing_key_file")
  if test "${#key_value}" -ne 64 || ! printf '%s' "$key_value" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$'
  then
    echo 'official-runtime: runner signing key must contain exactly 64 lowercase hexadecimal characters and at most one terminal newline' >&2
    exit 2
  fi
  printf '%s' "$key_value"
}

read_submission_token() {
  require_secret_file "$submission_token_file"
  token_bytes=$(stat -c '%s' "$submission_token_file")
  if test "$token_bytes" -lt 1 || test "$token_bytes" -gt 4096
  then
    echo 'official-runtime: runner submission token must contain 1 to 4096 visible ASCII characters' >&2
    exit 2
  fi
  token_value=$(cat "$submission_token_file")
  if test "${#token_value}" -ne "$token_bytes" || ! printf '%s' "$token_value" | LC_ALL=C grep -Eq '^[!-~]+$'
  then
    echo 'official-runtime: runner submission token must contain only visible ASCII characters without whitespace' >&2
    exit 2
  fi
  printf '%s' "$token_value"
}

reject_option() {
  rejected=$1
  shift
  for argument do
    case "$argument" in
      "$rejected"|"$rejected="*)
        echo "official-runtime: $rejected is fixed by the protected runner wrapper" >&2
        exit 2
        ;;
    esac
  done
}

require_option() {
  required=$1
  shift
  for argument do
    case "$argument" in
      "$required"|"$required="*)
        return 0
        ;;
    esac
  done
  echo "official-runtime: $required is required by the protected Official runner wrapper" >&2
  exit 2
}

run_command() {
  command=$1
  shift
  case "$command" in
    preflight)
      for fixed_option in \
        --capabilities --corpus-commitment --evaluator-runtime \
        --codex-toolchain-root --codex-binary --codex-home \
        --codex-egress-proxy --artifact-root
      do
        reject_option "$fixed_option" "$@"
      done
      require_option --official-admission "$@"
      exec "$runner" preflight \
        --capabilities /inputs/capabilities.json \
        --corpus-commitment /inputs/corpus-commitment.json \
        --evaluator-runtime /inputs/evaluator-runtime \
        --codex-toolchain-root /inputs/toolchain \
        --codex-binary /inputs/bin/codex \
        --codex-home /codex-home \
        --codex-egress-proxy http://172.30.0.2:3128 \
        --artifact-root /output/artifacts "$@"
      ;;
    admit-permissions|run)
      for fixed_option in \
        --public-tasks --hidden-tasks --corpus-commitment --source-root --capabilities --workspace-root \
        --execution-root --evaluator-root --evaluator-runtime \
        --codex-toolchain-root --schedule --codex-binary --codex-home \
        --codex-egress-proxy --artifact-root
      do
        reject_option "$fixed_option" "$@"
      done
      if test "$command" = run
      then
        for fixed_option in --run-class --task --model
        do
          reject_option "$fixed_option" "$@"
        done
        require_option --official-admission "$@"
        set -- --run-class official "$@"
      fi
      exec "$runner" "$command" \
        --hidden-tasks /inputs/tasks \
        --corpus-commitment /inputs/corpus-commitment.json \
        --source-root /inputs/source \
        --capabilities /inputs/capabilities.json \
        --workspace-root /inputs/baselines \
        --execution-root /execution \
        --evaluator-root /inputs/evaluators \
        --evaluator-runtime /inputs/evaluator-runtime \
        --codex-toolchain-root /inputs/toolchain \
        --schedule /inputs/schedule.json \
        --codex-binary /inputs/bin/codex \
        --codex-home /codex-home \
        --codex-egress-proxy http://172.30.0.2:3128 \
        --artifact-root /output/artifacts "$@"
      ;;
    score)
      for fixed_option in --public-tasks --hidden-tasks --bootstrap-samples --bootstrap-seed
      do
        reject_option "$fixed_option" "$@"
      done
      require_option --official-admission "$@"
      exec "$runner" score --hidden-tasks /inputs/tasks "$@"
      ;;
    package)
      reject_option --signing-key-env "$@"
      reject_option --artifact-root "$@"
      require_option --official-admission "$@"
      AIQ_RUNNER_SIGNING_KEY="$(read_signing_key)"
      export AIQ_RUNNER_SIGNING_KEY
      exec "$runner" package \
        --artifact-root /output/artifacts \
        --signing-key-env AIQ_RUNNER_SIGNING_KEY "$@"
      ;;
    submit)
      reject_option --token-env "$@"
      reject_option --endpoint "$@"
      reject_option --allow-loopback-http "$@"
      reject_option --artifact-root "$@"
      AIQ_RUNNER_SUBMISSION_TOKEN="$(read_submission_token)"
      export AIQ_RUNNER_SUBMISSION_TOKEN
      exec "$runner" submit \
        --artifact-root /output/artifacts \
        --endpoint https://aiq.wiki \
        --token-env AIQ_RUNNER_SUBMISSION_TOKEN "$@"
      ;;
    *)
      echo "official-runtime: unsupported runner command $command" >&2
      exit 2
      ;;
  esac
}

case "${1:-}" in
  hold)
    exec sleep infinity
    ;;
  canary)
    exec /usr/local/bin/aiq-runtime-canary
    ;;
  admit-permissions|preflight|run|score|package|submit)
    run_command "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
