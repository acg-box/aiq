#!/bin/sh
set -eu

repository=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
output=${AIQ_LINUX_ARM64_OUTPUT:-}

case "$output" in
  /*) ;;
  *) printf '%s\n' 'AIQ_LINUX_ARM64_OUTPUT must be a new absolute directory.' >&2; exit 2 ;;
esac

parent=$(dirname -- "$output")
name=$(basename -- "$output")
parent=$(CDPATH= cd -- "$parent" 2>/dev/null && pwd -P) || {
  printf '%s\n' 'The AIQ Linux arm64 output parent must exist.' >&2
  exit 2
}
target=$parent/$name
test "$target" = "$output" || {
  printf '%s\n' 'AIQ_LINUX_ARM64_OUTPUT must use a canonical parent path.' >&2
  exit 2
}
test ! -e "$target" && test ! -L "$target" || {
	printf '%s\n' 'AIQ_LINUX_ARM64_OUTPUT must not already exist.' >&2
	exit 2
}

cd "$repository"
test -z "$(git status --porcelain=v1 --untracked-files=all --ignore-submodules=none)" || {
  printf '%s\n' 'The AIQ source worktree must be clean before a production binary build.' >&2
  exit 2
}

temporary=$(mktemp -d "$parent/.aiq-linux-arm64.XXXXXX")
cleanup() {
  if test -n "${temporary:-}" && test -d "$temporary"; then
    rm -rf -- "$temporary"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

context=$temporary/context
exported=$temporary/exported
archive=$temporary/source.tar
mkdir -m 0700 -- "$context"
git archive --format=tar --output="$archive" HEAD
tar -xf "$archive" -C "$context"
rm -f -- "$archive"

docker buildx build \
  --platform linux/arm64 \
  --file "$context/deploy/candidate-runtime/Dockerfile.binaries" \
  --output "type=local,dest=$exported" \
  "$context"

for binary in aiq-runner aiq-verifier; do
  test -f "$exported/$binary" && test ! -L "$exported/$binary" && test -x "$exported/$binary" || {
    printf '%s\n' "The Linux arm64 $binary output is absent or not executable." >&2
    exit 1
  }
  chmod 0555 "$exported/$binary"
done

python3 deploy/candidate-runtime/binary_builder.py "$exported" "$target"
printf 'linux_arm64_binaries=%s\n' "$target"
