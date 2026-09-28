import { describe, expect, test } from "bun:test";
import { HELP, parseArgs, UsageError } from "./args";

describe("parseArgs", () => {
  test("no arguments is help; --version and -v anywhere print the version", () => {
    expect(parseArgs([]).command).toBe("help");
    expect(parseArgs(["--version"]).command).toBe("version");
    expect(parseArgs(["-v"]).command).toBe("version");
    expect(parseArgs(["version"]).command).toBe("version");
  });

  test("--help after a command is help for that command", () => {
    const a = parseArgs(["wire", "--help"]);
    expect(a.command).toBe("help");
    expect(a.positional).toEqual(["wire"]);
    expect(parseArgs(["-h"]).positional).toEqual([]);
    expect(parseArgs(["help", "doctor"]).positional).toEqual(["doctor"]);
  });

  test("wire: dir, boolean flags, value flags in both spellings", () => {
    const a = parseArgs([
      "wire",
      "../proj",
      "--gate",
      "--telemetry",
      "--port=4300",
      "--home",
      "/h",
    ]);
    expect(a.command).toBe("wire");
    expect(a.positional).toEqual(["../proj"]);
    expect([...a.flags].sort()).toEqual(["--gate", "--telemetry"]);
    expect(a.values).toEqual({ "--port": "4300", "--home": "/h" });
  });

  test("start takes --port", () => {
    expect(parseArgs(["start", "--port", "4243"]).values["--port"]).toBe("4243");
  });

  const bad: [string[], RegExp][] = [
    [["launch"], /unknown command "launch"/],
    [["start", "--gate"], /amc start does not take --gate/],
    [["mcp", "--port", "1"], /amc mcp does not take --port/],
    [["wire", "--port"], /--port needs a value/],
    [["wire", "--port="], /--port needs a value/],
    [["wire", "--gate=yes"], /--gate does not take a value/],
    [["wire", "-x"], /unknown option -x/],
    [["wire", "a", "b"], /unexpected argument "b"/],
    [["start", "extra"], /unexpected argument "extra"/],
    [["wire", "--gate", "--gate-questions-only"], /alternatives/],
    [["wire", "--global", "--local"], /--local is for a project/],
    [["unwire", "--global", "dir"], /takes no directory/],
    [["start", "--port", "70000"], /--port must be 1-65535/],
    [["start", "--port", "abc"], /--port must be 1-65535/],
  ];
  for (const [argv, msg] of bad) {
    test(`rejects ${argv.join(" ")}`, () => {
      expect(() => parseArgs(argv)).toThrow(UsageError);
      expect(() => parseArgs(argv)).toThrow(msg);
    });
  }

  test("every command has help text", () => {
    for (const c of ["start", "wire", "unwire", "mcp", "doctor", "version", "help"] as const) {
      expect(HELP[c].length).toBeGreaterThan(0);
    }
    expect(HELP.main).toContain("start ");
  });
});
