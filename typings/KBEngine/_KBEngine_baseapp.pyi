# _KBEngine_baseapp.pyi — 进程层函数/常量面 / process-layer functions and constants.
# 源:cuihairu/kbengine typings(钉点 commit 见 typings/README.md),经
# scripts/derive-kbengine-stub-typings.mjs 生成;改内容请重跑,勿手工合并 /
# derived via the derive script; regenerate there, do not hand-merge.

from collections.abc import Callable
from typing import Any, Dict, Tuple, Union

from ._KBEngine_common import Address, Callback, WatcherValue
from .Entities import Entities
from .Entity import Entity
from .EntityCall import EntityCall
from .GlobalDataClient import GlobalDataClient

entities: Entities
globalData: GlobalDataClient
baseAppData: GlobalDataClient

# baseapp/cellapp 模块面（lib/server/entity_app.h:423）
def kbassert() -> None: ...

def address() -> Address: ...
def time() -> int: ...
def isShuttingDown() -> bool: ...
def getWatcher(path: str) -> WatcherValue: ...
def getWatcherDir(path: str) -> Tuple[str, ...]: ...
def addWatcher(
    path: str,
    dataType: str,
    getFunction: Callable[[], WatcherValue],
) -> None: ...
def delWatcher(path: str) -> None: ...
def setAppFlags(flags: int) -> None: ...
def getAppFlags() -> int: ...
def reloadScript(fullReload: bool = False) -> None: ...
def quantumPassedPercent() -> int: ...
def createEntity(
    entityType: str,
    params: Union[Dict[str, Any], None] = None,
) -> Union[Entity, None]: ...
def createEntityLocally(
    entityType: str,
    params: Union[Dict[str, Any], None] = None,
) -> Union[Entity, None]: ...
def createEntityAnywhere(
    entityType: str,
    params: Union[Dict[str, Any], None] = None,
    callback: Union[Callback, None] = None,
) -> None: ...
def createEntityRemotely(
    entityType: str,
    baseMB: EntityCall,
    params: Union[Dict[str, Any], None] = None,
    callback: Union[Callback, None] = None,
) -> None: ...
def createEntityFromDBID(
    entityType: str,
    dbID: int,
    callback: Union[Callback, None] = None,
    dbInterfaceName: str = "default",
) -> None: ...
def createEntityAnywhereFromDBID(
    entityType: str,
    dbID: int,
    callback: Union[Callback, None] = None,
    dbInterfaceName: str = "default",
) -> None: ...
def createEntityRemotelyFromDBID(
    entityType: str,
    dbID: int,
    baseMB: EntityCall,
    callback: Union[Callback, None] = None,
    dbInterfaceName: str = "default",
) -> None: ...
# 恰 4 参，pycallback 不可省（server/baseapp/baseapp.cpp:3398-3403）
def charge(
    ordersID: str,
    dbID: int,
    byteDatas: bytes,
    pycallback: Callback,
) -> None: ...
def deleteEntityByDBID(
    entityType: str,
    dbID: int,
    callback: Union[Callback, None] = None,
    dbInterfaceName: str = "default",
) -> None: ...
def lookUpEntityByDBID(
    entityType: str,
    dbID: int,
    callback: Callback,
    dbInterfaceName: str = "default",
) -> None: ...
