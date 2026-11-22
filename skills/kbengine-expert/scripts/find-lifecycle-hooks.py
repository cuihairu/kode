#!/usr/bin/env python3
"""Find literal Python hook dispatch and attribute lookup sites in KBEngine C++."""

import argparse
from pathlib import Path
import re

SOURCE = Path(__file__).resolve().parents[1] / "references" / "source" / "kbe" / "src"
TOKEN = re.compile(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|\w+|[(),]', re.S)
HOOK = re.compile(r'"(on[A-Z]\w*|__init__)"\Z')
SITES = {
    "bufferOrExeCallback": (0, "dispatch"),
    "PyObject_CallMethod": (1, "dispatch"),
    "PyObject_CallMethodObjArgs": (1, "dispatch"),
    "PyObject_GetAttrString": (1, "lookup"),
    "PyObject_HasAttrString": (1, "lookup"),
}
SOURCE_DIRS = (
    "server", "lib/server", "lib/entitydef", "lib/client_lib",
    "lib/pyscript", "lib/math", "lib/navigation",
)


def argument(tokens, call, position):
    """Return the tokens of the requested top-level argument, if present."""
    depth = 0
    start = call + 2
    for index in range(start, len(tokens)):
        word = tokens[index][1]
        if depth == 0 and word in (",", ")"):
            if position == 0:
                return tokens[start:index]
            if word == ")":
                return []
            position -= 1
            start = index + 1
        elif word == "(":
            depth += 1
        elif word == ")":
            depth -= 1
    return []


def find_sites(text):
    tokens = [
        (match.start(), match.group())
        for match in TOKEN.finditer(text)
        if not match.group().startswith(("//", "/*"))
    ]
    for index, (_, word) in enumerate(tokens[:-1]):
        if tokens[index + 1][1] != "(":
            continue
        site = SITES.get(word)
        if site is None and re.fullmatch(r"SCRIPT_OBJECT_CALL_ARGS\d+", word):
            site = (1, "dispatch")
        if site is None:
            continue
        position, kind = site
        for offset, value in argument(tokens, index, position):
            hook = HOOK.fullmatch(value)
            if hook:
                yield hook.group(1), text.count("\n", 0, offset) + 1, kind


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("hook", nargs="?", help="exact Python hook name")
    parser.add_argument("--src", type=Path, default=SOURCE, help="target kbe/src directory")
    parser.add_argument("--include-lookups", action="store_true", help="include indirect dispatch leads")
    options = parser.parse_args()
    if not (options.src / "lib" / "entitydef").is_dir():
        parser.error("--src must point to a KBEngine kbe/src directory")
    paths = {
        path for folder in SOURCE_DIRS for path in (options.src / folder).rglob("*")
        if path.suffix in {".cpp", ".h", ".inl"} and path.is_file()
    }
    hits = set()
    for path in sorted(paths):
        for name, line, kind in find_sites(path.read_text(encoding="utf-8", errors="replace")):
            if (options.hook is None or name == options.hook) and (kind == "dispatch" or options.include_lookups):
                hits.add((name, str(path.relative_to(options.src)), line, kind))
    for name, path, line, kind in sorted(hits):
        print("{}\t{}:{}\t{}".format(name, path, line, kind))
    return 0 if hits or options.hook is None else 1


if __name__ == "__main__":
    raise SystemExit(main())
