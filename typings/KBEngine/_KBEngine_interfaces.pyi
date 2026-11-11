# _KBEngine_interfaces.pyi — 进程层函数/常量面 / process-layer functions and constants.
# 源:cuihairu/kbengine typings(钉点 commit 见 typings/README.md),经
# scripts/derive-kbengine-stub-typings.mjs 生成;改内容请重跑,勿手工合并 /
# derived via the derive script; regenerate there, do not hand-merge.

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeAlias

from ._KBEngine_server_errors import *
from ._KBEngine_pythonapp import *

DatabaseCommandResult: TypeAlias = list[list[str]] | None
DatabaseCommandCallback: TypeAlias = Callable[
    [DatabaseCommandResult, int | None, int | None, str | None], Any
]

def accountLoginResponse(
    commitName: str, realAccountName: str, extraDatas: bytes, errorCode: int
) -> None: ...
def createAccountResponse(
    commitName: str, realAccountName: str, extraDatas: bytes, errorCode: int
) -> None: ...
def chargeResponse(
    orderID: str, extraDatas: bytes, errorCode: int
) -> None: ...
def executeRawDatabaseCommand(
    command: str,
    callback: DatabaseCommandCallback | None = None,
    threadID: int = 0,
    dbInterfaceName: str = "default",
) -> None: ...
def __getattr__(name: str) -> Any: ...
