/**
 * Generate `content/srd-5.2.1/spells.yaml` from the SRD 5.2.1 Markdown in `docs/srd-5.2.1/`
 * (git-ignored; see DATA-SOURCES.md). The output is committed and reviewed like any other
 * content file.
 *
 * Text is the SRD's. Mechanics (`mechanics`, used by `castSpell`) come from two places:
 * - `parseMechanics` (spell-mechanics.ts) drafts them from the text for the common phrasings; a draft is used only
 *   for the ids in REVIEWED, each checked by hand against the spell's text;
 * - the MECHANICS overlay (hand-written; it wins over a draft).
 * Change these, not the generated YAML, since a rerun overwrites it.
 *
 *   npx tsx scripts/import-srd-spells.ts --report   # print every draft and every skip, write nothing
 *
 *   npx tsx scripts/import-srd-spells.ts [--max-level 9]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { type Draft, parseMechanics } from "./spell-mechanics";

const root = join(import.meta.dirname, "..");
const maxLevelArg = process.argv.indexOf("--max-level");
const maxLevel = maxLevelArg >= 0 ? Number(process.argv[maxLevelArg + 1]) : 9;

// --- mechanics overlay ------------------------------------------------------------------------
// Each entry is checked by hand against the spell's SRD text (golden spells: tests/casting.test.ts).

const MECHANICS: Record<string, Record<string, unknown>> = {
  // Marks and smites: extra damage on the caster's attacks.
  "hunters-mark": { mark: { dice: "1d6", type: "force" }, targets: 1 }, // the Perception edge is text
  hex: { mark: { dice: "1d6", type: "necrotic" }, targets: 1 }, // the chosen ability's checks: text
  "divine-smite": {
    // "The target takes an extra 2d8 Radiant damage from the attack … 1d8 if … a Fiend or an Undead."
    damage: [{ dice: "2d8", type: "radiant" }],
    targets: 1,
    after_hit: true,
    bonus_vs: { creature_types: ["fiend", "undead"], dice: "1d8" },
    upcast: { damage: [{ dice: "1d8", type: "radiant" }] },
  },
  "searing-smite": {
    // "As you hit the target, it takes an extra 1d6 Fire damage from the attack." The 1d6 Fire
    // and the Constitution save at the start of each of its turns stay text.
    damage: [{ dice: "1d6", type: "fire" }],
    targets: 1,
    after_hit: true,
    upcast: { damage: [{ dice: "1d6", type: "fire" }] },
  },
  "shining-smite": {
    // "The target hit by the strike takes an extra 2d6 Radiant damage from the attack." Its Bright
    // Light, Advantage on attack rolls against it and no Invisible condition stay text.
    damage: [{ dice: "2d6", type: "radiant" }],
    targets: 1,
    after_hit: true,
    upcast: { damage: [{ dice: "1d6", type: "radiant" }] },
  },
  // Level 5
  "flame-strike": {
    save: { ability: "dex", on_success: "half" },
    damage: [
      { dice: "5d6", type: "fire" },
      { dice: "5d6", type: "radiant" },
    ],
    area: { shape: "cylinder", size: 10 },
    upcast: {
      damage: [
        { dice: "1d6", type: "fire" },
        { dice: "1d6", type: "radiant" },
      ],
    },
  },
  // Level 6
  "chain-lightning": {
    // The first target and up to three others (within 30 feet of it: the caller's to check); one
    // more bolt per slot level above 6.
    save: { ability: "dex", on_success: "half" },
    damage: [{ dice: "10d8", type: "lightning" }],
    targets: 4,
    upcast: { targets: 1 },
  },
  "mass-suggestion": {
    // "Charmed condition for the duration or until you or your allies deal damage to the target".
    save: { ability: "wis", on_success: "none" },
    conditions: [{ condition: "charmed", on: "failed_save", ends_on_damage: true }],
    targets: 12,
  },
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
    // "the next attack roll made against it before the end of your next turn has Advantage"
    on_hit: ["advantage_against"],
  },
  "healing-word": {
    heal: { dice: "2d4", add_modifier: true },
    targets: 1,
    upcast: { heal: "2d4" },
  },
  "ice-knife": {
    attack: "ranged",
    damage: [{ dice: "1d10", type: "piercing" }],
    targets: 1,
    // "Hit or miss, the shard then explodes. The target and each creature within 5 feet of it
    // must succeed on a Dexterity saving throw or take 2d6 Cold damage."
    follow_up: {
      save: { ability: "dex", on_success: "none" },
      damage: [{ dice: "2d6", type: "cold" }],
      upcast: [{ dice: "1d6", type: "cold" }],
      radius: 5,
    },
  },
  "inflict-wounds": {
    save: { ability: "con", on_success: "half" },
    damage: [{ dice: "2d10", type: "necrotic" }],
    targets: 1,
    upcast: { damage: [{ dice: "1d10", type: "necrotic" }] },
  },
  "magic-missile": {
    // "A dart deals 1d4 + 1 Force damage to its target."
    damage: [{ dice: "1d4", type: "force", bonus: 1 }],
    projectiles: { count: 3, upcast: 1 },
  },
  // Level 3
  "mass-healing-word": {
    heal: { dice: "2d4", add_modifier: true },
    targets: 6, // "Up to six creatures"
    upcast: { heal: "1d4" },
  },
  "hypnotic-pattern": {
    save: { ability: "wis", on_success: "none" },
    // "While Charmed, the creature has the Incapacitated condition and a Speed of 0."
    conditions: [
      { condition: "charmed", on: "failed_save" },
      { condition: "incapacitated", on: "failed_save" },
    ],
    area: { shape: "cube", size: 30 },
  },
  // Level 5
  "mass-cure-wounds": {
    heal: { dice: "5d8", add_modifier: true },
    targets: 6, // "Choose up to six creatures in a 30-foot-radius Sphere"
    upcast: { heal: "1d8" },
    area: { shape: "sphere", size: 30 },
  },
  // Level 9
  weird: {
    save: { ability: "wis", on_success: "half" },
    // The 5d10 on a failed repeated save at the end of each turn stays text.
    damage: [{ dice: "10d10", type: "psychic" }],
    conditions: [{ condition: "frightened", on: "failed_save" }],
    area: { shape: "sphere", size: 30 },
  },
  // Level 2
  "hold-person": {
    save: { ability: "wis", on_success: "none" },
    targets: 1,
    upcast: { targets: 1 },
    conditions: [{ condition: "paralyzed", on: "failed_save" }],
  },
  "scorching-ray": {
    attack: "ranged",
    damage: [{ dice: "2d6", type: "fire" }],
    projectiles: { count: 3, upcast: 1 },
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
  // Areas that last (zones): their save happens again when a creature enters or ends its turn
  // there.
  // Level 1
  grease: {
    save: { ability: "dex", on_success: "none" },
    conditions: [{ condition: "prone", on: "failed_save" }],
    area: { shape: "cube", size: 10 }, // "a 10-foot square"
    // No "only once per turn".
    zone: { triggers: ["enter", "end_turn"], once_per_turn: false, difficult: true },
  },
  // Level 2
  moonbeam: {
    save: { ability: "con", on_success: "half" },
    damage: [{ dice: "2d10", type: "radiant" }],
    upcast: { damage: [{ dice: "1d10", type: "radiant" }] },
    area: { shape: "cylinder", size: 5 },
    zone: { triggers: ["enter", "end_turn"] },
  },
  web: {
    save: { ability: "dex", on_success: "none" },
    // "while in the webs or until it breaks free": a Strength (Athletics) check, as an action.
    conditions: [{ condition: "restrained", on: "failed_save", escape: "athletics" }],
    area: { shape: "cube", size: 20 },
    zone: { triggers: ["enter", "start_turn"], on_cast: false, difficult: true },
  },
  "flaming-sphere": {
    save: { ability: "dex", on_success: "half" },
    damage: [{ dice: "2d6", type: "fire" }],
    upcast: { damage: [{ dice: "1d6", type: "fire" }] },
    // "Any creature that ends its turn within 5 feet of the sphere"; ramming it into a space.
    area: { shape: "emanation", size: 5 },
    zone: {
      triggers: ["end_turn"],
      once_per_turn: false,
      on_cast: false,
      anchor: "point",
      ram: true,
    },
  },
  "spike-growth": {
    // "2d4 Piercing damage for every 5 feet it travels" in the area; no save.
    damage: [{ dice: "2d4", type: "piercing" }],
    area: { shape: "sphere", size: 20 },
    zone: { triggers: ["move"], on_cast: false, difficult: true },
  },
  // Level 3
  "conjure-animals": {
    save: { ability: "dex", on_success: "none" },
    damage: [{ dice: "3d10", type: "slashing" }],
    upcast: { damage: [{ dice: "1d10", type: "slashing" }] },
    // "within 10 feet of the pack": a Large pack placed at a point; "you can force".
    area: { shape: "emanation", size: 10 },
    zone: {
      triggers: ["enter", "end_turn"],
      on_cast: false,
      optional: true,
      anchor: "point",
      space: 2,
    },
  },
  "sleet-storm": {
    save: { ability: "dex", on_success: "none" },
    conditions: [{ condition: "prone", on: "failed_save" }],
    area: { shape: "cylinder", size: 20 },
    zone: {
      triggers: ["enter", "start_turn"],
      on_cast: false,
      on_fail: ["lose_concentration"],
      difficult: true,
    },
  },
  "stinking-cloud": {
    save: { ability: "con", on_success: "none" },
    // "Poisoned until the end of the current turn … can't take an action or a Bonus Action"
    conditions: [{ condition: "poisoned", on: "failed_save", until: "end_of_its_turn" }],
    area: { shape: "sphere", size: 20 },
    zone: { triggers: ["start_turn"], on_cast: false, on_fail: ["no_actions"] },
  },
  "spirit-guardians": {
    save: { ability: "wis", on_success: "half" },
    damage: [{ dice: "3d8", type: "radiant" }],
    damage_types: ["radiant", "necrotic"], // good or neutral, or evil
    upcast: { damage: [{ dice: "1d8", type: "radiant" }] },
    area: { shape: "emanation", size: 15 },
    // "Any other creature's Speed is halved in the Emanation."
    zone: { triggers: ["enter", "end_turn"], on_cast: false, designate: true, speed_halved: true },
  },
  // Level 4
  "black-tentacles": {
    save: { ability: "str", on_success: "none" },
    damage: [{ dice: "3d6", type: "bludgeoning" }],
    // "has the Restrained condition until the spell ends"
    conditions: [{ condition: "restrained", on: "failed_save", escape: "athletics" }],
    area: { shape: "cube", size: 20 }, // "a 20-foot square"
    zone: { triggers: ["enter", "end_turn"], difficult: true },
  },
  "conjure-woodland-beings": {
    save: { ability: "wis", on_success: "half" },
    damage: [{ dice: "5d8", type: "force" }],
    upcast: { damage: [{ dice: "1d8", type: "force" }] },
    area: { shape: "emanation", size: 10 },
    zone: { triggers: ["enter", "end_turn"], on_cast: false, optional: true },
  },
  // Level 5
  cloudkill: {
    save: { ability: "con", on_success: "half" },
    damage: [{ dice: "5d8", type: "poison" }],
    upcast: { damage: [{ dice: "1d8", type: "poison" }] },
    area: { shape: "sphere", size: 20 },
    zone: { triggers: ["enter", "end_turn"] },
  },
  "insect-plague": {
    save: { ability: "con", on_success: "half" },
    damage: [{ dice: "4d10", type: "piercing" }],
    upcast: { damage: [{ dice: "1d10", type: "piercing" }] },
    area: { shape: "sphere", size: 20 },
    zone: { triggers: ["enter", "end_turn"], difficult: true },
  },
  // Walls, placed from point to point (`cast` `wall`). Level 4
  "wall-of-fire": {
    // "each creature in its area makes a Dexterity saving throw … 5d8 Fire"; then 5d8 to each
    // creature that ends its turn within 10 feet of the chosen side or inside the wall, or enters
    // it: no save.
    save: { ability: "dex", on_success: "half" },
    damage: [{ dice: "5d8", type: "fire" }],
    upcast: { damage: [{ dice: "1d8", type: "fire" }] },
    wall: { length: 60, side: 10, later: "damage" },
    zone: { triggers: ["enter", "end_turn"] },
  },
  // Level 5 (walls)
  "wall-of-force": { wall: { length: 100, between: true } }, // ten 10-foot panels
  "wall-of-stone": { wall: { length: 100, between: true } },
  // Level 6 (walls)
  "blade-barrier": {
    // "The wall provides Three-Quarters Cover, and its space is Difficult Terrain."
    save: { ability: "dex", on_success: "half" },
    damage: [{ dice: "6d10", type: "force" }],
    wall: { length: 100, cover: "three_quarters", difficult: true },
    zone: { triggers: ["enter", "end_turn"] },
  },
  "wall-of-ice": { wall: { length: 100, between: true } },
  "wall-of-thorns": {
    // 7d8 Piercing when it appears; "For every 1 foot a creature moves through the wall, it must
    // spend 4 feet of movement"; 7d8 Slashing on entering or ending a turn there.
    save: { ability: "dex", on_success: "half" },
    damage: [{ dice: "7d8", type: "piercing" }],
    upcast: { damage: [{ dice: "1d8", type: "piercing" }] },
    wall: { length: 60, cost: 4, later_type: "slashing" },
    zone: { triggers: ["enter", "end_turn"] },
  },
  // Level 8
  "incendiary-cloud": {
    save: { ability: "dex", on_success: "half" },
    damage: [{ dice: "10d8", type: "fire" }],
    area: { shape: "sphere", size: 20 },
    zone: { triggers: ["enter", "end_turn"] },
  },
};

/** Spells whose parsed mechanics were checked by hand against their text, and used as drafted. */
const REVIEWED = new Set<string>([
  "animal-friendship",
  "befuddlement",
  "blight",
  "call-lightning", // the first bolt; calling more with a Magic action stays text
  "charm-monster",
  "charm-person",
  "chill-touch",
  "circle-of-death",
  "color-spray",
  "compulsion",
  "cone-of-cold",
  "disintegrate", // turning to dust at 0 Hit Points stays text
  "dissonant-whispers",
  "entangle",
  "finger-of-death", // rising as a Zombie stays text
  "fire-storm",
  "flesh-to-stone", // Restrained; turning to stone after three failed saves stays text
  "freezing-sphere",
  "harm",
  "hellish-rebuke",
  "hideous-laughter",
  "hold-monster",
  "lightning-bolt",
  "meteor-swarm",
  "mind-spike",
  "phantasmal-killer", // the damage again on a failed repeated save stays text
  "poison-spray",
  "ray-of-frost",
  "ray-of-sickness",
  "sacred-flame",
  "shatter",
  "shocking-grasp",
  "sleep", // Incapacitated; Unconscious after a second failed save stays text
  "starry-wisp",
  "suggestion",
  "sunbeam", // the first Line; new Lines with a Magic action stay text
  "sunburst",
  "thunderwave",
  "vicious-mockery",
  "wind-wall",
]);

/** Drafts the review rejected: the parser reads them, but they're wrong. */
const REJECTED: Record<string, string> = {
  "holy-aura": "the save is made later, by a Fiend or Undead that hits an affected creature",
  "produce-flame": "casting only creates the flame; hurling it is a later Magic action",
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
const drafts = new Map<string, Draft>();
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
    components: field(text, "Components?"), // 13 spells read "Component:"
    duration,
    concentration: duration.startsWith("Concentration"),
    description,
    mechanics: MECHANICS[slug(name.trim())] ?? reviewedDraft(slug(name.trim()), level, description),
  });
}
function reviewedDraft(id: string, level: number, description: string) {
  const draft = parseMechanics(level, description);
  drafts.set(id, draft);
  return REVIEWED.has(id) && "mechanics" in draft ? draft.mechanics : undefined;
}
for (const id of Object.keys(REJECTED)) {
  if (!drafts.has(id)) throw new Error(`REJECTED id unknown: ${id}`);
}
const overlap = [...REVIEWED].filter((id) => id in MECHANICS || id in REJECTED);
if (overlap.length) throw new Error(`REVIEWED ids also in MECHANICS or REJECTED: ${overlap}`);
const unknownReviewed = [...REVIEWED].filter((id) => !drafts.has(id));
const notDrafted = [...REVIEWED].filter((id) => {
  const draft = drafts.get(id);
  return draft && !("mechanics" in draft);
});
if (unknownReviewed.length || notDrafted.length) {
  throw new Error(
    `REVIEWED ids unknown or without a draft: ${[...unknownReviewed, ...notDrafted]}`,
  );
}
if (process.argv.includes("--report")) {
  for (const [id, draft] of [...drafts].sort(([a], [b]) => a.localeCompare(b))) {
    if (id in MECHANICS) continue;
    const rejected = REJECTED[id];
    const mark = rejected
      ? "rej "
      : "mechanics" in draft
        ? REVIEWED.has(id)
          ? "ok  "
          : "NEW "
        : "skip";
    const what = rejected ?? ("mechanics" in draft ? JSON.stringify(draft.mechanics) : draft.skip);
    console.log(`${mark} ${id.padEnd(30)} ${what}`);
  }
  process.exit(0);
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
