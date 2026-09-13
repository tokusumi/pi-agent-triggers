import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { createRuntime, discoverTriggers, loadConfig, normalizeConfig } from "./runtime.mjs";

type Params = { trigger: string; args?: string[]; path?: string };
type Context = { cwd: string; ui: { notify(message: string, level?: "info" | "warning" | "error"): void; confirm(title: string, message: string): Promise<boolean> }; settings?: Record<string, unknown>; hasUI?: boolean };

const result = (text: string, details: unknown = {}) => ({ content: [{ type: "text", text }], details });

export default function piAgentTriggers(pi: ExtensionAPI) {
  let context: Context | undefined;
  let config: Record<string, unknown> = {};
  const runtime = createRuntime({
    sendEvent: ({ watcher, event }) => pi.sendMessage({ customType: "pi-agent-triggers", content: `[${watcher}] ${JSON.stringify(event)}`, display: true, details: { watcher, event } }, { triggerTurn: true, deliverAs: "followUp" }),
    notify: (message, level) => context?.ui.notify(message, level),
  });
  const getConfig = () => normalizeConfig(config);
  const start = async (params: Params, ctx: Context) => {
    context = ctx;
    const candidates = await discoverTriggers({ cwd: ctx.cwd, explicitPath: params.path, config: getConfig() });
    const found = params.path ? candidates[0] : candidates.find((item) => item.name === params.trigger);
    if (!found) throw new Error(`Trigger not found: ${params.trigger}`);
    const allowProjectHost = found.project && getConfig().execution === "host" ? Boolean(ctx.hasUI && await ctx.ui.confirm("Run project trigger on host?", `This executes ${found.path} with host permissions.`)) : false;
    return runtime.start({ watcher: params.trigger, args: params.args ?? [], explicitPath: params.path, cwd: ctx.cwd, config: getConfig(), allowProjectHost });
  };
  pi.registerTool({ name: "trigger_start", label: "Start trigger", description: "Start a named trigger script discovered from project or global trigger directories.", parameters: Type.Object({ trigger: Type.String(), args: Type.Optional(Type.Array(Type.String())), path: Type.Optional(Type.String()) }), async execute(_id, params, _signal, _update, ctx) { try { const started = await start(params as Params, ctx as unknown as Context); return result(`Started ${started.name} (${started.execution})`, started); } catch (error) { return result(error instanceof Error ? error.message : String(error)); } } });
  pi.registerTool({ name: "trigger_list", label: "List triggers", description: "List running agent triggers.", parameters: Type.Object({}), async execute() { const items = runtime.list(); return result(items.length ? items.map((item) => `${item.name} (${item.execution}, ${item.source})`).join("\n") : "No triggers running", items); } });
  pi.registerTool({ name: "trigger_stop", label: "Stop trigger", description: "Stop a running agent trigger by name.", parameters: Type.Object({ trigger: Type.String() }), async execute(_id, params) { return result(runtime.stop(params.trigger) ? `Stopped ${params.trigger}` : `Trigger is not running: ${params.trigger}`); } });
  pi.registerCommand("trigger", { description: "Start a named agent trigger", handler: async (args, ctx) => { const trigger = args.trim(); if (!trigger) return ctx.ui.notify("Usage: /trigger <name>", "warning"); try { const started = await start({ trigger }, ctx as unknown as Context); ctx.ui.notify(`Started ${started.name}`, "info"); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), "error"); } } });
  pi.registerCommand("triggers", { description: "List running agent triggers", handler: async (_args, ctx) => ctx.ui.notify(runtime.list().map((item) => `${item.name} (${item.execution})`).join("\n") || "No triggers running", "info") });
  pi.registerCommand("trigger-stop", { description: "Stop an agent trigger", handler: async (args, ctx) => ctx.ui.notify(runtime.stop(args.trim()) ? `Stopped ${args.trim()}` : `Trigger is not running: ${args.trim()}`, "info") });
  pi.registerCommand("trigger-which", { description: "Show a trigger's source", handler: async (args, ctx) => { const item = (await discoverTriggers({ cwd: ctx.cwd, config: getConfig() })).find((candidate) => candidate.name === args.trim()); ctx.ui.notify(item ? `${item.name}\nsource: ${item.path}\nexecution: ${getConfig().execution}` : `Trigger not found: ${args.trim()}`, item ? "info" : "error"); } });
  pi.on("session_start", async (_event, ctx) => { context = ctx as unknown as Context; config = await loadConfig({ cwd: ctx.cwd }); });
  pi.on("session_shutdown", () => { for (const item of runtime.list()) runtime.stop(item.name); });
}
