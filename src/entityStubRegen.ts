// C-22 交付①补:def 增删改 → entity_types.pyi 自动再生控制器。
// 此前实体桩只在激活/托管目录事件/两个内容开关切换时再生,改 .def 后
// 桩与来源镜一直旧到重载窗口(C-22 验收「改 def ≤1 周期内更新」不满足)。
// 本层只做事件过滤与尾沿去抖;再生本体(exportEntityTypeStubs)自带
// stubExport 总闸与内容比对零写,重复触发无副作用。纯逻辑层,不 import
// vscode,extension 装配线把 pythonIndexFileEvents 的文件事件喂进来。
//
// 口径(诚实面):只盯 `.def` 尾缀(types.xml/entities.xml 变更影响注解与
// 映射,属后续批次,不虚标);连续事件合并为一次尾沿再生;dispose 丢弃
// 未触发的挂起计时,不再生。

export interface EntityStubRegenHooks {
  /** 去抖到期时执行再生(桩导出 + 调用方自带的计划刷新) */
  regenerate: () => void;
}

const DEFAULT_DEBOUNCE_MS = 400;

export class EntityStubRegenController {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly hooks: EntityStubRegenHooks,
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS
  ) {}

  /** 文件事件入口:非 .def 即刻忽略;.def 重置尾沿计时(增删改同策) */
  onFileEvent(fsPath: string): void {
    if (!fsPath.toLowerCase().endsWith('.def')) {
      return;
    }
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      this.hooks.regenerate();
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
