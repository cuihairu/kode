#!/usr/bin/env python3
"""Verify the pinned KBEngine source snapshot with Python 3.7 or later."""

import hashlib
from pathlib import Path, PurePosixPath
import re
import sys


VERSION_HEADER = "kbe/src/lib/python/Include/patchlevel.h"
EXPECTED_VERSION = (3, 7, 3)


def verify(references):
    source = references / "source"
    entries = (references / "source.sha256").read_text(encoding="utf-8").splitlines()
    expected_files = set()

    for entry in entries:
        digest, separator, filename = entry.partition("  ")
        relative = PurePosixPath(filename)
        if (not separator or not re.fullmatch(r"[0-9a-f]{64}", digest)
                or not relative.parts or relative.is_absolute() or ".." in relative.parts
                or filename in expected_files):
            raise ValueError("invalid manifest entry: {!r}".format(entry))
        expected_files.add(filename)
        file_path = source.joinpath(*relative.parts)
        actual = hashlib.sha256(file_path.read_bytes()).hexdigest()
        if actual != digest:
            raise ValueError("checksum mismatch: {}".format(filename))

    actual_files = {path.relative_to(source).as_posix() for path in source.rglob("*") if path.is_file()}
    if actual_files != expected_files:
        raise ValueError("snapshot file list differs from the manifest")

    header = (source / VERSION_HEADER).read_text(encoding="ascii")
    macros = dict(re.findall(r"^#\s*define\s+PY_(MAJOR|MINOR|MICRO)_VERSION\s+(\d+)", header, re.M))
    runtime = tuple(int(macros.get(part, -1)) for part in ("MAJOR", "MINOR", "MICRO"))
    if runtime != EXPECTED_VERSION:
        raise ValueError("unexpected embedded Python version: {}".format(runtime))
    return len(expected_files)


def main():
    references = Path(__file__).resolve().parents[1] / "references"
    try:
        count = verify(references)
    except (OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    print("Verified {} source files and embedded CPython 3.7.3.".format(count))
    return 0


if __name__ == "__main__":
    sys.exit(main())
