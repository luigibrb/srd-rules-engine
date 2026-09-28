/**
 * Generate `content/srd-5.2.1/spells.yaml` from the SRD 5.2.1 Markdown in `docs/srd-5.2.1/`
 * (git-ignored; see DATA-SOURCES.md). The output is committed and reviewed like any other
 * content file.
 *
 * Text is the SRD's. Mechanics (`mechanics`, used by `castSpell`) come from the MECHANICS
 * overlay below; change it, not the generated YAML, since a rerun overwrites it.
 *
 *   npx tsx scripts/import-srd-spells.ts [--max-level 9]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

const root = join(import.meta.dirname, "..");
const maxLevelArg = process.argv.indexOf("--max-level");
const maxLevel = maxLevelArg >= 0 ? Number(process.argv[maxLevelArg + 1]) : 9;

// --- mechanics overlay ------------------------------------------------------------------------
// Each entry is checked by hand against the spell's SRD text (golden spells: tests/casting.test.ts).

const MECHANICS: Record<string, Record<string, unknown>> = {
  // Cantrips
  "acid-splash": {
    save: { ability: "dex", on_success: "none" },
    damage: [{ dice: "1d6", type: "acid" }],
    cantrip_scaling: "dice",
    area: { shape: "sphere", size: 5 },
  },
  "eldritch-blast": {
    attack: "ranged",
    damage: [{ dice: "1d10", type: "force" }],
    targets: 1,
    cantrip_scaling: "beams",
  },
  "fire-bolt": {
    attack: "ranged",
    damage: [{ dice: "1d10", type: "fire" }],
    targets: 1,
    cantrip_scaling: "dice",
  },
  // Level 1
  "burning-hands": {
    save: { ability: "dex", on_success: "half" },
    damage: [{ dice: "3d6", type: "fire" }],
    upcast: { damage: [{ dice: "1d6", type: "fire" }] },
    area: { shape: "cone", size: 15 },
  },
  "cure-wounds": {
    heal: { dice: "2d8", add_modifier: true },
    targets: 1,
    upcast: { heal: "2d8" },
  },
  "guiding-bolt": {
    attack: "ranged",
    damage: [{ dice: "4d6", type: "radiant" }],
    targets: 1,
    upcast: { damage: [{ dice: "1d6", type: "radiant" }] },
  },
  "healing-word": {
    heal: { dice: "2d4", add_modifier: true },
    targets: 1,
    upcast: { heal: "2d4" },
  },
  "inflict-wounds": {
    save: { ability: "con", on_success: "half" },
    damage: [{ dice: "2d10", type: "necrotic" }],
    targets: 1,
    upcast: { damage: [{ dice: "1d10", type: "necrotic" }] },
  },
  // Level 2
  "hold-person": {
    save: { ability: "wis", on_success: "none" },
    targets: 1,
    upcast: { targets: 1 },
    conditions: [{ condition: "paralyzed", on: "failed_save" }],
  },
  // Level 3
  fireball: {
    save: { ability: "dex", on_success: "half" },
    damage: [{ dice: "8d6", type: "fire" }],
    upcast: { damage: [{ dice: "1d6", type: "fire" }] },
    area: { shape: "sphere", size: 20 },
  },
  // Level 4
  "ice-storm": {
    save: { ability: "dex", on_success: "half" },
    damage: [
      { dice: "2d10", type: "bludgeoning" },
      { dice: "4d6", type: "cold" },
    ],
    upcast: { damage: [{ dice: "1d10", type: "bludgeoning" }] },
    area: { shape: "cylinder", size: 20 },
  },
};

const markdown = readFileSync(join(root, "docs/srd-5.2.1/spells.md"), "utf-8");
const body = markdown.slice(markdown.indexOf("## Spell Descriptions"));

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const field = (text: string, label: string) =>
  new RegExp(`\\*\\*${label}:\\*\\* (.*)`).exec(text)?.[1]?.trim() ?? "";

const HEADER = /^_(?:Level (\d) (\w+)|(\w+) Cantrip) \(([^)]*)\)_/;

// Some spells contain their own "####" headings (stat blocks, tables): merge those sections into
// the spell they belong to.
const sections: string[] = [];
for (const section of body.split(/\n#### /).slice(1)) {
  const text = section.split("\n").slice(1).join("\n").trim();
  if (HEADER.test(text) || !sections.length) sections.push(section);
  else sections[sections.length - 1] += `\n\n#### ${section}`;
}

const spells: Record<string, unknown>[] = [];
for (const section of sections) {
  const [name = "", ...rest] = section.split("\n");
  const text = rest.join("\n").trim();
  const header = HEADER.exec(text);
  if (!header) throw new Error(`Can't parse the header of ${name}`);
  const level = header[1] ? Number(header[1]) : 0;
  if (level > maxLevel) continue;
  const school = (header[2] ?? header[3] ?? "").toLowerCase();
  const lists = (header[4] ?? "").split(",").map((c) => slug(c.trim()));
  const castingTime = field(text, "Casting Time");
  const duration = field(text, "Duration");
  const description = text
    .slice(text.indexOf(field(text, "Duration")) + duration.length)
    .trim()
    .replace(/\n{3,}/g, "\n\n");
  spells.push({
    id: slug(name.trim()),
    name: name.trim(),
    level,
    school,
    lists,
    casting_time: castingTime.replace(/ or Ritual$/, ""),
    ritual: / or Ritual$/.test(castingTime),
    range: field(text, "Range"),
    components: field(text, "Components"),
    duration,
    concentration: duration.startsWith("Concentration"),
    description,
    mechanics: MECHANICS[slug(name.trim())],
  });
}
const missing = Object.keys(MECHANICS).filter((id) => !spells.some((s) => s.id === id));
if (missing.length) throw new Error(`MECHANICS for unknown spells: ${missing.join(", ")}`);

spells.sort(
  (a, b) => (a.level as number) - (b.level as number) || String(a.id).localeCompare(String(b.id)),
);
const header =
  "# yaml-language-server: $schema=../../schemas/spells.schema.json\n" +
  `# SRD 5.2.1 — "Spells" > "Spell Descriptions".\n` +
  "# Generated by scripts/import-srd-spells.ts from docs/srd-5.2.1/spells.md, then reviewed.\n";
writeFileSync(
  join(root, "content/srd-5.2.1/spells.yaml"),
  header + stringify(spells, { lineWidth: 100 }),
);
console.log(
  `wrote ${spells.length} spells (${spells.filter((s) => s.level === 0).length} cantrips)`,
);
