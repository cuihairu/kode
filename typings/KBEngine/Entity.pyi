# Entity — one class per file (用户令 2026-11-11 / user directive: static
# template, one class per file, project copies are user-editable).
# 拆分自 _KBEngine_common.pyi(cuihairu/kbengine typings,钉点 commit 见
# typings/README.md),由 scripts/derive-kbengine-stub-typings.mjs 生成;
# 改内容请重跑派生脚本,勿手工合并 / split by the derive script — regenerate
# there, do not hand-merge.
# 共享头部是有意的:逐类裁剪易漂移,桩内多余 import 无副作用(注解经
# __future__ 惰性求值)/ generous shared header on purpose: per-class pruning
# invites drift, unused stub imports are inert.
from __future__ import annotations

from typing import (
    Any,
    BinaryIO,
    Callable,
    Dict,
    IO,
    List,
    Literal,
    Sequence,
    TextIO,
    Tuple,
    Union,
    overload,
)

from ._KBEngine_common import Address, Callback, Vector3Like, WatcherValue
from .EntityCall import EntityCall
from .EntityComponentCall import EntityComponentCall
from .MemoryStream import MemoryStream
from .GlobalDataClient import GlobalDataClient
from .Proxy import Proxy
from .Space import Space
from .EntityComponent import EntityComponent
from .Entities import Entities

class Entity:
    # kode overlay: baseapp 运行时属性(baseapp/entity.cpp:238);仅在 def 带
    # cell 部分的 baseapp 实体上安装,cellapp/client 实体不携带(cell 侧属性
    # 就是普通属性)/ baseapp-side runtime attribute, installed only on
    # baseapp entities whose def has a cell part.
    cellData: Dict[str, Any]
    id: int
    className: str
    client: Union[EntityCall, None]
    cell: Union[EntityCall, None]
    base: Union[EntityCall, None]
    databaseID: int
    databaseInterfaceName: str
    isDestroyed: bool
    shouldAutoArchive: Union[bool, int]
    shouldAutoBackup: Union[bool, int]
    # ---- cellapp 侧属性（server/cellapp/entity.cpp:76-90 SCRIPT_GET(SET)_DECLARE）----
    allClients: Any
    otherClients: Any
    isWitnessed: bool
    hasWitness: bool
    isOnGround: bool
    spaceID: int
    layer: int
    position: Vector3Like
    direction: Vector3Like
    topSpeed: float
    topSpeedY: float
    controlledBy: Any
    volatileInfo: Any

    def __init__(self) -> None: ...
    def __getattr__(self, name: str) -> Any: ...
    def __reduce_ex__(self, protocol: int) -> Any: ...
    def __getDEP__(self) -> Any: ...
    def addTimer(
        self, initialOffset: float, repeatOffset: float = 0.0, userArg: int = 0
    ) -> int: ...
    def delTimer(self, id: Union[int, str]) -> None: ...
    def destroy(
        self, deleteFromDB: bool = False, writeToDB: bool = False
    ) -> None: ...
    def writeToDB(
        self,
        callback: Union[Callback, None] = None,
        shouldAutoLoad: bool = False,
        dbInterfaceName: str = "default",
    ) -> None: ...
    @overload
    def getComponent(
        self, componentName: str, all: Literal[False] = False
    ) -> Union[EntityComponent, None]: ...
    @overload
    def getComponent(
        self, componentName: str, all: Literal[True]
    ) -> Tuple[EntityComponent, ...]: ...
    def fireEvent(self, eventName: str, *args: Any) -> None: ...
    def registerEvent(self, eventName: str, callback: Callback) -> None: ...
    def deregisterEvent(self, eventName: str, callback: Callback) -> None: ...
    def createCellEntity(
        self, cellEntityCall: Union[EntityCall, None] = None
    ) -> None: ...
    def createCellEntityInNewSpace(self, cellappIndex: int = 0) -> None: ...
    def destroyCellEntity(self) -> None: ...
    def clientEntity(self, destID: int) -> EntityCall: ...
    def isReal(self) -> bool: ...
    def cancelController(self, controllerID: Union[int, str]) -> None: ...
    def canNavigate(self) -> bool: ...
    def setViewRadius(self, radius: float, hyst: float = 5.0) -> None: ...
    def getViewRadius(self) -> float: ...
    def getViewHystArea(self) -> float: ...
    # ---- cellapp 侧移动/导航方法（server/cellapp/entity.cpp:52-64，
    #      签名照 DECLARE_PY_MOTHOD_ARGn 解析面，实参个数恒定）----
    def addProximity(self, range_xz: float, range_y: float, userArg: int) -> int: ...
    def addYawRotator(
        self, yaw: float, velocity: float, userData: Any
    ) -> int: ...
    def navigate(
        self,
        destination: Vector3Like,
        velocity: float,
        distance: float,
        maxMoveDistance: float,
        maxDistance: float,
        faceMovement: int,
        layer: int,
        userData: Any,
    ) -> int: ...
    def navigatePathPoints(
        self, destination: Vector3Like, maxSearchDistance: float, layer: int
    ) -> Tuple[Vector3Like, ...]: ...
    def getRandomPoints(
        self, centerPos: Vector3Like, maxRadius: float, maxPoints: int, layer: int
    ) -> Tuple[Vector3Like, ...]: ...
    def moveToPoint(
        self,
        destination: Vector3Like,
        velocity: float,
        distance: float,
        userData: Any,
        faceMovement: int,
        moveVertically: int,
    ) -> int: ...
    @overload
    def moveToEntity(
        self,
        targetID: int,
        velocity: float,
        distance: float,
        userData: Any,
        faceMovement: int,
        moveVertically: int,
    ) -> int: ...
    @overload
    def moveToEntity(
        self,
        targetID: int,
        velocity: float,
        distance: float,
        userData: Any,
        faceMovement: int,
        moveVertically: int,
        offset: Vector3Like,
    ) -> int: ...
    def accelerate(self, type: str, acceleration: float) -> float: ...
    def entitiesInView(self, pending: bool = False) -> Tuple[Entity, ...]: ...
    def entitiesInRange(
        self,
        range: float,
        entityType: Union[str, None] = None,
        position: Union[Vector3Like, None] = None,
    ) -> Tuple[Entity, ...]: ...
    def teleport(
        self,
        nearbyMBRef: Union[EntityCall, Entity, None],
        position: Vector3Like,
        direction: Vector3Like,
    ) -> None: ...
    def destroySpace(self) -> None: ...
    def debugView(self) -> None: ...
    def getWitnesses(self) -> Tuple[Entity, ...]: ...
