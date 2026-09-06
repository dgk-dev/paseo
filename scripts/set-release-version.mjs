import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeNextReleaseVersion } from "./release-version-utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const rootPackagePath = path.join(rootDir, "package.json");

function usageAndExit(code = 1) {
  process.stderr.write(`Usage: node scripts/set-release-version.mjs --mode <mode> [--print]\n`);
  process.stderr.write(
    "Modes: patch, minor, major, beta-patch, beta-minor, beta-major, beta-next, promote\n",
  );
  process.exit(code);
}

function parseArgs(argv) {
  const args = {
    mode: "",
    print: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") {
      args.mode = argv[index + 1] ?? "";
      index += 1;
      continue;
    }
    if (arg === "--print") {
      args.print = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usageAndExit(0);
    }
    usageAndExit();
  }

  if (!args.mode) {
    usageAndExit();
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
const currentVersion = typeof rootPackage.version === "string" ? rootPackage.version.trim() : "";

if (!currentVersion) {
  throw new Error('Root package.json must contain a valid "version".');
}

const nextVersion = computeNextReleaseVersion(currentVersion, args.mode);

if (args.print) {
  process.stdout.write(`${nextVersion}\n`);
  process.exit(0);
}

const gitRead = (...gitArgs) =>
  execFileSync("git", ["-C", rootDir, ...gitArgs], { encoding: "utf8" }).trim();
if (gitRead("branch", "--show-current") !== "main")
  throw new Error("Release requires the existing main checkout");
if (gitRead("status", "--porcelain"))
  throw new Error(
    "Commit task-owned changes before cutting a release; preserve other sessions' work",
  );
if (gitRead("tag", "--list", `v${nextVersion}`))
  throw new Error(`Release tag already exists: v${nextVersion}`);

execFileSync(
  "npm",
  ["version", nextVersion, "--include-workspace-root", "--git-tag-version=false"],
  {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      DASEO_RELEASE_BASE: execFileSync("git", ["-C", rootDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    },
  },
);
