// dev.mjs – Node.js replacement for the original bun dev.ts
import { createWriteStream, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @typedef {"next"|"service"} ServiceName */
/** @typedef {"all"|"next-only"|"service-only"} Mode */

const rootDir = resolve(__dirname, "..");
const serviceDir = resolve(rootDir, "mini-services", "translation-service");
const nextCli = resolve(rootDir, "node_modules", "next", "dist", "bin", "next");
const nodeExe = process.execPath;
const isWin = process.platform === "win32";

/** @type {Mode} */
const mode = process.argv.includes("--next-only")
  ? "next-only"
  : process.argv.includes("--service-only")
    ? "service-only"
    : "all";

const colors = {
  next: "\u001b[34m",
  service: "\u001b[32m",
};

/** @type {Set<import("child_process").ChildProcess>} */
const activeChildren = new Set();

/**
 * On Windows, .cmd scripts must be invoked via cmd.exe to avoid
 * shell:true (which triggers DEP0190 in Node 24+).
 * Returns [finalCmd, finalArgs, useShell].
 *
 * @param {string} cmd
 * @param {string[]} args
 * @returns {[string, string[], boolean]}
 */
function resolveCmd(cmd, args) {
  if (isWin && /\.(cmd|bat)$/i.test(cmd)) {
    const comSpec = process.env.ComSpec || "cmd.exe";
    return [comSpec, ["/d", "/s", "/c", cmd, ...args], false];
  }
  return [cmd, args, false];
}

/**
 * @param {ServiceName} name
 * @param {string} text
 * @param {NodeJS.WriteStream} target
 * @param {import("fs").WriteStream} logFile
 */
function prefixAndWrite(name, text, target, logFile) {
  const lines = text.split(/\r?\n/);
  const lastIndex = lines.length - 1;
  for (let i = 0; i < lastIndex; i++) {
    const line = lines[i];
    target.write(`${colors[name]}[${name}]\u001b[0m ${line}\n`);
    logFile.write(`${line}\n`);
  }
}

/**
 * @param {ServiceName} name
 * @param {import("stream").Readable|null} stream
 * @param {NodeJS.WriteStream} target
 * @param {import("fs").WriteStream} logFile
 * @returns {Promise<void>}
 */
function pumpStream(name, stream, target, logFile) {
  if (!stream) return Promise.resolve();
  return new Promise((resolve) => {
    let pending = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      pending += chunk;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop() ?? "";
      if (parts.length > 0) {
        prefixAndWrite(name, `${parts.join("\n")}\n`, target, logFile);
      }
    });
    stream.on("end", () => {
      if (pending.length > 0) {
        target.write(`${colors[name]}[${name}]\u001b[0m ${pending}\n`);
        logFile.write(`${pending}\n`);
      }
      resolve();
    });
  });
}

/**
 * @param {ServiceName} name
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} logPath
 * @returns {Promise<void>}
 */
function runStep(name, cmd, args, cwd, logPath) {
  return new Promise((resolve, reject) => {
    const [finalCmd, finalArgs, useShell] = resolveCmd(cmd, args);
    const proc = spawn(finalCmd, finalArgs, {
      cwd,
      stdio: ["inherit", "pipe", "pipe"],
      shell: useShell,
    });
    activeChildren.add(proc);
    const logFile = createWriteStream(logPath, { flags: "a" });

    Promise.all([
      pumpStream(name, proc.stdout, process.stdout, logFile),
      pumpStream(name, proc.stderr, process.stderr, logFile),
    ]).then(() => logFile.end());

    proc.on("close", (code) => {
      activeChildren.delete(proc);
      if (code !== 0) {
        reject(new Error(`[${name}] exited with code ${code}`));
      } else {
        resolve();
      }
    });
  });
}

/**
 * @param {ServiceName} name
 * @param {string} cmd
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} logPath
 * @param {boolean} [clearLog]
 * @returns {{ exited: Promise<number>, kill: () => void }}
 */
function spawnService(name, cmd, args, cwd, logPath, clearLog = true) {
  if (clearLog) writeFileSync(logPath, "");

  const [finalCmd, finalArgs, useShell] = resolveCmd(cmd, args);
  const proc = spawn(finalCmd, finalArgs, {
    cwd,
    stdio: ["inherit", "pipe", "pipe"],
    shell: useShell,
  });

  activeChildren.add(proc);
  const logFile = createWriteStream(logPath, { flags: "a" });

  pumpStream(name, proc.stdout, process.stdout, logFile);
  pumpStream(name, proc.stderr, process.stderr, logFile);

  const exited = new Promise((resolve) => {
    proc.on("close", (code) => {
      logFile.end();
      activeChildren.delete(proc);
      resolve(code ?? 1);
    });
  });

  return { exited, kill: () => { try { proc.kill(); } catch (_) {} } };
}

function shutdown(exitCode = 0) {
  for (const child of activeChildren) {
    try { child.kill(); } catch (_) {}
  }
  setTimeout(() => process.exit(exitCode), 100);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function startNext() {
  return spawnService(
    "next",
    nodeExe,
    [nextCli, "dev", "-p", "3000"],
    rootDir,
    resolve(rootDir, "dev.log"),
  );
}

async function startService() {
  const logPath = resolve(rootDir, "service.dev.log");
  writeFileSync(logPath, "");

  // npm.cmd on Windows → routed through cmd.exe via resolveCmd
  await runStep("service", isWin ? "npm.cmd" : "npm", ["install", "--silent"], serviceDir, logPath);

  // --import requires a file:// URL on Windows, not a bare Windows path
  const tsxEsmPath = resolve(serviceDir, "node_modules", "tsx", "dist", "esm", "index.mjs");
  const tsxEsmUrl = pathToFileURL(tsxEsmPath).href;

  return spawnService(
    "service",
    nodeExe,
    ["--import", tsxEsmUrl, "--watch", "src/index.ts"],
    serviceDir,
    logPath,
    false,
  );
}

async function main() {
  if (mode === "next-only") {
    const next = await startNext();
    process.exit(await next.exited);
  }

  if (mode === "service-only") {
    const service = await startService();
    process.exit(await service.exited);
  }

  const [next, service] = await Promise.all([startNext(), startService()]);
  const [winner, exitCode] = await Promise.race([
    next.exited.then((code) => ["next", code]),
    service.exited.then((code) => ["service", code]),
  ]);

  if (exitCode !== 0) {
    console.error(`[dev] ${winner} exited with code ${exitCode}`);
  }

  shutdown(exitCode);
}

main().catch((error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});
