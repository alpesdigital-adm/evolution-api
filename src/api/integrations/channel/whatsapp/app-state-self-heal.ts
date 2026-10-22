/**
 * Self-heal for a corrupted WhatsApp app-state (LTHash) collection.
 *
 * Baileys (decodePatches, Utils/chat-utils.js) reacts to an LTHash mismatch by
 * logging a warning, `break`ing out of the patch loop and returning the state it
 * had already advanced (new version + the hash of the mismatching patch). The
 * caller persists that state. Nothing throws, so resyncAppState never forces a
 * snapshot: every later patch starts from a wrong hash and fails the same way,
 * forever, while the stored version keeps advancing. Symptom: read/unread
 * changes made on the phone (regular_low) stop producing `chats.update`.
 *
 * The cure is the one we applied by hand: drop `app-state-sync-version-<name>`
 * so the next resync starts at v0 and asks the server for a full snapshot.
 *
 * This module has no Baileys runtime import so it can be unit-tested alone.
 */

export const APP_STATE_COLLECTIONS = [
  'critical_block',
  'critical_unblock_low',
  'regular_high',
  'regular_low',
  'regular',
] as const;
export type AppStateCollection = (typeof APP_STATE_COLLECTIONS)[number];

/**
 * The exact Baileys warning for a patch mismatch. The snapshot variant
 * ("LTHash verification failed on snapshot, continuing with partial state") is
 * deliberately NOT matched: a snapshot is already the full resync, so retrying it
 * could only loop.
 */
export const LTHASH_PATCH_FAILURE_MSG = 'LTHash verification failed, skipping remaining patches';

export type LtHashFailure = { name: AppStateCollection; version?: number };

/** Recognises pino-style `warn({ name, version }, msg)` calls carrying the patch failure. */
export function parseLtHashPatchFailure(args: unknown[]): LtHashFailure | null {
  const [obj, msg] = args;
  if (msg !== LTHASH_PATCH_FAILURE_MSG || !obj || typeof obj !== 'object') return null;
  const { name, version } = obj as { name?: unknown; version?: unknown };
  if (typeof name !== 'string' || !(APP_STATE_COLLECTIONS as readonly string[]).includes(name)) return null;
  return { name: name as AppStateCollection, version: typeof version === 'number' ? version : undefined };
}

/**
 * Wraps a pino logger so `warn` calls are inspected before being forwarded
 * untouched. A Proxy (instead of a pino `logMethod` hook) keeps working when the
 * configured level is above `warn`, where pino replaces the method with a no-op
 * and hooks never run. `child()` loggers are wrapped too.
 */
export function watchAppStateFailures<T extends object>(logger: T, onFailure: (failure: LtHashFailure) => void): T {
  return new Proxy(logger, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'warn') {
        return (...args: unknown[]) => {
          try {
            const failure = parseLtHashPatchFailure(args);
            if (failure) onFailure(failure);
          } catch {
            // Detection must never break Baileys' own logging.
          }
          return value.apply(target, args);
        };
      }
      if (prop === 'child') {
        return (...args: unknown[]) => watchAppStateFailures(value.apply(target, args), onFailure);
      }
      return value.bind(target);
    },
    set(target, prop, value) {
      (target as Record<PropertyKey, unknown>)[prop] = value;
      return true;
    },
  });
}

export interface AppStateHealTarget {
  /** True only while the socket is open; the heal never runs otherwise. */
  isOpen(): boolean;
  /** Stored version of the collection, undefined when nothing is stored. */
  readVersion(name: AppStateCollection): Promise<number | undefined>;
  /** Removes the stored version (through the socket's key store, so its in-memory cache is cleared too). */
  clearVersion(name: AppStateCollection): Promise<void>;
  /** Runs Baileys' resyncAppState([name], false). */
  resync(name: AppStateCollection): Promise<void>;
}

/** Structural subset of a Baileys socket, so this file needs no Baileys import. */
export interface AppStateSocketLike {
  authState: {
    creds?: { me?: { id?: string } };
    keys: {
      get(
        type: 'app-state-sync-version',
        ids: string[],
      ): MaybePromise<Record<string, { version?: number } | null | undefined>>;
      set(data: { 'app-state-sync-version': Record<string, null> }): MaybePromise<void>;
      transaction<T>(work: () => Promise<T>, key: string): Promise<T>;
    };
  };
  resyncAppState(collections: AppStateCollection[], isInitialSync: boolean): Promise<void>;
}

type MaybePromise<T> = T | PromiseLike<T>;

/**
 * Bridges the healer to a socket. Clearing goes through the socket's own key
 * store (not Redis directly) so the in-memory makeCacheableSignalKeyStore cache
 * is cleared too, inside a transaction on the same mutex key resyncAppState
 * uses, so it queues behind a sync that is still running.
 */
export function createSocketHealTarget(socket: AppStateSocketLike, isOpen: () => boolean): AppStateHealTarget {
  const { keys, creds } = socket.authState;
  return {
    isOpen,
    readVersion: async (name) => (await keys.get('app-state-sync-version', [name]))?.[name]?.version,
    clearVersion: async (name) => {
      await keys.transaction(async () => {
        await keys.set({ 'app-state-sync-version': { [name]: null } });
      }, creds?.me?.id || 'resync-app-state');
    },
    resync: (name) => socket.resyncAppState([name], false),
  };
}

type HealLog = { warn: (msg: string) => void; error: (msg: string) => void };

export interface AppStateHealerOptions {
  instanceName: string;
  /** Resolved on every attempt: the socket changes on each reconnect. */
  getTarget: () => AppStateHealTarget | undefined;
  log: HealLog;
  cooldownMs?: number;
  maxAttemptsPerHour?: number;
  pollMs?: number;
  now?: () => number;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * One healer per instance: it only ever acts through that instance's target.
 *
 * Detection happens synchronously inside Baileys' sync transaction, and the
 * failing state is committed when that transaction ends. Healing therefore never
 * runs from the log callback: it is queued and executed later by a poller that
 * is not part of the transaction (a timer started from inside it would inherit
 * its AsyncLocalStorage context and write into an already-closed transaction).
 */
export class AppStateSelfHealer {
  private readonly pending = new Map<AppStateCollection, number | undefined>();
  private readonly attempts = new Map<AppStateCollection, number[]>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;

  private readonly cooldownMs: number;
  private readonly maxAttemptsPerHour: number;
  private readonly pollMs: number;
  private readonly now: () => number;

  constructor(private readonly options: AppStateHealerOptions) {
    this.cooldownMs = options.cooldownMs ?? 10 * 60 * 1000;
    this.maxAttemptsPerHour = options.maxAttemptsPerHour ?? 3;
    this.pollMs = options.pollMs ?? 5_000;
    this.now = options.now ?? Date.now;
  }

  /** Synchronous and side-effect free beyond queueing: safe to call from a logger. */
  report(failure: LtHashFailure): void {
    this.pending.set(failure.name, failure.version);
  }

  get pendingCollections(): AppStateCollection[] {
    return [...this.pending.keys()];
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Processes the queue once. Collections stay queued while the socket is not open. */
  async flush(): Promise<void> {
    if (this.busy || this.pending.size === 0) return;
    const target = this.options.getTarget();
    if (!target || !target.isOpen()) return;

    this.busy = true;
    try {
      for (const [name, reportedVersion] of [...this.pending]) {
        this.pending.delete(name);
        await this.heal(target, name, reportedVersion);
      }
    } finally {
      this.busy = false;
    }
  }

  private async heal(target: AppStateHealTarget, name: AppStateCollection, reportedVersion?: number): Promise<void> {
    const { instanceName, log } = this.options;
    const now = this.now();
    const recent = (this.attempts.get(name) ?? []).filter((at) => now - at < HOUR_MS);
    const last = recent[recent.length - 1];

    if (last !== undefined && now - last < this.cooldownMs) {
      log.warn(
        `app-state self-heal: ${instanceName} ${name} skipped (cooldown, last attempt ${Math.round((now - last) / 1000)}s ago)`,
      );
      this.attempts.set(name, recent);
      return;
    }
    if (recent.length >= this.maxAttemptsPerHour) {
      log.warn(`app-state self-heal: ${instanceName} ${name} skipped (${recent.length} attempts in the last hour)`);
      this.attempts.set(name, recent);
      return;
    }
    recent.push(now);
    this.attempts.set(name, recent);

    try {
      const oldVersion = (await target.readVersion(name)) ?? reportedVersion;
      log.warn(`app-state self-heal: ${instanceName} ${name} v${oldVersion ?? '?'} → snapshot`);
      await target.clearVersion(name);
      await target.resync(name);
      const newVersion = await target.readVersion(name);
      if (newVersion === undefined) {
        log.error(`app-state self-heal: ${instanceName} ${name} FAILED (no state stored after resync)`);
      } else {
        log.warn(`app-state self-heal: ${instanceName} ${name} OK (snapshot restored at v${newVersion})`);
      }
    } catch (error) {
      log.error(
        `app-state self-heal: ${instanceName} ${name} FAILED (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}
