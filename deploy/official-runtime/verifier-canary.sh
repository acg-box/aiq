#!/bin/sh
set -eu

test "$(uname -s)" = Linux
test "$(uname -m)" = aarch64
test "$(id -u)" = 10003
test "$(id -g)" = 10003
test "$(awk '/^Seccomp:/ { print $2 }' /proc/self/status)" = 2
test ! -e /codex-home
test ! -e /inputs/bin/codex
test ! -e /run/secrets/verifier-token || test ! -w /run/secrets/verifier-token
test ! -e /run/secrets/verifier-signing-key || test ! -w /run/secrets/verifier-signing-key

if touch /root-filesystem-must-be-read-only 2>/dev/null; then
  rm -f /root-filesystem-must-be-read-only
  echo 'verifier root filesystem is writable' >&2
  exit 1
fi

if curl --noproxy '*' --silent --show-error --connect-timeout 5 https://example.com >/dev/null 2>&1; then
  echo 'verifier direct external egress unexpectedly succeeded' >&2
  exit 1
fi

curl --proxy http://10.248.32.2:3128 --silent --show-error --fail \
  --connect-timeout 5 --max-time 15 --output /dev/null https://example.com/

assert_proxy_denied() {
  label="$1"
  url="$2"

  # Tinyproxy returns CONNECT 403 only when its filter denies the target. DNS,
  # TLS, timeout, and generic proxy failures report another value and must fail.
  if connect_status=$(curl --proxy http://10.248.32.2:3128 --silent --show-error \
    --connect-timeout 5 --max-time 10 --output /dev/null \
    --write-out '%{http_connect}' "$url" 2>/dev/null); then
    echo "verifier proxy allowed $label" >&2
    exit 1
  fi
  if [ "$connect_status" != 403 ]; then
    echo "verifier proxy did not prove filter denial for $label (CONNECT $connect_status)" >&2
    exit 1
  fi
}

assert_proxy_denied 'an OpenAI host' 'https://api.openai.com/'
assert_proxy_denied 'a host outside its filter' 'https://www.example.org/'

echo 'model_invoked=false verifier=true linux_arm64=true seccomp=true direct_egress=false proxy_https=true openai_denied=true proxy_default_deny=true'
