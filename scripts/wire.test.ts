import { expect, test } from "bun:test";
import { translate } from "./wire";

test("the old wire.ts flags map onto amc wire / amc unwire", () => {
  expect(translate(["/p"])).toEqual(["wire", "/p", "--dry-run"]);
  expect(translate(["/p", "--write", "--local", "--gate"])).toEqual([
    "wire",
    "/p",
    "--local",
    "--gate",
  ]);
  expect(translate(["--global", "--write", "--telemetry"])).toEqual([
    "wire",
    "--global",
    "--telemetry",
  ]);
  expect(translate(["/p", "--unwire", "--local", "--port", "4300"])).toEqual(["unwire", "/p"]);
  expect(translate(["--global", "--unwire", "--home", "/h"])).toEqual([
    "unwire",
    "--global",
    "--home",
    "/h",
  ]);
});
