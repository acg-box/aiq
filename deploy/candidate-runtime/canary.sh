#!/bin/sh
set -eu
test "$#" -eq 1 || exit 64
role=$1
case "$role" in runner) expected_uid=10001 ;; verifier) expected_uid=10003 ;; *) exit 64 ;; esac
test "$(id -u)" = "$expected_uid"
test "$(id -g)" = "$expected_uid"
test "$(uname -s)" = Linux
test "$(uname -m)" = aarch64
test "$(awk '/^Seccomp:/ { print $2 }' /proc/self/status)" = 2
test ! -w /etc
if touch /root-filesystem-must-be-read-only 2>/dev/null; then
  rm -f /root-filesystem-must-be-read-only
  exit 1
fi
if test "$role" = verifier; then
  proxy=http://10.248.36.2:3128
  test ! -e /codex-home
  test ! -e /inputs/bin/codex
  test -r /candidate/artifacts && test ! -w /candidate/artifacts
  test -r /control && test ! -w /control
  test -w /candidate/outputs && test -w /candidate/verifier-replay
  test "$(stat -c '%u:%g:%a:%h' /run/secrets/verifier-key)" = '10003:10003:600:1'
  test "$(stat -c '%u:%g:%a:%h' /run/secrets/trust-policy-pin)" = '10003:10003:600:1'
  probe=/candidate/verifier-replay/.aiq-canary-$$
  (umask 077 && : > "$probe")
  test "$(stat -c '%u:%g:%a:%h' "$probe")" = '10003:10003:600:1'
  rm "$probe"
else
  proxy=http://10.248.34.2:3128
  test -w /candidate/artifacts && test -w /candidate/outputs && test -w /control
  test -r /candidate/verifier-replay && test ! -w /candidate/verifier-replay
  test "$(stat -c '%u:%g:%a:%h' /run/secrets/authorization-key)" = '10001:10001:600:1'
  test "$(stat -c '%u:%g:%a:%h' /run/secrets/runner-key)" = '10001:10001:600:1'
  test "$(stat -c '%u:%g:%a:%h' /run/secrets/trust-policy-pin)" = '10001:10001:600:1'
  probe=/candidate/artifacts/.aiq-canary-$$
  (umask 077 && : > "$probe")
  test "$(stat -c '%u:%g:%a:%h' "$probe")" = '10001:10001:600:1'
  rm "$probe"
  bwrap --unshare-user --unshare-pid --unshare-uts --unshare-ipc --unshare-net \
    --unshare-cgroup-try --ro-bind / / --dev /dev --tmpfs /tmp --die-with-parent \
    /bin/sh -ec 'test "$(awk "/^Seccomp:/ { print \$2 }" /proc/self/status)" = 2; test ! -w /etc; touch /tmp/writable; ! curl --silent --show-error --connect-timeout 3 https://example.com >/dev/null 2>&1'
fi

if curl --noproxy '*' --silent --show-error --connect-timeout 5 https://example.com >/dev/null 2>&1; then
  exit 1
fi
curl --proxy "$proxy" --silent --show-error --fail --connect-timeout 5 --max-time 15 \
  --output /dev/null https://example.com/

probe_proxy_capacity() {
  connections=64
  index=0
  pids=''
  failures=0
  while test "$index" -lt "$connections"; do
    curl --proxy "$proxy" --silent --show-error --fail --connect-timeout 5 --max-time 15 \
      --limit-rate 128 --output /dev/null https://example.com/ &
    pids="$pids $!"
    index=$((index + 1))
  done
  for pid in $pids; do
    if ! wait "$pid"; then failures=$((failures + 1)); fi
  done
  test "$failures" -eq 0
}
if test "$role" = runner; then
  probe_proxy_capacity
fi

assert_proxy_denied() {
  url=$1
  if connect_status=$(curl --proxy "$proxy" --silent --show-error --connect-timeout 5 \
    --max-time 10 --output /dev/null --write-out '%{http_connect}' "$url" 2>/dev/null); then
    exit 1
  fi
  test "$connect_status" = 403
}
assert_proxy_denied https://www.example.org/
if test "$role" = verifier; then
  assert_proxy_denied https://api.openai.com/
fi
printf 'role=%s model_invoked=false linux_arm64=true seccomp=true direct_egress=false proxy_https=true proxy_capacity_checked=%s proxy_default_deny=true\n' "$role" "$(test "$role" = runner && printf 64 || printf 0)"
