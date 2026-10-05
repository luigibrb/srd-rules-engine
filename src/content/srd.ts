/**
 * The SRD 5.2.1 content bundled with the package, precompiled from `content/srd-5.2.1/` by
 * `npm run content`. Works without a filesystem.
 *
 * This material is from the System Reference Document 5.2.1 by Wizards of the Coast LLC,
 * licensed under CC BY 4.0. See DATA-SOURCES.md.
 */

import { type Catalog, type ContentPack, createCatalog } from "./catalog";
import data from "./data/srd-5.2.1.json" with { type: "json" };

export { SRD_PACK_ID } from "./srd-id";

export const srdPack: ContentPack = data as ContentPack;

let cached: Catalog | undefined;

/** The validated SRD 5.2.1 catalog (built once, then cached). */
export function srdCatalog(): Catalog {
  cached ??= createCatalog(srdPack);
  return cached;
}
