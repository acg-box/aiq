#!/usr/bin/env python3
"""Validate exact Linux AArch64 executables used by local runtimes."""

from __future__ import annotations

import os
from pathlib import Path
import stat
import struct


ELF_HEADER_SIZE = 64
ELF_MAGIC = b"\x7fELF"
ELF_CLASS_64 = 2
ELF_DATA_LITTLE_ENDIAN = 1
ELF_VERSION_CURRENT = 1
ELF_OS_ABI_SYSTEM_V = 0
ELF_TYPE_EXECUTABLE = 2
ELF_TYPE_POSITION_INDEPENDENT = 3
ELF_MACHINE_AARCH64 = 183
ELF_PROGRAM_HEADER_INTERPRETER = 3
ELF_PROGRAM_HEADER_SIZE = 56
LINUX_AARCH64_INTERPRETER = b"/lib/ld-linux-aarch64.so.1\0"


def validate_linux_aarch64_elf(
    path: Path,
    label: str,
    *,
    allow_static: bool,
    require_pie: bool,
    service_uid: int,
) -> None:
    """Require an executable Linux AArch64 ELF with an approved loader policy."""

    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError(f"{label} must be a single-link regular file")
    permission_shift = 6 if metadata.st_uid == service_uid else 3 if metadata.st_gid == service_uid else 0
    if (metadata.st_mode >> permission_shift) & 0o5 != 0o5:
        raise ValueError(f"{label} must be readable and executable by uid {service_uid}")

    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)

        def identity(value: os.stat_result) -> tuple[int, int, int, int, int, int, int]:
            return (
                value.st_dev,
                value.st_ino,
                value.st_mode,
                value.st_nlink,
                value.st_size,
                value.st_mtime_ns,
                value.st_ctime_ns,
            )

        if identity(metadata) != identity(opened):
            raise ValueError(f"{label} changed before its ELF identity was read")
        binary = os.fdopen(descriptor, "rb", closefd=False)
        header = binary.read(ELF_HEADER_SIZE)
        if len(header) != ELF_HEADER_SIZE or header[:4] != ELF_MAGIC:
            raise ValueError(f"{label} must be an ELF executable")
        if header[4] != ELF_CLASS_64 or header[5] != ELF_DATA_LITTLE_ENDIAN:
            raise ValueError(f"{label} must be a little-endian 64-bit ELF executable")
        if header[6] != ELF_VERSION_CURRENT or header[7] != ELF_OS_ABI_SYSTEM_V:
            raise ValueError(f"{label} must use the Linux System V ELF identity")

        elf_type, machine, version = struct.unpack_from("<HHI", header, 16)
        entrypoint, program_offset = struct.unpack_from("<QQ", header, 24)
        program_entry_size, program_count = struct.unpack_from("<HH", header, 54)
        if elf_type not in (ELF_TYPE_EXECUTABLE, ELF_TYPE_POSITION_INDEPENDENT) or entrypoint == 0:
            raise ValueError(f"{label} must be an executable ELF image")
        if require_pie and elf_type != ELF_TYPE_POSITION_INDEPENDENT:
            raise ValueError(f"{label} must be a position-independent ELF executable")
        if machine != ELF_MACHINE_AARCH64 or version != ELF_VERSION_CURRENT:
            raise ValueError(f"{label} must be a Linux AArch64 executable")
        if program_entry_size != ELF_PROGRAM_HEADER_SIZE or program_count == 0:
            raise ValueError(f"{label} has an invalid ELF program-header table")
        if program_offset > metadata.st_size or program_count > (
            metadata.st_size - program_offset
        ) // program_entry_size:
            raise ValueError(f"{label} has an out-of-bounds ELF program-header table")

        interpreter = None
        for index in range(program_count):
            binary.seek(program_offset + index * program_entry_size)
            program_header = binary.read(program_entry_size)
            program_type = struct.unpack_from("<I", program_header)[0]
            if program_type != ELF_PROGRAM_HEADER_INTERPRETER:
                continue
            if interpreter is not None:
                raise ValueError(f"{label} has more than one ELF interpreter")
            offset = struct.unpack_from("<Q", program_header, 8)[0]
            size = struct.unpack_from("<Q", program_header, 32)[0]
            if size == 0 or size > 4096 or offset > metadata.st_size or size > metadata.st_size - offset:
                raise ValueError(f"{label} has an invalid ELF interpreter record")
            binary.seek(offset)
            interpreter = binary.read(size)
        after = os.fstat(descriptor)
        if identity(opened) != identity(after) or identity(metadata) != identity(path.lstat()):
            raise ValueError(f"{label} changed while its ELF identity was read")
    finally:
        os.close(descriptor)

    if interpreter is None:
        if not allow_static:
            raise ValueError(f"{label} must use the Linux AArch64 glibc loader")
    elif interpreter != LINUX_AARCH64_INTERPRETER:
        raise ValueError(f"{label} must use the Linux AArch64 glibc loader")
