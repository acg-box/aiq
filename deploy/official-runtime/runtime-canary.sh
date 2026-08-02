#!/bin/sh
set -eu

test "$(uname -s)" = Linux
test "$(uname -m)" = aarch64
test "$(id -u)" = 10001
test "$(id -g)" = 10001
test "$(awk '/^Seccomp:/ { print $2 }' /proc/self/status)" = 2

if touch /root-filesystem-must-be-read-only 2>/dev/null; then
  rm -f /root-filesystem-must-be-read-only
  echo 'runner root filesystem is writable' >&2
  exit 1
fi

if [ -r /proc/sys/kernel/unprivileged_userns_clone ]; then
  test "$(cat /proc/sys/kernel/unprivileged_userns_clone)" = 1
fi
test "$(cat /proc/sys/user/max_user_namespaces)" -gt 0

bwrap \
  --unshare-user \
  --unshare-pid \
  --unshare-uts \
  --unshare-ipc \
  --unshare-net \
  --unshare-cgroup-try \
  --ro-bind / / \
  --dev /dev \
  --tmpfs /tmp \
  --die-with-parent \
  /bin/sh -ec '
    test "$(awk "/^Seccomp:/ { print \$2 }" /proc/self/status)" = 2
    if touch /etc/inner-root-must-be-read-only 2>/dev/null; then exit 1; fi
    touch /tmp/inner-writable
    if curl --silent --show-error --connect-timeout 3 https://example.com >/dev/null 2>&1; then exit 1; fi
  '

if curl --noproxy '*' --silent --show-error --connect-timeout 5 https://example.com >/dev/null 2>&1; then
  echo 'runner direct external egress unexpectedly succeeded' >&2
  exit 1
fi

curl \
  --proxy http://172.30.0.2:3128 \
  --silent \
  --show-error \
  --fail \
  --connect-timeout 5 \
  --max-time 15 \
  --output /dev/null \
  https://example.com/

if curl \
  --proxy http://172.30.0.2:3128 \
  --silent \
  --show-error \
  --fail \
  --connect-timeout 5 \
  --max-time 10 \
  --output /dev/null \
  https://www.example.org/ 2>/dev/null; then
  echo 'proxy allowed a host outside its filter' >&2
  exit 1
fi

echo 'model_invoked=false linux_arm64=true seccomp=true bubblewrap=true direct_egress=false proxy_https=true proxy_default_deny=true'
