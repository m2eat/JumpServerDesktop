import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

const [directoryArgument, version, ...extraArguments] = process.argv.slice(2);

if (
  extraArguments.length > 0 ||
  !directoryArgument ||
  !version ||
  !stableVersion.test(version)
) {
  fail("Usage: node scripts/prepare-release.mjs <artifact-directory> <X.Y.Z>");
}

const packageJson = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
if (packageJson.version !== version) {
  fail(`Package version ${packageJson.version} does not match release version ${version}.`);
}

const tagName = `v${version}`;
if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== tagName) {
  fail(`GitHub tag ${process.env.GITHUB_REF_NAME} does not match package version ${version}.`);
}

const releaseDirectory = resolve(root, directoryArgument);
const entries = await readdir(releaseDirectory, { withFileTypes: true });
const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
if (directories.length > 0) {
  fail(`Release artifact directory must be flat; found directories: ${directories.join(", ")}`);
}

const files = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
const packageName = packageJson.name;
if (typeof packageName !== "string" || !/^[a-z0-9-]+$/.test(packageName)) {
  fail("package.json name must be a safe artifact filename prefix.");
}

const prefix = `${packageName}-${version}`;
const requiredArtifacts = [
  ["Windows x64 NSIS installer", `${prefix}-win-x64.exe`],
  ["Windows x64 blockmap", `${prefix}-win-x64.exe.blockmap`],
  ["Linux x64 AppImage", `${prefix}-linux-x86_64.AppImage`],
  ["Linux x64 Debian package", `${prefix}-linux-amd64.deb`],
  ["macOS x64 disk image", `${prefix}-mac-x64.dmg`],
  ["macOS x64 update archive", `${prefix}-mac-x64.zip`],
  ["macOS x64 update archive blockmap", `${prefix}-mac-x64.zip.blockmap`],
  ["macOS arm64 disk image", `${prefix}-mac-arm64.dmg`],
  ["macOS arm64 update archive", `${prefix}-mac-arm64.zip`],
  ["macOS arm64 update archive blockmap", `${prefix}-mac-arm64.zip.blockmap`],
  ["Windows update metadata", "latest.yml"],
  ["Linux update metadata", "latest-linux.yml"],
  ["macOS update metadata", "latest-mac.yml"],
];

const missing = requiredArtifacts
  .filter(([, fileName]) => !files.has(fileName))
  .map(([description, fileName]) => `${description} (${fileName})`);
if (missing.length > 0) {
  fail(`Missing required release artifacts:\n${missing.map((item) => `- ${item}`).join("\n")}`);
}

for (const [, fileName] of requiredArtifacts) {
  const artifactStat = await stat(resolve(releaseDirectory, fileName));
  if (artifactStat.size === 0) {
    fail(`Release artifact is empty: ${fileName}`);
  }
}

const metadataRequirements = [
  ["latest.yml", [`${prefix}-win-x64.exe`]],
  ["latest-linux.yml", [`${prefix}-linux-x86_64.AppImage`]],
  ["latest-mac.yml", [`${prefix}-mac-x64.zip`, `${prefix}-mac-arm64.zip`]],
];

for (const [metadataName, referencedArtifacts] of metadataRequirements) {
  const metadata = await readFile(resolve(releaseDirectory, metadataName), "utf8");
  const versionPattern = new RegExp(`^version:\\s*["']?${escapeRegExp(version)}["']?\\s*$`, "m");
  if (!versionPattern.test(metadata)) {
    fail(`${metadataName} does not declare version ${version}.`);
  }

  for (const artifactName of referencedArtifacts) {
    if (!metadata.includes(artifactName)) {
      fail(`${metadataName} does not reference ${artifactName}.`);
    }
  }
  if (metadataName === "latest-linux.yml" && !/blockMapSize:\s*[1-9]\d*/.test(metadata)) {
    fail("latest-linux.yml must describe the AppImage embedded blockmap.");
  }
}

const artifactFiles = [...files]
  .filter((fileName) => fileName !== "SHA256SUMS" && fileName !== "release-manifest.json")
  .sort((left, right) => left.localeCompare(right));
const artifacts = await Promise.all(
  artifactFiles.map(async (fileName) => {
    const filePath = resolve(releaseDirectory, fileName);
    return {
      name: fileName,
      size: (await stat(filePath)).size,
      sha256: await sha256(filePath),
    };
  }),
);

const manifest = {
  schemaVersion: 1,
  tag: tagName,
  version,
  artifacts,
};
const manifestPath = resolve(releaseDirectory, "release-manifest.json");
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const checksums = artifacts.map(({ name, sha256 }) => `${sha256}  ${name}`);
checksums.push(`${await sha256(manifestPath)}  release-manifest.json`);
await writeFile(resolve(releaseDirectory, "SHA256SUMS"), `${checksums.join("\n")}\n`);

console.log(`Validated ${artifacts.length} release artifacts and wrote SHA256SUMS and release-manifest.json.`);
