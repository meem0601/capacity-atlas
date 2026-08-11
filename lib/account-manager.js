import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as nodeExistsSync } from "node:fs";
import { access, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, posix, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";
import { ProviderHelperManager } from "./provider-helper.js";
function connectorChildEnv(base = process.env, overrides = {}) {
  const environment = { ...base, ...overrides };
  delete environment.CAPACITY_ATLAS_TOKEN;
  delete environment.CAPACITY_ATLAS_RUNTIME_PATH;
  return environment;
}

const execFile = promisify(nodeExecFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const TERMINAL_LOGIN_STATUSES = new Set(["completed", "failed", "cancelled", "expired"]);

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

const PROVIDER_SPECS = {
  codex: {
    command: "codex",
    args: ["login"],
    envKey: "CODEX_HOME",
    credentialFile: "auth.json",
    isolated: true
  },
  claude: {
    command: "claude",
    args: ["auth", "login", "--claudeai"],
    credentialFile: ".credentials.json",
    ambientHome: ".claude",
    isolated: false
  },
  grok: {
    command: "grok",
    args: ["login", "--oauth"],
    envKey: "GROK_HOME",
    credentialFile: "auth.json",
    isolated: true
  }
};

export function resolveProviderCommand(provider, {
  execPath = process.execPath,
  platform = process.platform,
  home = homedir(),
  env = process.env,
  existsSync = nodeExistsSync
} = {}) {
  const spec = PROVIDER_SPECS[provider];
  if (!spec) throw new Error("未対応のAIサービスです。");
  const override = env[`CAPACITY_ATLAS_${provider.toUpperCase()}_BIN`];
  if (override) return override;
  const pathApi = platform === "win32" ? win32 : posix;
  const filename = platform === "win32" ? `${provider}.exe` : provider;
  const bundled = pathApi.join(pathApi.dirname(execPath), filename);
  const candidates = [bundled];
  if (platform === "win32") {
    candidates.push(
      pathApi.join(home, ".local", "bin", filename),
      pathApi.join(home, `.${provider}`, "bin", filename)
    );
  } else {
    if (provider === "claude") candidates.push(pathApi.join(home, ".local", "bin", "claude"));
    if (provider === "grok") candidates.push(pathApi.join(home, ".grok", "bin", "grok"));
    candidates.push(`/opt/homebrew/bin/${provider}`, `/usr/local/bin/${provider}`);
  }
  return candidates.find(candidate => existsSync(candidate)) || spec.command;
}

export function loginSpec(provider, requestedHome) {
  const spec = PROVIDER_SPECS[provider];
  if (!spec) throw new Error("未対応のAIサービスです。");
  const profileHome = spec.isolated ? requestedHome : join(homedir(), spec.ambientHome);
  return {
    command: spec.command,
    args: [...spec.args],
    env: spec.envKey ? { [spec.envKey]: profileHome } : {},
    credentialPath: join(profileHome, spec.credentialFile),
    profileHome,
    isolated: spec.isolated
  };
}

export function sanitizeLoginOutput(value) {
  return String(value || "")
    .replace(/\u001b?\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/((?:["']?(?:access|refresh|id)[_-]?token["']?|["']?client[_-]?secret["']?|["']?authorization[_-]?code["']?|["']?cookie["']?)\s*[:=]\s*)(["'])(.*?)\2/gi, "$1$2[REDACTED]$2")
    .replace(/((?:(?:access|refresh|id)[_-]?token|client[_-]?secret|authorization[_-]?code|cookie)\s*[=:]\s*)[^\s,}\]]+/gi, "$1[REDACTED]")
    .replace(/(authorization\s*:\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [REDACTED]")
    .replace(/([?&#](?:(?:access|refresh|id)[_-]?token|client[_-]?secret|authorization[_-]?code|code)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{4,})?\b/g, "[REDACTED]")
    .replace(/\b(?:sk|sess|xai)-[A-Za-z0-9._-]{12,}\b/g, "[REDACTED]")
    .slice(-12_000);
}

async function exists(path, accessFn) {
  try {
    await accessFn(path);
    return true;
  } catch {
    return false;
  }
}

export class AccountManager {
  constructor({
    root = join(homedir(), ".capacity-atlas"),
    spawn = nodeSpawn,
    execFile: execFileFn = execFile,
    mkdir: mkdirFn = mkdir,
    access: accessFn = access,
    readFile: readFileFn = readFile,
    rename: renameFn = rename,
    rm: rmFn = rm,
    writeFile: writeFileFn = writeFile,
    helperManager = new ProviderHelperManager({ root: join(root, "helpers") }),
    loginTimeoutMs = 15 * 60_000,
    authenticationTimeoutMs = 15_000,
    killGraceMs = 2_000,
    sessionRetentionMs = 5 * 60_000
  } = {}) {
    this.root = root;
    this.spawn = spawn;
    this.execFile = execFileFn;
    this.mkdir = mkdirFn;
    this.access = accessFn;
    this.readFile = readFileFn;
    this.rename = renameFn;
    this.rm = rmFn;
    this.writeFile = writeFileFn;
    this.atomicWrites = writeFileFn === writeFile;
    this.helperManager = helperManager;
    this.loginTimeoutMs = loginTimeoutMs;
    this.authenticationTimeoutMs = authenticationTimeoutMs;
    this.killGraceMs = killGraceMs;
    this.sessionRetentionMs = sessionRetentionMs;
    this.sessions = new Map();
    this.loginQueues = new Map();
    this.inFlightStarts = new Set();
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.mutationQueues = new Map();
    this.registryPath = join(root, "accounts.json");
    this.providerMetadataPath = join(root, "provider-metadata.json");
  }

  start(provider) {
    if (this.shuttingDown) return Promise.reject(new Error("Connectorを終了しています。認証は開始できません。"));
    const previous = this.loginQueues.get(provider) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => this.startExclusive(provider));
    this.loginQueues.set(provider, run);
    this.inFlightStarts.add(run);
    return run.finally(() => {
      this.inFlightStarts.delete(run);
      if (this.loginQueues.get(provider) === run) this.loginQueues.delete(provider);
    });
  }

  async startExclusive(provider) {
    if (this.shuttingDown) throw new Error("Connectorを終了しています。認証は開始できません。");
    const active = [...this.sessions.values()].find(session =>
      session.provider === provider && !["completed", "failed", "cancelled", "expired"].includes(session.status)
    );
    if (active) await this.cancel(active.id);
    const id = randomUUID();
    const requestedHome = join(this.root, "profiles", provider, id);
    const spec = loginSpec(provider, requestedHome);
    const home = spec.profileHome;
    const session = {
      id,
      provider,
      home,
      status: "starting",
      output: "認証を開始しています…",
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      isolated: spec.isolated
    };
    this.sessions.set(id, session);
    try {
      await this.mkdir(home, { recursive: true, mode: 0o700 });
    } catch (error) {
      session.status = "failed";
      session.output = "認証フォルダを準備できませんでした。";
      session.updatedAt = new Date().toISOString();
      await this.finalizeSession(session);
      throw error;
    }
    if (this.shuttingDown) {
      session.status = "cancelled";
      session.output = "Connectorの終了により認証をキャンセルしました。";
      session.updatedAt = new Date().toISOString();
      await this.finalizeSession(session);
      throw new Error("Connectorを終了しています。認証は開始できません。");
    }
    session.timeout = setTimeout(() => {
      if (!["completed", "failed", "cancelled", "expired"].includes(session.status)) {
        session.status = "expired";
        session.output = "認証が時間切れになりました。もう一度お試しください。";
        session.updatedAt = new Date().toISOString();
        void this.stopChild(session).finally(() => this.finalizeSession(session));
      }
    }, this.loginTimeoutMs);
    session.timeout.unref?.();

    if (["claude", "grok"].includes(provider)) {
      session.status = "preparing";
      session.output = "公式認証機能を準備しています…";
      const preparation = this.prepareManagedLogin(session, spec);
      session.preparation = preparation;
      void preparation.finally(() => {
        if (session.preparation === preparation) session.preparation = null;
      });
      return this.publicSession(session);
    }

    this.spawnLogin(session, spec, resolveProviderCommand(provider));
    return this.publicSession(session);
  }

  canContinue(session) {
    return !this.shuttingDown && !TERMINAL_LOGIN_STATUSES.has(session.status);
  }

  async withSessionTransition(session, operation) {
    const previous = session.transition || Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    session.transition = current;
    try {
      return await current;
    } finally {
      if (session.transition === current) session.transition = null;
    }
  }

  async withTimeout(promise, timeoutMs, message) {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async prepareManagedLogin(session, spec) {
    try {
      const command = await this.helperManager.ensure(session.provider, {
        onProgress: progress => {
          if (!this.canContinue(session)) return;
          session.status = "preparing";
          session.output = sanitizeLoginOutput(progress?.message || "公式認証機能を準備しています…");
          session.updatedAt = new Date().toISOString();
        }
      });
      if (!this.canContinue(session)) return;
      this.spawnLogin(session, spec, command);
    } catch (error) {
      if (!this.canContinue(session)) {
        await this.finalizeSession(session);
        return;
      }
      session.status = "failed";
      session.output = sanitizeLoginOutput(error?.message || "公式認証機能を準備できませんでした。");
      session.updatedAt = new Date().toISOString();
      await this.finalizeSession(session);
    }
  }

  spawnLogin(session, spec, command) {
    if (!this.canContinue(session)) {
      void this.finalizeSession(session);
      return;
    }
    session.command = command;
    let child;
    try {
      child = this.spawn(command, spec.args, {
        env: connectorChildEnv(process.env, spec.env),
        stdio: ["ignore", "pipe", "pipe"]
      });
      session.child = child;
      session.closed = new Promise(resolve => { session.resolveClosed = resolve; });
      session.isolated = spec.isolated;
    } catch (error) {
      session.status = "failed";
      session.output = sanitizeLoginOutput(error.message);
      void this.finalizeSession(session);
      return;
    }

    const append = (chunk, status = "waiting") => {
      if (!this.canContinue(session)) return;
      session.output = sanitizeLoginOutput(`${session.output}\n${chunk}`);
      session.status = status;
      session.updatedAt = new Date().toISOString();
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", error => {
      const providerName = { codex: "GPT / Codex", claude: "Claude", grok: "Grok" }[session.provider] || session.provider;
      const message = error?.code === "ENOENT"
        ? `${providerName}の認証機能を起動できませんでした。Connectorを再起動して、もう一度お試しください。`
        : error.message;
      append(message, "failed");
    });
    child.on("close", code => {
      session.resolveClosed?.();
      session.resolveClosed = null;
      session.child = null;
      clearTimeout(session.timeout);
      if (TERMINAL_LOGIN_STATUSES.has(session.status)) {
        void this.finalizeSession(session);
        return;
      }
      const finishing = this.finish(session, spec, code).catch(error => {
        if (!this.canContinue(session)) return;
        session.status = "failed";
        session.output = sanitizeLoginOutput(`${session.output}\n${error?.message || "認証情報を安全に保存できませんでした。"}`);
        session.updatedAt = new Date().toISOString();
      }).finally(() => this.finalizeSession(session));
      session.finishing = finishing;
      void finishing.finally(() => {
        if (session.finishing === finishing) session.finishing = null;
      });
    });
  }

  get(id) {
    const session = this.sessions.get(id);
    return session ? this.publicSession(session) : null;
  }

  async waitForClose(closed, timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async stopChild(session) {
    const child = session.child;
    if (!child) return;
    const closed = session.closed || Promise.resolve();
    try { child.kill("SIGTERM"); } catch {}
    const closedGracefully = await this.waitForClose(closed, this.killGraceMs);
    if (!closedGracefully && session.child === child) {
      try { child.kill("SIGKILL"); } catch {}
      await this.waitForClose(closed, 1_000);
    }
  }

  async finalizeSession(session) {
    if (!TERMINAL_LOGIN_STATUSES.has(session.status)) return;
    clearTimeout(session.timeout);
    if (session.isolated && session.status !== "completed" && !session.profileCleaned) {
      try {
        await this.rm(session.home, { recursive: true, force: true });
        session.profileCleaned = true;
        session.cleanupFailures = 0;
      } catch (cleanupError) {
        session.cleanupFailures = (session.cleanupFailures || 0) + 1;
        session.output = sanitizeLoginOutput(`${session.output}\n認証フォルダを削除できなかったため、Connectorが再試行しています。`);
        session.updatedAt = new Date().toISOString();
        try {
          await this.persistPendingCleanup(session.home);
          session.cleanupPersisted = true;
          session.cleanupPersistenceError = null;
        } catch (persistenceError) {
          session.cleanupPersisted = false;
          session.cleanupPersistenceError = new AggregateError([cleanupError, persistenceError], "認証フォルダの削除予定を安全に保存できませんでした。");
        }
        if (!session.pruneTimeout) {
          session.pruneTimeout = setTimeout(() => {
            session.pruneTimeout = null;
            void this.finalizeSession(session);
          }, this.sessionRetentionMs);
          session.pruneTimeout.unref?.();
        }
        return;
      }
    }
    if (session.pruneTimeout) return;
    session.pruneTimeout = setTimeout(() => {
      session.pruneTimeout = null;
      if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
    }, this.sessionRetentionMs);
    session.pruneTimeout.unref?.();
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.shutdownPromise = (async () => {
      await Promise.allSettled([...this.inFlightStarts]);
      const active = [...this.sessions.values()].filter(session => !TERMINAL_LOGIN_STATUSES.has(session.status));
      await Promise.all(active.map(session => this.cancel(session.id)));
      const backgroundTasks = [...this.sessions.values()].flatMap(session =>
        [session.preparation, session.finishing, session.transition].filter(Boolean)
      );
      await Promise.allSettled(backgroundTasks);

      const terminalSessions = [...this.sessions.values()].filter(session => TERMINAL_LOGIN_STATUSES.has(session.status));
      for (const session of terminalSessions) {
        clearTimeout(session.pruneTimeout);
        session.pruneTimeout = null;
        await this.finalizeSession(session);
      }
      const undurableCleanup = terminalSessions.filter(session =>
        session.isolated && session.status !== "completed" && !session.profileCleaned && !session.cleanupPersisted
      );
      if (undurableCleanup.length) {
        throw this.storageError(
          "認証フォルダを削除できず、次回回収予定も保存できませんでした。Connectorは終了せず、profilesフォルダを確認してください。",
          new AggregateError(undurableCleanup.map(session => session.cleanupPersistenceError).filter(Boolean))
        );
      }
      await this.retryPendingCleanup();
    })();
    return this.shutdownPromise;
  }

  async cancel(id) {
    const session = this.sessions.get(id);
    if (!session) return { cancelled: false };
    let cancelled = false;
    const result = await this.withSessionTransition(session, async () => {
      if (TERMINAL_LOGIN_STATUSES.has(session.status)) {
        return { cancelled: session.status === "cancelled" };
      }
      session.status = "cancelled";
      session.output = "認証をキャンセルしました。";
      session.updatedAt = new Date().toISOString();
      clearTimeout(session.timeout);
      cancelled = true;
      return { cancelled: true };
    });
    if (!cancelled) return result;
    await this.stopChild(session);
    await this.finalizeSession(session);
    return result;
  }

  async finish(session, spec, code) {
    if (!this.canContinue(session)) return;
    let authenticated = false;
    let authProfile = null;
    if (code === 0 && session.provider === "claude") {
      try {
        const { stdout } = await this.execFile(session.command, ["auth", "status", "--json"], {
          env: connectorChildEnv(process.env, spec.env),
          maxBuffer: 1_048_576,
          timeout: this.authenticationTimeoutMs,
          killSignal: "SIGKILL"
        });
        const status = JSON.parse(stdout);
        authenticated = status?.loggedIn === true && !/api[_ -]?key/i.test(status?.authMethod || "");
        if (authenticated) {
          authProfile = {
            email: status.email || null,
            plan: status.subscriptionType || null,
            authMethod: status.authMethod || null
          };
        }
      } catch {
        authenticated = false;
      }
    } else if (code === 0) {
      authenticated = await this.withTimeout(
        exists(spec.credentialPath, this.access),
        this.authenticationTimeoutMs,
        "認証情報の確認がタイムアウトしました。"
      ).catch(() => false);
    }

    await this.withSessionTransition(session, async () => {
      if (!this.canContinue(session)) return;
      if (!authenticated) {
        session.status = "failed";
        session.output = sanitizeLoginOutput(`${session.output}\n認証が完了しませんでした。もう一度お試しください。`);
        session.updatedAt = new Date().toISOString();
        return;
      }
      if (spec.isolated) {
        await this.register({ id: session.id, provider: session.provider, home: session.home });
      }
      if (session.provider === "claude" && authProfile) {
        await this.saveProviderMetadata("claude", authProfile);
      }
      session.status = "completed";
      session.output = "認証が完了しました。利用枠を更新しています。";
      session.updatedAt = new Date().toISOString();
    });
  }

  async register(account) {
    return this.withMutation("accounts", async () => {
      const registry = await this.readRegistry();
      const accounts = registry.accounts.filter(item => item.id !== account.id);
      accounts.push({ ...account, createdAt: new Date().toISOString() });
      await this.writeJson(this.registryPath, { ...registry, version: 1, accounts });
    });
  }

  async unregister(id) {
    return this.withMutation("accounts", async () => {
      const registry = await this.readRegistry();
      const accounts = registry.accounts.filter(item => item.id !== id);
      if (accounts.length !== registry.accounts.length) {
        await this.writeJson(this.registryPath, { ...registry, version: 1, accounts });
      }
    });
  }

  async readRegistry() {
    try {
      const parsed = JSON.parse(await this.readFile(this.registryPath, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.accounts)) throw new Error("invalid registry schema");
      const pendingCleanup = parsed.pendingCleanup ?? [];
      if (!Array.isArray(pendingCleanup) || pendingCleanup.some(item => typeof item?.path !== "string" || !item.path)) {
        throw new Error("invalid pending cleanup schema");
      }
      return { version: 1, accounts: parsed.accounts, pendingCleanup };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, accounts: [], pendingCleanup: [] };
      throw this.storageError("接続情報を安全に読み込めません。Connectorを終了し、accounts.jsonを確認してください。", error);
    }
  }

  validatePendingCleanupPath(path, accounts = []) {
    const managedRoot = `${resolve(this.root, "profiles")}${sep}`;
    const target = resolve(path || "");
    if (!target.startsWith(managedRoot)) {
      const error = new Error("管理対象外の認証フォルダは削除できません。");
      error.status = 400;
      throw error;
    }
    if (accounts.some(account => resolve(account.home || "") === target)) {
      throw this.storageError("接続中の認証フォルダは削除できません。accounts.jsonを確認してください。");
    }
    return target;
  }

  async persistPendingCleanup(path) {
    return this.withMutation("accounts", async () => {
      const registry = await this.readRegistry();
      const target = this.validatePendingCleanupPath(path, registry.accounts);
      const pendingCleanup = registry.pendingCleanup.some(item => resolve(item.path) === target)
        ? registry.pendingCleanup
        : [...registry.pendingCleanup, { path: target, createdAt: new Date().toISOString(), reason: "abandoned-oauth-profile" }];
      await this.writeJson(this.registryPath, { version: 1, accounts: registry.accounts, pendingCleanup });
    });
  }

  async retryPendingCleanup() {
    return this.withMutation("accounts", async () => {
      const registry = await this.readRegistry();
      if (!registry.pendingCleanup.length) return { remaining: 0 };
      const pendingCleanup = [];
      for (const item of registry.pendingCleanup) {
        const target = this.validatePendingCleanupPath(item.path, registry.accounts);
        try {
          await this.rm(target, { recursive: true, force: true });
        } catch {
          pendingCleanup.push({ ...item, path: target });
        }
      }
      await this.writeJson(this.registryPath, { version: 1, accounts: registry.accounts, pendingCleanup });
      return { remaining: pendingCleanup.length };
    });
  }

  async readProviderMetadata() {
    try {
      const parsed = JSON.parse(await this.readFile(this.providerMetadataPath, "utf8"));
      if (parsed?.version !== 1 || !parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)) {
        throw new Error("invalid provider metadata schema");
      }
      return { version: 1, providers: parsed.providers };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, providers: {} };
      throw this.storageError("認証メタデータを安全に読み込めません。Connectorを終了し、provider-metadata.jsonを確認してください。", error);
    }
  }

  async saveProviderMetadata(provider, profile) {
    return this.withMutation("provider-metadata", async () => {
      const metadata = await this.readProviderMetadata();
      metadata.providers[provider] = {
        email: profile.email || null,
        plan: profile.plan || null,
        authMethod: profile.authMethod || null,
        updatedAt: new Date().toISOString()
      };
      await this.writeJson(this.providerMetadataPath, metadata);
    });
  }

  async disconnect(connectionIds) {
    const ids = new Set((Array.isArray(connectionIds) ? connectionIds : []).filter(id => typeof id === "string" && id));
    if (!ids.size) return { removed: 0 };
    return this.withMutation("accounts", async () => {
      const registry = await this.readRegistry();
      const selected = registry.accounts.filter(account => ids.has(account.id));
      const managedRoot = `${resolve(this.root, "profiles")}${sep}`;
      const validateManagedPath = (path, pending = false) => {
        const target = resolve(path || "");
        const referencesRegisteredAccount = registry.accounts.some(account => resolve(account.home || "") === target);
        if (!target.startsWith(managedRoot) || (pending && referencesRegisteredAccount)) {
          const error = new Error("管理対象外の接続は解除できません。");
          error.status = 400;
          throw error;
        }
        return target;
      };
      selected.forEach(account => validateManagedPath(account.home));
      const previousPending = registry.pendingCleanup.map(item => ({ ...item, path: validateManagedPath(item.path, true) }));
      const staged = [];
      try {
        for (const account of selected) {
          const target = validateManagedPath(account.home);
          const tombstone = `${target}.capacity-atlas-disconnect-${randomUUID()}`;
          try {
            await this.rename(target, tombstone);
            staged.push({ path: tombstone, createdAt: new Date().toISOString() });
          } catch (error) {
            if (error?.code !== "ENOENT") throw error;
          }
        }
        const accounts = registry.accounts.filter(account => !ids.has(account.id));
        await this.writeJson(this.registryPath, {
          version: 1,
          accounts,
          pendingCleanup: [...previousPending, ...staged]
        });
      } catch (error) {
        const rollbackErrors = [];
        for (const item of [...staged].reverse()) {
          const original = item.path.replace(/\.capacity-atlas-disconnect-[^.]+$/, "");
          try { await this.rename(item.path, original); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
        }
        if (rollbackErrors.length) {
          throw this.storageError("接続解除に失敗し、認証フォルダを元に戻せませんでした。Connectorを終了してprofilesフォルダを確認してください。", new AggregateError([error, ...rollbackErrors]));
        }
        throw error;
      }

      const pendingCleanup = [];
      for (const item of [...previousPending, ...staged]) {
        try {
          await this.rm(item.path, { recursive: true, force: true });
        } catch {
          pendingCleanup.push(item);
        }
      }
      const accounts = registry.accounts.filter(account => !ids.has(account.id));
      await this.writeJson(this.registryPath, { version: 1, accounts, pendingCleanup });
      return pendingCleanup.length
        ? { removed: selected.length, cleanupPending: pendingCleanup.length }
        : { removed: selected.length };
    });
  }

  storageError(message, cause) {
    const error = new Error(message, { cause });
    error.code = "CAPACITY_ATLAS_STORAGE_INVALID";
    return error;
  }

  async writeJson(path, value) {
    await this.mkdir(this.root, { recursive: true, mode: 0o700 });
    const serialized = JSON.stringify(value, null, 2);
    if (!this.atomicWrites) {
      await this.writeFile(path, serialized, { mode: 0o600 });
      return;
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await this.writeFile(temporary, serialized, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async withMutation(name, operation) {
    const previous = this.mutationQueues.get(name) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.withFileLock(name, operation));
    this.mutationQueues.set(name, current);
    try {
      return await current;
    } finally {
      if (this.mutationQueues.get(name) === current) this.mutationQueues.delete(name);
    }
  }

  async withFileLock(name, operation) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const lockPath = join(this.root, `.${name}.lock`);
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        await mkdir(lockPath, { mode: 0o700 });
        try {
          await writeFile(join(lockPath, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600 });
        } catch (error) {
          await rm(lockPath, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        let owner = null;
        try {
          owner = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
        } catch (ownerError) {
          if (ownerError?.code !== "ENOENT" && !(ownerError instanceof SyntaxError)) throw ownerError;
        }
        if (Number.isInteger(owner?.pid)) {
          if (!processIsAlive(owner.pid)) await rm(lockPath, { recursive: true, force: true });
        } else {
          try {
            const lockStat = await stat(lockPath);
            if (Date.now() - lockStat.mtimeMs > 300_000) await rm(lockPath, { recursive: true, force: true });
          } catch (statError) {
            if (statError?.code !== "ENOENT") throw statError;
          }
        }
        if (Date.now() >= deadline) throw new Error("接続情報の更新が競合しています。Connectorを1つだけ起動して、もう一度お試しください。");
        await delay(25);
      }
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  async homes() {
    await this.retryPendingCleanup();
    const registry = await this.readRegistry();
    const metadata = await this.readProviderMetadata();
    const home = homedir();
    const claudeMetadata = metadata.providers.claude || null;
    const result = {
      codex: [{ home: join(home, ".codex"), managed: false, connectionId: null }],
      claude: [{
        home: join(home, ".claude"),
        managed: false,
        connectionId: null,
        ...(claudeMetadata?.email ? { email: claudeMetadata.email } : {}),
        ...(claudeMetadata?.plan ? { plan: claudeMetadata.plan } : {})
      }],
      grok: [{ home: join(home, ".grok"), managed: false, connectionId: null }]
    };
    for (const account of registry.accounts) {
      if (result[account.provider] && account.home) {
        result[account.provider].push({ home: account.home, managed: true, connectionId: account.id });
      }
    }
    return Object.fromEntries(Object.entries(result).map(([provider, homes]) => {
      const seen = new Set();
      return [provider, homes.filter(entry => {
        if (seen.has(entry.home)) return false;
        seen.add(entry.home);
        return true;
      })];
    }));
  }

  publicSession(session) {
    return {
      id: session.id,
      provider: session.provider,
      status: session.status,
      output: sanitizeLoginOutput(session.output),
      startedAt: session.startedAt,
      updatedAt: session.updatedAt
    };
  }
}
