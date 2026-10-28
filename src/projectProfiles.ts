/**
 * 项目 profile 身份(IDE-PRJ-001):一个 profile = 一套 assets 根 + engine 根
 * 组合 + 显示名。同一工作区可保存多套组合,各自持有独立的持久稳定 ID——
 * ID 只在创建时分配一次(randomUUID),之后存取/改名/改根都以 ID 为键,
 * 显示名绝不是主键(两条同名共存、改名不丢身份),组合路径变了身份也不漂移。
 * 持久化走 workspaceState(Memento,逐工作区落盘),重启后 ID 照旧读回;
 * 极简装配上下文(无 workspaceState)退化为会话内记忆:功能可用只是不跨重启。
 */

import { randomUUID } from 'crypto';
import type * as vscode from 'vscode';

/** 一条 profile 记录:身份是 id,其余字段都可变 */
export interface ProjectProfile {
  /** 稳定 ID:创建时一次分配,持久化,不随显示名/路径变化 */
  readonly id: string;
  displayName: string;
  assetsRoot: string;
  engineRoot: string;
}

export type ProjectProfilePatch = Partial<Omit<ProjectProfile, 'id'>>;

/** workspaceState 持久化键(v1:结构变化时换新键,不迁移旧形态) */
export const PROJECT_PROFILES_STATE_KEY = 'kbengine.projectProfiles.v1';

/** 持久化载荷按字段校验:缺任一字符串字段的条目视为损坏,静默跳过不炸 */
function isProfileEntry(value: unknown): value is ProjectProfile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    record.id.length > 0 &&
    typeof record.displayName === 'string' &&
    typeof record.assetsRoot === 'string' &&
    typeof record.engineRoot === 'string'
  );
}

/** 读出面统一:有 memento 读持久层,否则读会话记忆(极简装配上下文) */
function readProfiles(memento: vscode.Memento | undefined, session: ProjectProfile[]): ProjectProfile[] {
  if (!memento) {
    return session;
  }
  const raw = memento.get<unknown>(PROJECT_PROFILES_STATE_KEY);
  return Array.isArray(raw) ? raw.filter(isProfileEntry) : [];
}

export class ProjectProfileStore {
  /** 无 memento 时的会话记忆(与 memento 互斥使用,见 readProfiles) */
  private readonly sessionProfiles: ProjectProfile[] = [];

  constructor(private readonly memento?: vscode.Memento) {}

  list(): ProjectProfile[] {
    return readProfiles(this.memento, this.sessionProfiles).map(profile => ({ ...profile }));
  }

  get(id: string): ProjectProfile | null {
    const found = readProfiles(this.memento, this.sessionProfiles).find(profile => profile.id === id);
    return found ? { ...found } : null;
  }

  /** 新建一条 profile:分配稳定 ID 后整表落盘(幂等键冲突时重摇 ID) */
  async create(input: Omit<ProjectProfile, 'id'>): Promise<ProjectProfile> {
    const profiles = readProfiles(this.memento, this.sessionProfiles);
    let id = randomUUID();
    while (profiles.some(profile => profile.id === id)) {
      id = randomUUID();
    }
    const created: ProjectProfile = { id, ...input };
    await this.persist([...profiles, created]);
    return { ...created };
  }

  /** 按 ID 更新可变字段:身份不动;ID 不存在返回 null(不静默新建) */
  async update(id: string, patch: ProjectProfilePatch): Promise<ProjectProfile | null> {
    const profiles = readProfiles(this.memento, this.sessionProfiles);
    const index = profiles.findIndex(profile => profile.id === id);
    if (index < 0) {
      return null;
    }
    const updated: ProjectProfile = { ...profiles[index], ...patch, id };
    profiles[index] = updated;
    await this.persist(profiles);
    return { ...updated };
  }

  /**
   * 按 profile 保存根与引擎路径(IDE-PRJ-002):只动目标记录的路径字段,
   * 身份与其余字段不动;整表落盘保证其他 profile 记录字节原样——两个
   * profile 的根路径在重启(新 store 同一 memento)后仍各自独立可读回。
   * 未知 ID 返回 null,绝不静默新建。
   */
  async saveRoots(id: string, roots: { assetsRoot?: string; engineRoot?: string }): Promise<ProjectProfile | null> {
    return this.update(id, roots);
  }

  /** 按 ID 删除:返回是否真删了一条 */
  async remove(id: string): Promise<boolean> {
    const profiles = readProfiles(this.memento, this.sessionProfiles);
    const remaining = profiles.filter(profile => profile.id !== id);
    if (remaining.length === profiles.length) {
      return false;
    }
    await this.persist(remaining);
    return true;
  }

  private async persist(profiles: ProjectProfile[]): Promise<void> {
    if (this.memento) {
      await this.memento.update(PROJECT_PROFILES_STATE_KEY, profiles);
      return;
    }
    this.sessionProfiles.length = 0;
    this.sessionProfiles.push(...profiles);
  }
}
