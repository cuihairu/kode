# _KBEngine_loginapp.pyi — 进程层函数/常量面 / process-layer functions and constants.
# 源:cuihairu/kbengine typings(钉点 commit 见 typings/README.md),经
# scripts/derive-kbengine-stub-typings.mjs 生成;改内容请重跑,勿手工合并 /
# derived via the derive script; regenerate there, do not hand-merge.

from __future__ import annotations

from typing import Any

from ._KBEngine_server_errors import *
from ._KBEngine_pythonapp import *

def __getattr__(name: str) -> Any: ...
