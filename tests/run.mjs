import { build } from "esbuild";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "periodic-notes-tests-"));
try {
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["tests/regressions.test.mjs"],
    bundle: true,
    platform: "node",
    format: "cjs",
    write: false,
    plugins: [{
      name: "obsidian-test-host",
      setup(builder) {
        builder.onResolve({ filter: /^obsidian$/ }, () => ({ path: path.join(root, "tests/obsidian-mock.mjs") }));
        builder.onResolve({ filter: /\.svelte$/ }, () => ({ path: path.join(root, "tests/component-mock.mjs") }));
      },
    }],
  });
  const entry = path.join(temporary, "regressions.test.cjs");
  writeFileSync(entry, result.outputFiles[0].contents);
  const test = spawnSync(process.execPath, ["--test", entry], { stdio: "inherit" });
  process.exitCode = test.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
