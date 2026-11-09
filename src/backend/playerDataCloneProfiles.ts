/**
 * Player Data Clone 的连接 Profile 台账(CLONE-P5 / PDC-0501):Source(只读源)
 * 与 Target(本地可写目标)各一份,配置经注入持久层(workspaceState 面)按
 * profile 角色隔离;密码永不入配置——只进注入的 SecretStorage 面(键含角色,
 * 删除配置即删密钥)。
 *
 * 环境铁律(§6.1):target 的 environment 只接受 local/test,prod/staging
 * 值在配置闸就拒绝(不等 Rust 侧复核);source 无环境概念,是任意只读源。
 */

export type CloneProfileRole = 'source' | 'target';

export interface CloneProfile {
  host: string;
  port: number;
  user: string;
  database: string;
  /** target 专用:local/test(§6.1;source 无此字段)。 */
  environment?: 'local' | 'test';
  /** 密码是否已存(密码本体只进 secrets 面)。 */
  hasStoredSecret: boolean;
}

export interface CloneProfileDeps {
  load(): unknown;
  save(data: unknown): void;
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

interface ProfilePayload {
  profiles: Partial<Record<CloneProfileRole, CloneProfile>>;
}

const isProfile = (value: unknown, role: CloneProfileRole): value is CloneProfile => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.host !== 'string' ||
    typeof candidate.port !== 'number' ||
    typeof candidate.user !== 'string' ||
    typeof candidate.database !== 'string'
  ) {
    return false;
  }
  if (role === 'target') {
    // §6.1:目标环境只认 local/test;prod/staging 及未知值在配置闸拒绝。
    if (candidate.environment !== 'local' && candidate.environment !== 'test') {
      return false;
    }
  }
  return true;
};

const secretKey = (role: CloneProfileRole): string => `kode.playerClone.${role}.password`;

export class CloneProfileStore {
  private readonly deps: CloneProfileDeps;
  private readonly profiles = new Map<CloneProfileRole, CloneProfile>();

  constructor(deps: CloneProfileDeps) {
    this.deps = deps;
    const payload = deps.load();
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload)) {
      const record = (payload as ProfilePayload).profiles;
      if (typeof record === 'object' && record !== null) {
        for (const role of ['source', 'target'] as CloneProfileRole[]) {
          const candidate = (record as Record<string, unknown>)[role];
          if (isProfile(candidate, role)) {
            this.profiles.set(role, candidate);
          }
        }
      }
    }
  }

  get(role: CloneProfileRole): CloneProfile | null {
    return this.profiles.get(role) ?? null;
  }

  /** 保存配置;password 传 undefined 保留既有密钥,传 null 清除。 */
  async save(
    role: CloneProfileRole,
    profile: Omit<CloneProfile, 'hasStoredSecret'>,
    password: string | undefined | null
  ): Promise<void> {
    const existing = this.profiles.get(role);
    const nextPassword =
      password === null
        ? null
        : password !== undefined
          ? password
          : existing?.hasStoredSecret
            ? ((await this.deps.secrets.get(secretKey(role))) ?? null)
            : null;
    if (nextPassword === null) {
      await this.deps.secrets.delete(secretKey(role));
    } else {
      await this.deps.secrets.store(secretKey(role), nextPassword);
    }
    const stored: CloneProfile = {
      ...profile,
      hasStoredSecret: nextPassword !== null
    };
    this.profiles.set(role, stored);
    this.persist();
  }

  /** 取完整建连参数(密码只从 secrets 面 读;未存密码如实 undefined)。 */
  async resolveConnection(
    role: CloneProfileRole
  ): Promise<{
    host: string;
    port: number;
    user: string;
    password: string | undefined;
    database: string;
    environment?: 'local' | 'test';
  } | null> {
    const profile = this.profiles.get(role);
    if (!profile) {
      return null;
    }
    const password = profile.hasStoredSecret
      ? await this.deps.secrets.get(secretKey(role))
      : undefined;
    return {
      host: profile.host,
      port: profile.port,
      user: profile.user,
      password,
      database: profile.database,
      environment: profile.environment
    };
  }

  clear(role: CloneProfileRole): Promise<void> {
    this.profiles.delete(role);
    this.persist();
    return this.deps.secrets.delete(secretKey(role));
  }

  private persist(): void {
    const payload: ProfilePayload = {
      profiles: {
        source: this.profiles.get('source'),
        target: this.profiles.get('target')
      }
    };
    this.deps.save(payload);
  }
}
