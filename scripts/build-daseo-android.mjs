import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = path.join(root, "packages/app");
const require = createRequire(import.meta.url);
const { getNativeReleaseVersion } = require("../packages/app/native-release-version.js");
const CERTIFICATE = "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c";
export function assertAndroidIdentity(config, native, version, commit) {
  const expected = getNativeReleaseVersion(version);
  if (
    config.name !== "Daseo" ||
    config.android?.package !== "sh.paseo.dgk" ||
    config.extra?.directFcmPush !== true ||
    config.version !== expected.appVersion ||
    config.android.versionCode !== expected.androidVersionCode ||
    config.extra.daseoSourceCommit !== commit ||
    !/^[a-f0-9]{40}$/.test(commit) ||
    !native.includes(
      `package: name='sh.paseo.dgk' versionCode='${expected.androidVersionCode}' versionName='${expected.appVersion}'`,
    )
  ) {
    throw new Error(
      "Daseo APK native/embedded identity, version, source commit or direct FCM contract mismatch",
    );
  }
}
export function buildAndroid() {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  if (git("status", "--porcelain"))
    throw new Error("Build from a committed checkout; do not include concurrent changes");
  const commit = git("rev-parse", "HEAD");
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (!existsSync(path.join(app, ".secrets/google-services.personal.json")))
    throw new Error("Personal Firebase config is missing");
  const java =
    process.env.JAVA_HOME ||
    execFileSync("/usr/libexec/java_home", ["-v", "17"], { encoding: "utf8" }).trim();
  const sdk = process.env.ANDROID_HOME || "/opt/homebrew/share/android-commandlinetools";
  const env = {
    ...process.env,
    APP_VARIANT: "personal",
    DASEO_SOURCE_COMMIT: commit,
    JAVA_HOME: java,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
  };
  execFileSync("npx", ["expo", "prebuild", "--platform", "android", "--clean"], {
    cwd: app,
    env,
    stdio: "inherit",
  });
  execFileSync("./gradlew", ["assembleRelease", "-PreactNativeArchitectures=arm64-v8a"], {
    cwd: path.join(app, "android"),
    env,
    stdio: "inherit",
  });
  const apk = path.join(app, "android/app/build/outputs/apk/release/app-release.apk");
  const tools = readdirSync(path.join(sdk, "build-tools"))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  if (!tools) throw new Error("Android build tools missing");
  const tool = (name) => path.join(sdk, "build-tools", tools, name);
  const config = JSON.parse(
    execFileSync("unzip", ["-p", apk, "assets/app.config"], { encoding: "utf8" }),
  );
  const native = execFileSync(tool("aapt"), ["dump", "badging", apk], { encoding: "utf8", env });
  assertAndroidIdentity(config, native, version, commit);
  const signature = execFileSync(tool("apksigner"), ["verify", "--print-certs", apk], {
    encoding: "utf8",
    env,
  });
  if (!signature.includes(`certificate SHA-256 digest: ${CERTIFICATE}`))
    throw new Error("APK signer differs from installed Daseo identity");
  if (git("rev-parse", "HEAD") !== commit || git("status", "--porcelain"))
    throw new Error("Checkout changed during build; artifact is not releasable");
  console.log(
    JSON.stringify({
      apk,
      version,
      sourceCommit: commit,
      nativeAndEmbeddedIdentity: "verified",
      directFcmPush: true,
      signature: "verified",
    }),
  );
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  buildAndroid();
