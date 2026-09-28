import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { PLATFORMS, parseSums, renderFormula, TEMPLATE, tarballName } from "./render-formula";

const template = fs.readFileSync(TEMPLATE, "utf8");
const hex = (c: string) => c.repeat(64);
const SHAS: Record<string, string> = {
  "darwin-arm64": hex("a"),
  "darwin-x64": hex("b"),
  "linux-arm64": hex("c"),
  "linux-x64": hex("d"),
};
const sumsText = (version: string) =>
  `${PLATFORMS.map((p) => `${SHAS[p]}  ${tarballName(version, p)}`).join("\n")}\n`;

describe("parseSums", () => {
  test("reads sha256sum output in text and binary mode, keyed by basename", () => {
    expect(parseSums(`${hex("A")}  dist/x.tar.gz\n${hex("b")} *y.tar.gz\n\n`)).toEqual({
      "x.tar.gz": hex("a"),
      "y.tar.gz": hex("b"),
    });
  });

  test("rejects a line that is not a checksum", () => {
    expect(() => parseSums("nope  x.tar.gz")).toThrow(/unreadable/);
  });
});

describe("renderFormula", () => {
  const formula = renderFormula(template, {
    version: "v0.2.1",
    sums: parseSums(sumsText("0.2.1")),
  });

  test("fills every placeholder", () => {
    expect(formula).not.toContain("{{");
    expect(formula).toContain('version "0.2.1"');
    expect(formula).toContain('homepage "https://github.com/dannyhawkins/agent-mission-control"');
  });

  test("pairs each platform's url with its own sha256", () => {
    for (const p of PLATFORMS) {
      const url = `https://github.com/dannyhawkins/agent-mission-control/releases/download/v0.2.1/amc-0.2.1-${p}.tar.gz`;
      expect(formula).toContain(`url "${url}"\n      sha256 "${SHAS[p]}"`);
    }
  });

  test("puts arm and intel under on_macos and on_linux, installs and tests amc", () => {
    const macos = formula.slice(formula.indexOf("on_macos do"), formula.indexOf("on_linux do"));
    expect(macos).toMatch(/on_arm do\n\s+url "[^"]+darwin-arm64/);
    expect(macos).toMatch(/on_intel do\n\s+url "[^"]+darwin-x64/);
    const linux = formula.slice(formula.indexOf("on_linux do"));
    expect(linux).toMatch(/on_arm do\n\s+url "[^"]+linux-arm64/);
    expect(linux).toMatch(/on_intel do\n\s+url "[^"]+linux-x64/);
    expect(formula).toContain('bin.install "amc"');
    expect(formula).toContain('shell_output("#{bin}/amc --version")');
  });

  test("uses another repo when given one", () => {
    const f = renderFormula(template, {
      version: "0.2.1",
      sums: parseSums(sumsText("0.2.1")),
      repo: "me/fork",
    });
    expect(f).toContain("https://github.com/me/fork/releases/download/v0.2.1/");
  });

  test("fails when a platform is missing from SHA256SUMS", () => {
    const partial = sumsText("0.2.1").split("\n").slice(1).join("\n");
    expect(() => renderFormula(template, { version: "0.2.1", sums: parseSums(partial) })).toThrow(
      /no entry for amc-0.2.1-darwin-arm64/,
    );
  });

  test("fails when the sums are for another version", () => {
    expect(() =>
      renderFormula(template, { version: "0.2.2", sums: parseSums(sumsText("0.2.1")) }),
    ).toThrow(/no entry/);
  });

  test("rejects a version that is not semver", () => {
    expect(() => renderFormula(template, { version: "latest", sums: {} })).toThrow(/semver/);
  });

  test("rejects a placeholder it has no value for", () => {
    expect(() =>
      renderFormula(`${template}{{NOPE}}`, {
        version: "0.2.1",
        sums: parseSums(sumsText("0.2.1")),
      }),
    ).toThrow(/NOPE/);
  });
});
