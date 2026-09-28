// The one version number: the root package.json, bundled into the amc binary at build time.
import pkg from "../../../package.json" with { type: "json" };

export const VERSION: string = pkg.version;
