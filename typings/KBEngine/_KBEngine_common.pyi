# KBEngine 公共层 — 函数/常量/类型别名 / common layer: functions, constants,
# type aliases. 类已拆到 KBEngine/ 逐类文件 / classes moved to per-class files
# under KBEngine/。
# 由 scripts/derive-kbengine-stub-typings.mjs 生成,改内容请重跑,勿手工合并 /
# derived by scripts/derive-kbengine-stub-typings.mjs; regenerate there, do not
# hand-merge. Source: cuihairu/kbengine typings (pinned commit in README.md).

from collections.abc import Callable, Sequence
from typing import (
    Any,
    BinaryIO,
    Dict,
    IO,
    List,
    TextIO,
    Tuple,
    Union,
    overload,
)

try:
    from typing import Literal
except ImportError:
    from typing_extensions import Literal

from ._KBEngine_server_errors import *

# Type aliases
Vector3Like = Union[Tuple[float, float, float], Sequence[float]]
Address = Any
WatcherValue = Any
Callback = Callable[..., Any]

# 仅 baseapp 注入（server/baseapp/baseapp.cpp:463-473），其余组件模块上不存在
LOG_ON_ACCEPT: int
LOG_ON_REJECT: int
LOG_ON_WAIT_FOR_DESTROY: int
LOG_TYPE_NORMAL: int
LOG_TYPE_INFO: int
LOG_TYPE_ERR: int
LOG_TYPE_DBG: int
LOG_TYPE_WAR: int
NEXT_ONLY: int

component: str

def publish() -> int: ...
def scriptLogType(logType: int) -> None: ...
def getResFullPath(res: str) -> str: ...
def hasRes(res: str) -> bool: ...
def listPathRes(path: str, extension: str = "") -> Tuple[str, ...]: ...
def matchPath(res: str) -> str: ...
# 源码零参（lib/pyscript/py_gc.cpp:224-228）；pythonapp.pyi 的 debugTracing() 同
def debugTracing() -> None: ...
def genUUID64() -> int: ...
# baseapp/cellapp 模块未注册模块级 addTimer；仅 PythonApp 公共面
# （lib/server/python_app.cpp:721-726）恰 3 参 "ffO"，无默认值
def addTimer(
    initialOffset: float, repeatOffset: float, callbackObj: Callback
) -> int: ...
# 返回 timerID，失败 -1（python_app.cpp:766-771）
def delTimer(id: int) -> int: ...
def registerReadFileDescriptor(
    fileDescriptor: int, callback: Callback
) -> None: ...
def registerWriteFileDescriptor(
    fileDescriptor: int, callback: Callback
) -> None: ...
def deregisterReadFileDescriptor(fileDescriptor: int) -> None: ...
def deregisterWriteFileDescriptor(fileDescriptor: int) -> None: ...
def executeRawDatabaseCommand(
    command: str,
    callback: Union[Callback, None] = None,
    threadID: int = 0,
    dbInterfaceName: str = "default",
) -> None: ...
# 恰 2 参、无 encoding（lib/server/python_app.cpp:444-452）
def open(
    res: str, mode: str = "r"
) -> Union[IO[Any], TextIO, BinaryIO]: ...
# 仅 baseapp/cellapp 模块面（lib/server/entity_app.h:423）
def kbassert() -> None: ...
# 以下 3 个仅 interfaces 注册（server/tools/interfaces/interfaces.cpp:186-188），
# 其余组件模块上不存在（typing 层公共超集保留，调用方注意组件归属）
def accountLoginResponse(
    commitName: str, realAccountName: str, extraDatas: bytes, errorCode: int
) -> None: ...
def createAccountResponse(
    commitName: str, realAccountName: str, extraDatas: bytes, errorCode: int
) -> None: ...
def chargeResponse(
    orderID: str, extraDatas: bytes, errorCode: int
) -> None: ...
def urlopen(
    url: str,
    callback: Union[Callback, None] = None,
    postData: Union[bytes, None] = None,
    headers: Union[Dict[str, str], None] = None,
) -> None: ...
def __getattr__(name: str) -> Any: ...
