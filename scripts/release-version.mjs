import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePath = resolve(root, "package.json");
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isStableVersion(value) {
  return typeof value === "string" && stableVersion.test(value) &&
    value.split(".").every((part) => Number.isSafeInteger(Number(part)));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }

  return 0;
}

function git(args, description) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });

  if (result.error || result.status !== 0) {
    const details = result.stderr.trim() || result.error?.message || "unknown git error";
    fail(`${description}: ${details}`);
  }

  return result.stdout.trim();
}

const [nextVersion, ...extraArguments] = process.argv.slice(2);

if (extraArguments.length > 0 || !isStableVersion(nextVersion)) {
  fail("Usage: pnpm release:version <X.Y.Z> (stable semantic version only)");
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
const currentVersion = packageJson.version;

if (!isStableVersion(currentVersion)) {
  fail(`package.json has an invalid stable version: ${String(currentVersion)}`);
}

if (compareVersions(nextVersion, currentVersion) <= 0) {
  fail(`Release version must be greater than ${currentVersion}.`);
}

git(["rev-parse", "--is-inside-work-tree"], "This command must run inside a Git worktree");
if (git(["branch", "--show-current"], "Unable to inspect the release branch") !== "main") {
  fail("Release versions must be created on main.");
}

if (git(["status", "--porcelain"], "Unable to inspect the working tree")) {
  fail("Refusing to release from a dirty working tree.");
}

git(["config", "--get", "user.name"], "Configure git user.name before creating a release commit");
git(["config", "--get", "user.email"], "Configure git user.email before creating a release commit");

const tagName = `v${nextVersion}`;
const tagExists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${tagName}`], {
  cwd: root,
  stdio: "ignore",
}).status === 0;

if (tagExists) {
  fail(`Tag ${tagName} already exists; package.json and tag versions must remain one-to-one.`);
}

packageJson.version = nextVersion;
await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

git(["add", "--", "package.json"], "Unable to stage package.json");
git(["commit", "-m", `chore(release): ${tagName}`], "Unable to create the release commit");
git(["tag", "-a", tagName, "-m", `Release ${tagName}`], "Unable to create the annotated release tag");

console.log(`Created local release commit and annotated tag ${tagName}.`);
console.log("Review it, then publish it explicitly with: git push origin main --follow-tags");
