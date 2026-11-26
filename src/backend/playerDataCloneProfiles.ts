/**
 * Player Data Clone connection-profile ledger (CLONE-P5 / PDC-0501): one entry each for
 * Source (a read-only source) and Target (a locally writable target); config goes through
 * the injected persistence layer (the workspaceState face), isolated per profile role;
 * passwords never enter the config -- they only go into the injected SecretStorage face
 * (the key carries the role, so deleting the config deletes the secret).
 *
 * Environment iron rule (§6.1): the target's environment only accepts local/test;
 * prod/staging values are rejected at the config gate (not waiting for the Rust side to
 * re-check); the source has no environment notion, it is an arbitrary read-only source.
 */

export type CloneProfileRole = 'source' | 'target';

export interface CloneProfile {
  host: string;
  port: number;
  user: string;
  database: string;
  /** Target-only: local/test (§6.1; the source has no such field). */
  environment?: 'local' | 'test';
  /** Whether a password is stored (the password itself only lives in the secrets face). */
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
    // §6.1: the target environment only accepts local/test; prod/staging and unknown values are rejected at the config gate.
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

  /** Save the config; password undefined keeps the existing secret, null clears it. */
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

  /** Resolve the full connection parameters (the password is only read from the secrets face; no stored password means an honest undefined). */
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
