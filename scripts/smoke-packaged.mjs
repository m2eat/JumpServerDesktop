import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const timeoutMs = 45_000;

function fail(message) {
  throw new Error(message);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function exists(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveExecutable(releaseDirectory) {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const { version } = packageJson;
  const productName = packageJson.build?.productName;
  if (typeof version !== "string" || !version) fail("package.json version is required.");
  if (typeof productName !== "string" || !productName) fail("package.json build.productName is required.");

  const macExecutable = (outputDirectory) =>
    join(releaseDirectory, outputDirectory, `${productName}.app`, "Contents", "MacOS", productName);
  const macOutputDirectories = process.arch === "arm64"
    ? ["mac-arm64", "mac", "mac-x64"]
    : ["mac", "mac-x64", "mac-arm64"];
  const candidates = process.platform === "win32"
    ? [join(releaseDirectory, "win-unpacked", `${productName}.exe`)]
    : process.platform === "darwin"
      ? macOutputDirectories.map(macExecutable)
      : [
          join(releaseDirectory, "linux-unpacked", packageJson.name),
          join(releaseDirectory, "linux-unpacked", productName),
        ];

  for (const candidate of candidates) {
    if (await exists(candidate)) return { executable: candidate, version };
  }

  fail(`No runnable packaged executable found. Looked for:\n${candidates.map((candidate) => `- ${candidate}`).join("\n")}`);
}

function launch(executable, userDataDirectory) {
  const environment = { ...process.env };
  delete environment.ELECTRON_RUN_AS_NODE;

  const child = spawn(
    executable,
    [
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDirectory}`,
    ],
    {
      cwd: dirname(executable),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

  let diagnostics = "";
  const collectDiagnostics = (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-8_000);
  };
  child.stdout.on("data", collectDiagnostics);
  child.stderr.on("data", collectDiagnostics);

  let launchFailure;
  child.once("error", (error) => {
    launchFailure = error;
  });
  return { child, diagnostics: () => diagnostics, launchFailure: () => launchFailure };
}

async function waitForDebugger(userDataDirectory, child, getLaunchFailure, diagnostics) {
  const deadline = Date.now() + timeoutMs;
  const activePortPath = join(userDataDirectory, "DevToolsActivePort");

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      fail(`Packaged app exited before opening the debugger (exit ${child.exitCode}).\n${diagnostics()}`);
    }

    const launchFailure = getLaunchFailure();
    if (launchFailure) throw launchFailure;

    try {
      const [port] = (await readFile(activePortPath, "utf8")).trim().split("\n");
      if (port) {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json();
        const page = targets.find((target) =>
          target.type === "page" &&
          typeof target.url === "string" &&
          /^file:\/\/.*\/index\.html(?:[?#].*)?$/.test(target.url) &&
          target.webSocketDebuggerUrl,
        );
        if (page) return page.webSocketDebuggerUrl;
      }
    } catch {
      // The profile and DevTools endpoint are created asynchronously during startup.
    }

    await delay(250);
  }

  fail(`Timed out waiting for the packaged app's DevTools endpoint.\n${diagnostics()}`);
}

async function evaluate(webSocketUrl, expectedVersion) {
  const socket = new WebSocket(webSocketUrl);
  const response = await new Promise((resolveResponse, rejectResponse) => {
    const timer = setTimeout(() => rejectResponse(new Error("Timed out waiting for CDP Runtime.evaluate.")), timeoutMs);
    const finish = (callback, value) => {
      clearTimeout(timer);
      socket.close();
      callback(value);
    };

    socket.addEventListener("error", () => finish(rejectResponse, new Error("Could not connect to the packaged app's DevTools endpoint.")), { once: true });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          awaitPromise: true,
          returnByValue: true,
          expression: `
            (async () => {
              const expectedVersion = ${JSON.stringify(expectedVersion)};
              if (typeof require !== "undefined") {
                throw new Error("renderer require must be unavailable");
              }
              if (!window.desktop || typeof window.desktop.invoke !== "function") {
                throw new Error("window.desktop.invoke is unavailable");
              }
              const bootstrap = await window.desktop.invoke("app.bootstrap", {});
              const update = await window.desktop.invoke("app.updates", {});
              if (bootstrap?.identity !== null) {
                throw new Error("isolated profile unexpectedly restored an identity");
              }
              if (!update || update.currentVersion !== expectedVersion || typeof update.phase !== "string") {
                throw new Error("update response has an unexpected shape or version");
              }
              return {
                currentVersion: update.currentVersion,
                updateMode: update.mode,
                updatePhase: update.phase,
              };
            })()
          `,
        },
      }));
    }, { once: true });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      if (message.error || message.result?.exceptionDetails) {
        finish(rejectResponse, new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
        return;
      }
      finish(resolveResponse, message.result?.result?.value);
    });
  });

  if (!response || typeof response !== "object") fail("CDP evaluation returned no value.");
  return response;
}

async function waitForExit(child, milliseconds) {
  if (child.exitCode !== null) return true;

  return new Promise((resolveExit) => {
    let timer;
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    timer = milliseconds === undefined
      ? undefined
      : setTimeout(() => {
          child.off("exit", onExit);
          resolveExit(false);
        }, milliseconds);
    child.once("exit", onExit);
  });
}

async function stop(child) {
  if (!child.pid || child.exitCode !== null) return;

  child.kill("SIGTERM");
  if (await waitForExit(child, 10_000)) return;

  child.kill("SIGKILL");
  await waitForExit(child);
}

const [releaseDirectoryArgument, ...extraArguments] = process.argv.slice(2);
if (!releaseDirectoryArgument || extraArguments.length > 0) {
  console.error("Usage: node scripts/smoke-packaged.mjs <release-directory>");
  process.exit(1);
}

const releaseDirectory = resolve(root, releaseDirectoryArgument);
const userDataDirectory = await mkdtemp(join(tmpdir(), "jumpserver-desktop-smoke-"));
let launched;

try {
  const { executable, version } = await resolveExecutable(releaseDirectory);
  launched = launch(executable, userDataDirectory);
  const debuggerUrl = await waitForDebugger(userDataDirectory, launched.child, launched.launchFailure, launched.diagnostics);
  const result = await evaluate(debuggerUrl, version);
  console.log(`Packaged startup smoke passed: ${JSON.stringify(result)}`);
} finally {
  if (launched) await stop(launched.child);
  await rm(userDataDirectory, { recursive: true, force: true });
}
