import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";

const DEFAULT_PROJECT_DIRS = [".pi/triggers", "scripts/pi-agent-triggers"];

export function expandHome(value) {
  return value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

export function normalizeConfig(value = {}) {
  const configured = value && typeof value === "object" ? value : {};
  const execution = configured.execution ?? "sandbox";
  if (execution !== "host" && execution !== "sandbox") throw new Error("piAgentTriggers.execution must be \"host\" or \"sandbox\"");
  const projectDirs = Array.isArray(configured.projectDirs) && configured.projectDirs.every((item) => typeof item === "string")
    ? configured.projectDirs : DEFAULT_PROJECT_DIRS;
  const sandboxCommand = Array.isArray(configured.sandboxCommand) && configured.sandboxCommand.every((item) => typeof item === "string")
    ? configured.sandboxCommand : ["pi-sandbox", "exec", "--"];
  if (sandboxCommand.length === 0 || !sandboxCommand[0]) throw new Error("piAgentTriggers.sandboxCommand must not be empty");
  return {
    execution,
    globalDir: expandHome(typeof configured.globalDir === "string" ? configured.globalDir : "~/.pi/agent/triggers"),
    projectDirs,
    sandboxCommand,
  };
}

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return {}; }
}

export async function loadConfig({ cwd, settingsPath = join(homedir(), ".pi/agent/settings.json") }) {
  const projectRoot = await findProjectRoot(cwd);
  const globalSettings = await readJson(settingsPath);
  const projectSettings = await readJson(join(projectRoot, ".pi/settings.json"));
  return { ...(globalSettings.piAgentTriggers ?? {}), ...(projectSettings.piAgentTriggers ?? {}) };
}

async function isExecutable(path) {
  try { await access(path, constants.R_OK | constants.X_OK); return true; } catch { return false; }
}

export async function findProjectRoot(cwd) {
  let current = resolve(cwd);
  while (true) {
    try { await access(join(current, ".git")); return current; } catch {}
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

async function triggerFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return (await Promise.all(entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (!entry.isFile() || entry.name.startsWith(".") || !(await isExecutable(path))) return null;
      return { name: entry.name, path };
    }))).filter(Boolean);
  } catch { return []; }
}

export async function discoverTriggers({ cwd, explicitPath, config = {} }) {
  const normalized = normalizeConfig(config);
  const projectRoot = await findProjectRoot(cwd);
  const result = new Map();
  if (explicitPath) {
    const path = resolve(cwd, expandHome(explicitPath));
    if (!(await isExecutable(path))) throw new Error(`Trigger is not executable: ${path}`);
    result.set(relative(projectRoot, path) || path, { name: relative(projectRoot, path) || path, path, source: "explicit", project: false });
    return [...result.values()];
  }
  for (const dir of normalized.projectDirs) {
    if (isAbsolute(dir)) continue;
    for (const trigger of await triggerFiles(resolve(projectRoot, dir))) {
      if (!result.has(trigger.name)) result.set(trigger.name, { ...trigger, source: "project", project: true });
    }
  }
  for (const trigger of await triggerFiles(normalized.globalDir)) {
    if (!result.has(trigger.name)) result.set(trigger.name, { ...trigger, source: "global", project: false });
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export class HostBackend {
  spawn(command, args, options) { return spawn(command, args, options); }
}

export class SandboxBackend {
  constructor(command) { this.command = command; }
  spawn(command, args, options) {
    const [runner, ...prefix] = this.command;
    return spawn(runner, [...prefix, command, ...args], options);
  }
}

export function createRuntime({ sendEvent, notify = () => {}, backendFactory = (mode, config) => mode === "host" ? new HostBackend() : new SandboxBackend(config.sandboxCommand) } = {}) {
  const running = new Map();
  const start = async ({ watcher, args = [], cwd, config = {}, explicitPath, allowProjectHost = false }) => {
    const normalized = normalizeConfig(config);
    const requestedPath = explicitPath ?? (watcher.includes("/") ? watcher : undefined);
    const found = (await discoverTriggers({ cwd, explicitPath: requestedPath, config: normalized }))
      .find((item) => item.name === watcher || item.path === resolve(cwd, expandHome(watcher)));
    if (!found) throw new Error(`Trigger not found: ${watcher}`);
    if (found.project && normalized.execution === "host" && !allowProjectHost)
      throw new Error("Project-local trigger requires trusted project confirmation before host execution");
    if (running.has(found.name)) throw new Error(`Trigger already running: ${found.name}`);
    const child = backendFactory(normalized.execution, normalized).spawn(found.path, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    const record = { name: found.name, path: found.path, source: found.source, execution: normalized.execution, child };
    running.set(found.name, record);
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("event must be an object");
          sendEvent?.({ watcher: found.name, event });
        } catch (error) { notify(`Trigger ${found.name}: invalid stdout event (${error.message})`, "warning"); }
      }
    });
    child.stderr.on("data", (chunk) => notify(`Trigger ${found.name}: ${chunk.toString().trim()}`, "warning"));
    child.once("close", (code, signal) => { if (running.get(found.name)?.child === child) running.delete(found.name); notify(`Trigger ${found.name} exited (${signal ?? code ?? "unknown"})`, code === 0 ? "info" : "warning"); });
    child.once("error", (error) => notify(`Trigger ${found.name} failed: ${error.message}`, "error"));
    return { ...record, child: undefined };
  };
  return {
    start,
    stop(name) { const record = running.get(name); if (!record) return false; record.child.kill("SIGTERM"); return true; },
    list() { return [...running.values()].map(({ child, ...record }) => record); },
  };
}
