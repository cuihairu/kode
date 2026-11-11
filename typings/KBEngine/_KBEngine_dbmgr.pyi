# _KBEngine_dbmgr.pyi — 进程层函数/常量面 / process-layer functions and constants.
# 源:cuihairu/kbengine typings(钉点 commit 见 typings/README.md),经
# scripts/derive-kbengine-stub-typings.mjs 生成;改内容请重跑,勿手工合并 /
# derived via the derive script; regenerate there, do not hand-merge.

from collections.abc import Callable
from typing import Any, List, Tuple, Union

from ._KBEngine_server_errors import *
from ._KBEngine_pythonapp import *

# Type aliases
DatabaseCommandResult = Union[List[List[str]], None]
DatabaseCommandCallback = Callable[
    [
        DatabaseCommandResult,
        Union[int, None],
        Union[int, None],
        Union[str, None],
    ],
    Any,
]

def executeRawDatabaseCommand(
    command: str,
    callback: Union[DatabaseCommandCallback, None] = None,
    threadID: int = 0,
    dbInterfaceName: str = "default",
) -> None: ...
def __getattr__(name: str) -> Any: ...
