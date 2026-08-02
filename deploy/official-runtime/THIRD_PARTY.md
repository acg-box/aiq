# Third-party runtime record

The two images use the Docker Official Image for Debian 12 `bookworm-slim` on
Linux arm64. The image manifest is
`sha256:9b67294679b30e5d6ab257b40594feeb4a4b81f7fcf4131f4decf0d6a212a9b0`.
The base contains Debian packages under their package-specific licenses. See
`/usr/share/doc/*/copyright` in each built image.

The build uses the Debian snapshot at `20260714T000000Z`. Direct packages are
pinned to these versions:

| Package | Version | Purpose | License |
| --- | --- | --- | --- |
| bubblewrap | `0.8.0-2+deb12u1` | Inner file-system and network sandbox | LGPL-2.0-or-later |
| ca-certificates | `20230311+deb12u1` | HTTPS trust roots | MPL-2.0 |
| curl | `7.88.1-10+deb12u15` | Model-free HTTPS canary | curl license |
| tinyproxy-bin | `1.11.1-2.1+deb12u1` | CONNECT-only egress proxy | GPL-2.0-or-later |

Package metadata and source are from the
[Debian package tracker](https://tracker.debian.org/). The Docker base source is
the [Docker Official Images Debian repository](https://github.com/debuerreotype/docker-debian-artifacts).

`seccomp-bwrap.json` is derived from the Moby default seccomp profile tag
`seccomp/v0.2.3`, commit `836ae4d37ef2ec995c77c99fc55f5b5f3af3a897`.
The unchanged upstream file has SHA-256
`536529b665dd0972c37bfb569f5d4ac8a53592e7b00752bc39ff063ca9864c74`.
Moby profiles use Apache-2.0. The local profile allows only `clone`, `mount`,
`pivot_root`, `umount2`, and `unshare` in addition to the no-capability default.
Bubblewrap needs these calls to create and populate its unprivileged namespaces.
The upstream forced-`ENOSYS` handling for `clone3` stays active. All other
default-denied calls stay denied.
