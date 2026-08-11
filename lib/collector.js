import { execFile } from "node:child_process";
import { promisify } from "node:util";
function connectorChildEnv(base = process.env, overrides = {}) {
  const environment = { ...base, ...overrides };
  delete environment.CAPACITY_ATLAS_TOKEN;
  delete environment.CAPACITY_ATLAS_RUNTIME_PATH;
  return environment;
}
import { extractJsonPayload, normalizeProviderPayload } from "./normalize.js";

const execFileAsync = promisify(execFile);

export function buildCodexBarArgs(provider) {
  if (provider === "grok") return buildSingleAccountArgs(provider);
  return ["usage", "--provider", provider, "--all-accounts", "--json"];
}

export function buildSingleAccountArgs(provider) {
  return ["usage", "--provider", provider, "--json"];
}

export function outputFromCommandFailure(error) {
  const stdout = typeof error?.stdout === "string" ? error.stdout : error?.stdout?.toString?.();
  if (stdout?.trim()) return stdout;
  throw error;
}

export async function defaultRunner(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      timeout: 45_000,
      maxBuffer: 4 * 1024 * 1024,
      env: connectorChildEnv()
    });
    return stdout;
  } catch (error) {
    return outputFromCommandFailure(error);
  }
}

export async function collectProvider(provider, runner = defaultRunner) {
  try {
    const output = await runner("codexbar", buildCodexBarArgs(provider));
    let payload = extractJsonPayload(output);
    const message = payload[0]?.error?.message || "";
    if (/token accounts|all.accounts/i.test(message)) {
      const singleOutput = await runner("codexbar", buildSingleAccountArgs(provider));
      payload = extractJsonPayload(singleOutput);
    }
    return normalizeProviderPayload(provider, payload);
  } catch (error) {
    return normalizeProviderPayload(provider, [{
      provider,
      error: { message: error.message || String(error) }
    }]);
  }
}

export async function collectProviders(providers = ["codex", "claude", "grok"], runner = defaultRunner) {
  const collectedAt = new Date().toISOString();
  const groups = await Promise.all(providers.map(provider => collectProvider(provider, runner)));
  return {
    collectedAt,
    providers,
    accounts: groups.flat()
  };
}
