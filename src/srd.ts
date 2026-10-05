/**
 * `srd-rules-engine/srd`: the SRD 5.2.1 content bundled as one JSON module (about 2 MB). For
 * servers, the CLI and tests; a browser can fetch the per-table files instead (`loadPack`).
 * Platform-neutral.
 */

export { SRD_PACK_ID, srdCatalog, srdPack } from "./content/srd";
