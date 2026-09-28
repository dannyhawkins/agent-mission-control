#!/usr/bin/env bun
/**
 * amc: the single entry point for every role (hub, wiring, MCP server, doctor).
 * `bun build --compile` turns this into the amc binary (build.ts); from a
 * checkout, `bun apps/cli/src/main.ts <command>` behaves the same.
 */
import path from "node:path";
import { runStdio } from "../../../packages/mcp-server/src/index";
import { runHub } from "../../hub/src/index";
import { HELP, type ParsedArgs, parseArgs, UsageError } from "./args";
import { consoleIo, hubUrlFor, type Io, realWireEnv, runUnwire, runWire } from "./commands";
import { doctor, printChecks, realClaudeVersion } from "./doctor";
import { SNIPPET, selfDescription, selfMcpCommand, VERSION } from "./self";
import { webAssets } from "./web-assets";

/** Commands that return; `start` and `mcp` keep the process alive until a signal. */
export interface MainDeps {
  io: Io;
  start(port?: number): void;
  mcp(): Promise<void>;
  wireEnv(args: ParsedArgs): ReturnType<typeof realWireEnv>;
  env: NodeJS.ProcessEnv;
  claudeVersion(): string | undefined;
}

export const realDeps: MainDeps = {
  io: consoleIo,
  start: (port) => void runHub({ port, webAssets }),
  mcp: () => runStdio(VERSION),
  wireEnv: (args) => realWireEnv(args, selfMcpCommand(), SNIPPET),
  env: process.env,
  claudeVersion: realClaudeVersion,
};

export async function main(argv: string[], deps: MainDeps = realDeps): Promise<number> {
  const { io } = deps;
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(`amc: ${err.message}\n\n${HELP.main}`);
    return 2;
  }

  try {
    switch (args.command) {
      case "version":
        io.out(VERSION);
        return 0;
      case "help": {
        const topic = args.positional[0];
        io.out(topic && topic in HELP ? HELP[topic as keyof typeof HELP] : HELP.main);
        return 0;
      }
      case "start": {
        const port = args.values["--port"];
        deps.start(port ? Number(port) : undefined);
        return 0;
      }
      case "mcp":
        await deps.mcp();
        return 0;
      case "wire":
        return runWire(args, io, deps.wireEnv(args), deps.env);
      case "unwire":
        return runUnwire(args, io, deps.wireEnv(args));
      case "doctor": {
        const w = deps.wireEnv(args);
        const checks = await doctor({
          version: VERSION,
          self: w.mcp,
          selfLabel: selfDescription(),
          hubUrl: hubUrlFor(args, deps.env),
          home: w.home,
          claudeJson: w.claudeJson,
          dir: path.resolve(w.cwd, args.positional[0] ?? "."),
          env: deps.env,
          claudeVersion: deps.claudeVersion,
        });
        return printChecks(checks, io);
      }
    }
  } catch (err) {
    // Refusals (telemetry conflicts, bad JSON, unwiring the Claude home) are messages, not stack traces.
    io.err((err as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const code = await main(argv);
  // start and mcp run until a signal (or stdin closes); everything else is done.
  let serving = false;
  try {
    serving = ["start", "mcp"].includes(parseArgs(argv).command);
  } catch {
    // usage error, already reported
  }
  if (code !== 0 || !serving) process.exit(code);
}
