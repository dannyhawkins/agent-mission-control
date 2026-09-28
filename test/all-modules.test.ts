// Coverage honesty (#9). Bun only reports files that some test loads, so a module no
// test imports is invisible and the overall number overstates real coverage. Importing
// every source module here makes an untested file count at 0% instead of vanishing.
//
// New source files are picked up by the glob automatically. Only add to ENTRY_POINTS
// a file that does something on import (starts a server, grabs stdio, needs a DOM
// root); those are the only files allowed to stay out of the coverage report.

import { describe, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { Glob } from "bun";

const ROOT = join(import.meta.dir, "..");

const ENTRY_POINTS: Record<string, string> = {
  "apps/web/src/main.tsx": "renders into #root from index.html and imports CSS/fonts",
};

const modules = [...new Glob("{apps,packages}/*/src/**/*.{ts,tsx}").scanSync({ cwd: ROOT })]
  .filter((f) => !/\.(test|spec)\.tsx?$/.test(f) && !f.endsWith(".d.ts"))
  .sort();

describe("every source module loads", () => {
  test("entry point exclusions still exist", () => {
    for (const f of Object.keys(ENTRY_POINTS)) expect(modules).toContain(f);
  });

  for (const file of modules) {
    if (file in ENTRY_POINTS) continue;
    test(file, async () => {
      const mod = await import(join(ROOT, file));
      expect(mod, relative(ROOT, file)).toBeDefined();
    });
  }
});
