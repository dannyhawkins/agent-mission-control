import type { WebAssets } from "../../hub/src/hub";

/**
 * The embedded UI. This stub is what a checkout sees (the hub then serves
 * apps/web/dist from disk); build.ts swaps this module at bundle time for a
 * generated one that imports every apps/web/dist file `with { type: "file" }`,
 * which is what puts them inside the binary.
 */
export const webAssets: WebAssets | undefined = undefined;
