import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertAndroidIdentity } from "./build-daseo-android.mjs";
import { assertVersionOnly, expectedVersionManifest } from "./stage-release-version.mjs";
import { syncSkills } from "../packages/desktop/src/integrations/skills/sync.ts";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("rejects the previously shipped native-personal / embedded-production APK combination", () => {
  const commit = "a1".repeat(20);
  const native = "package: name='sh.paseo.dgk' versionCode='5024' versionName='0.5.24'";
  const config = {
    name: "Daseo",
    version: "0.5.24",
    android: { package: "sh.paseo.dgk", versionCode: 5024 },
    extra: { directFcmPush: true, daseoSourceCommit: commit },
  };
  assert.doesNotThrow(() => assertAndroidIdentity(config, native, "0.5.24", commit));
  assert.throws(() =>
    assertAndroidIdentity(
      { ...config, extra: { ...config.extra, directFcmPush: false } },
      native,
      "0.5.24",
      commit,
    ),
  );
  assert.throws(() =>
    assertAndroidIdentity({ ...config, name: "Paseo" }, native, "0.5.24", commit),
  );
  assert.throws(() => assertAndroidIdentity(config, native, "0.5.24", "b2".repeat(20)));
});
test("version staging rejects unrelated manifest edits", () => {
  const before = {
    name: "@getpaseo/test",
    version: "0.5.23",
    dependencies: { "@getpaseo/client": "0.5.23", external: "1.0.0" },
  };
  const next = expectedVersionManifest(before, "0.5.24");
  assert.doesNotThrow(() => assertVersionOnly(before, next, "0.5.24"));
  assert.throws(() =>
    assertVersionOnly(before, { ...next, scripts: { other: "unrelated" } }, "0.5.24"),
  );
});
test("bundled manual-only skills survive two real installation syncs", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "daseo-skill-policy-"));
  const options = {
    sourceDir: path.join(root, "skills"),
    agentsDir: path.join(home, "agents"),
    claudeDir: path.join(home, "claude"),
    codexDir: path.join(home, "codex"),
    skillNames: ["paseo-advisor", "paseo-committee", "paseo-handoff"],
  };
  try {
    await syncSkills(options);
    const installed = path.join(options.agentsDir, "paseo-advisor", "SKILL.md");
    await writeFile(
      installed,
      (await readFile(installed, "utf8")).replace(
        "disable-model-invocation: true",
        "disable-model-invocation: false",
      ),
    );
    await syncSkills(options);
    for (const dir of [options.agentsDir, options.claudeDir, options.codexDir])
      for (const skill of options.skillNames) {
        assert.match(
          await readFile(path.join(dir, skill, "SKILL.md"), "utf8"),
          /^disable-model-invocation: true$/m,
        );
      }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
