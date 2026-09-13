import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverTriggers, normalizeConfig } from "../runtime.mjs";

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
