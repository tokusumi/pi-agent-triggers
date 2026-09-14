import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, discoverTriggers, normalizeConfig } from "../runtime.mjs";

test("project trigger overrides global trigger by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-triggers-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".pi/triggers"), { recursive: true });
  await mkdir(join(root, "global"));
  for (const path of [join(root, ".pi/triggers/check.sh"), join(root, "global/check.sh"), join(root, "global/only.sh")]) {
    await writeFile(path, "#!/bin/sh\n");
    await chmod(path, 0o755);
  }
  const found = await discoverTriggers({ cwd: root, config: { globalDir: join(root, "global") } });
  assert.deepEqual(found.map((item) => item.name), ["check.sh", "only.sh"]);
  assert.equal(found.find((item) => item.name === "check.sh").source, "project");
});

test("invalid execution settings are rejected", () => assert.throws(() => normalizeConfig({ execution: "root" }), /execution/));

test("a trigger process emits a JSON event", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-triggers-runtime-"));
  await mkdir(join(root, ".git"));
  await mkdir(join(root, ".pi/triggers"), { recursive: true });
  const script = join(root, ".pi/triggers/ready.sh");
  await writeFile(script, "#!/bin/sh\nprintf '{\"type\":\"ready\"}\\n'\nsleep 10\n");
  await chmod(script, 0o755);

  const events = [];
  const runtime = createRuntime({ sendEvent: (event) => events.push(event) });
  await runtime.start({ watcher: "ready.sh", cwd: root, config: { execution: "host" }, allowProjectHost: true });
  for (let attempt = 0; attempt < 20 && events.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(events, [{ watcher: "ready.sh", event: { type: "ready" } }]);
  assert.equal(runtime.stop("ready.sh"), true);
});
