# _KBEngine_logger.pyi — 进程层函数/常量面 / process-layer functions and constants.
# 源:cuihairu/kbengine typings(钉点 commit 见 typings/README.md),经
# scripts/derive-kbengine-stub-typings.mjs 生成;改内容请重跑,勿手工合并 /
# derived via the derive script; regenerate there, do not hand-merge.

from collections.abc import Callable
from typing import Any, List, Tuple, Union

from ._KBEngine_server_errors import *
from ._KBEngine_pythonapp import *

# Type aliases
# 注：logger 进程只继承 PythonApp（server/tools/logger/logger.h:49），
# logger.cpp 无任何 APPEND_SCRIPT_MODULE_METHOD 注册，模块面即 PythonApp 公共 API。
# 以下别名保留为 typing 层定义（核验报告判定 OK），但 logger 模块上没有
# accountLoginResponse / createAccountResponse / chargeResponse /
# executeRawDatabaseCommand（它们分别仅注册于 interfaces / baseapp / cellapp / dbmgr）。
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

def __getattr__(name: str) -> Any: ...
