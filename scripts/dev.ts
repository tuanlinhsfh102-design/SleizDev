import { createWriteStream, writeFileSync } from "node:fs";
import { resolve } from "node:path";

type ServiceName = "next" | "service";
type Mode = "all" | "next-only" | "service-only";

const rootDir = resolve(import.meta.dir, "..");
const serviceDir = resolve(rootDir, "mini-services", "translation-service");
const nextCli = resolve(rootDir, "node_modules", "next", "dist", "bin", "next");
const bunExe = Bun.env.BUN_EXE ?? process.execPath ?? Bun.which("bun") ?? "bun";
const nodeExe = Bun.which("node") ?? "node";
const mode: Mode = Bun.argv.includes("--next-only")
  ? "next-only"
  : Bun.argv.includes("--service-only")
    ? "service-only"
    : "all";

const colors: Record<ServiceName, string> = {
  next: "\u001b[34m",
  service: "\u001b[32m",
};

const activeChildren = new Set<ReturnType<typeof Bun.spawn>>();

function prefixAndWrite(name: ServiceName, text: string, target: NodeJS.WriteStream, logFile: ReturnType<typeof createWriteStream>) {
  const lines = text.split(/\r?\n/);
  const lastIndex = lines.length - 1;

  for (let i = 0; i < lastIndex; i += 1) {
    const line = lines[i];
    target.write(`${colors[name]}[${name}]\u001b[0m ${line}\n`);
    logFile.write(`${line}\n`);
  }
}

async function pumpStream(
  name: ServiceName,
  stream: ReadableStream<Uint8Array> | null,
  target: NodeJS.WriteStream,
  logFile: ReturnType<typeof createWriteStream>,
) {
  if (!stream) return;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });

    const parts = pending.split(/\r?\n/);
    pending = parts.pop() ?? "";
    if (parts.length > 0) {
      prefixAndWrite(name, `${parts.join("\n")}\n`, target, logFile);
    }
  }

  pending += decoder.decode();
  if (pending.length > 0) {
    target.write(`${colors[name]}[${name}]\u001b[0m ${pending}\n`);
    logFile.write(`${pending}\n`);
  }
}

async function runStep(name: ServiceName, args: string[], cwd: string, logPath: string) {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });

  activeChildren.add(proc);
  const logFile = createWriteStream(logPath, { flags: "a" });

  await Promise.all([
    pumpStream(name, proc.stdout, process.stdout, logFile),
    pumpStream(name, proc.stderr, process.stderr, logFile),
    proc.exited,
  ]);

  logFile.end();
  activeChildren.delete(proc);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`[${name}] exited with code ${exitCode}`);
  }
}

function spawnService(name: ServiceName, args: string[], cwd: string, logPath: string, clearLog = true) {
  if (clearLog) {
    writeFileSync(logPath, "");
  }

  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });

  activeChildren.add(proc);
  const logFile = createWriteStream(logPath, { flags: "a" });

  void pumpStream(name, proc.stdout, process.stdout, logFile);
  void pumpStream(name, proc.stderr, process.stderr, logFile);

  proc.exited.finally(() => {
    logFile.end();
    activeChildren.delete(proc);
  });

  return proc;
}

function shutdown(exitCode = 0) {
  for (const child of activeChildren) {
    child.kill();
  }

  setTimeout(() => process.exit(exitCode), 100);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

async function startNext() {
  return spawnService("next", [nodeExe, nextCli, "dev", "-p", "3000"], rootDir, resolve(rootDir, "dev.log"));
}

async function startService() {
  const logPath = resolve(rootDir, "service.dev.log");
  writeFileSync(logPath, "");
  await runStep("service", [bunExe, "install", "--silent"], serviceDir, logPath);
  return spawnService("service", [bunExe, "run", "dev"], serviceDir, logPath, false);
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
    next.exited.then((code) => ["next", code] as const),
    service.exited.then((code) => ["service", code] as const),
  ]);

  if (exitCode !== 0) {
    console.error(`[dev] ${winner} exited with code ${exitCode}`);
  }

  shutdown(exitCode);
}

await main().catch((error) => {
  console.error(`[dev] ${error instanceof Error ? error.message : String(error)}`);
  shutdown(1);
});
