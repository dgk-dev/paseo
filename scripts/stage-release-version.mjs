import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
const stable = (v) =>
  JSON.stringify(v, function (_key, value) {
    return value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value;
  });
export function expectedVersionManifest(before, version) {
  const next = structuredClone(before);
  next.version = version;
  for (const section of sections)
    for (const name of Object.keys(next[section] ?? {})) {
      if (name.startsWith("@getpaseo/") && name !== next.name)
        next[section][name] = next.private ? "*" : version;
    }
  return next;
}
export function assertVersionOnly(before, after, version) {
  if (stable(expectedVersionManifest(before, version)) !== stable(after))
    throw new Error("Release contains non-version manifest changes; commit them separately first");
}
export function stageReleaseVersion() {
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    }).trim();
  const head = git("rev-parse", "HEAD");
  if (!process.env.DASEO_RELEASE_BASE)
    throw new Error(
      "Use npm run version:all:patch (or another version:all script), not bare npm version",
    );
  if (process.env.DASEO_RELEASE_BASE !== head)
    throw new Error("HEAD changed during release preparation");
  const before = (file) => JSON.parse(git("show", `${head}:${file}`));
  const after = (file) => JSON.parse(readFileSync(path.join(root, file), "utf8"));
  const manifest = after("package.json");
  const files = [
    "package.json",
    ...manifest.workspaces.map((workspace) => `${workspace}/package.json`),
    "package-lock.json",
  ];
  const allowed = new Set(files);
  const staged = git("diff", "--cached", "--name-only", "-z").split("\0").filter(Boolean);
  if (staged.some((file) => !allowed.has(file)))
    throw new Error("Foreign staged files present; release did not stage or commit anything");
  for (const file of files.filter((candidate) => candidate !== "package-lock.json"))
    assertVersionOnly(before(file), after(file), manifest.version);
  const lock = before("package-lock.json");
  lock.version = manifest.version;
  for (const workspace of ["", ...manifest.workspaces]) {
    const pkg = after(workspace ? `${workspace}/package.json` : "package.json");
    const entry = lock.packages[workspace];
    if (!entry) throw new Error(`Missing lock workspace: ${workspace}`);
    entry.version = manifest.version;
    for (const section of sections)
      for (const name of Object.keys(entry[section] ?? {})) {
        if (name.startsWith("@getpaseo/") && name !== pkg.name)
          entry[section][name] = pkg[section]?.[name];
      }
  }
  if (stable(lock) !== stable(after("package-lock.json")))
    throw new Error("Lockfile changed beyond release versions; inspect before shipping");
  if (git("rev-parse", "HEAD") !== head) throw new Error("HEAD changed before release staging");
  git("add", "--", ...files);
  git("commit", "--only", "-m", `chore(release): cut ${manifest.version}`, "--", ...files);
  git("tag", `v${manifest.version}`, git("rev-parse", "HEAD"));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  stageReleaseVersion();
