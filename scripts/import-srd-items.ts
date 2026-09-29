/**
 * Generate `content/srd-5.2.1/magic-items.yaml` and `conditions.yaml` from the SRD 5.2.1
 * Markdown in `docs/srd-5.2.1/` (git-ignored; see DATA-SOURCES.md).
 *
 *   npm run content:import-items
 *   npm run content                  # validate + rebuild the bundled JSON and schemas
 *
 * Text is the SRD's. Everything mechanical the engine uses is parsed from the item headers
 * (category, rarity, Attunement, base item) or comes from the MECHANICS / CONDITIONS overlay
 * tables below; change those, not the generated YAML, since a rerun overwrites it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

const root = join(import.meta.dirname, "..");
const read = (file: string) => readFileSync(join(root, "docs/srd-5.2.1", file), "utf-8");

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/\+(\d)/g, "$1")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const clean = (text: string) =>
  text
    .replace(/’/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

type Item = Record<string, unknown> & { id: string; name: string };

// --- mechanics overlay ------------------------------------------------------------------------

const DAMAGE_TYPES = [
  "acid",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "poison",
  "psychic",
  "radiant",
  "thunder",
];
const resistVariants = (types: string[]) =>
  types.map((t) => ({
    id: t,
    name: t[0]?.toUpperCase() + t.slice(1),
    grants: { resistances: [t] },
  }));
const floor = (ability: string, score: number) => ({
  effects: [{ target: `score.${ability}`, op: "max", value: score }],
});

/** Mechanics the headers don't give, keyed by item id. Merged over the parsed item. */
const MECHANICS: Record<string, Partial<Item>> = {
  "amulet-of-health": { grants: floor("con", 19) },
  "gauntlets-of-ogre-power": { grants: floor("str", 19) },
  "headband-of-intellect": { grants: floor("int", 19) },
  "ring-of-protection": {
    grants: {
      effects: [
        { target: "ac", value: 1 },
        { target: "saves", value: 1 },
      ],
    },
  },
  "cloak-of-protection": {
    grants: {
      effects: [
        { target: "ac", value: 1 },
        { target: "saves", value: 1 },
      ],
    },
  },
  "bracers-of-defense": {
    grants: { effects: [{ target: "ac", value: 2, when: "unarmored" }] },
  },
  "stone-of-good-luck-luckstone": {
    active_when: "carried",
    grants: {
      effects: [
        { target: "saves", value: 1 },
        { target: "checks", value: 1 },
      ],
    },
  },
  "robe-of-stars": { grants: { effects: [{ target: "saves", value: 1 }] } },
  "luck-blade": { grants: { effects: [{ target: "saves", value: 1 }] } },
  "scarab-of-protection": {
    active_when: "carried",
    grants: { effects: [{ target: "ac", value: 1 }] },
  },
  "demon-armor": { bonus: { ac: 1 }, grants: { languages: ["abyssal"] } },
  "dwarven-plate": { bonus: { ac: 2 } },
  "elven-chain": { bonus: { ac: 1 } },
  "glamoured-studded-leather": { bonus: { ac: 1 } },
  "dragon-scale-mail": { bonus: { ac: 1 }, variants: resistVariants(DAMAGE_TYPES.slice(0, 5)) },
  "shield-of-the-cavalier": { bonus: { ac: 2 } },
  "armor-of-invulnerability": { grants: { resistances: ["bludgeoning", "piercing", "slashing"] } },
  "armor-of-resistance": { variants: resistVariants(DAMAGE_TYPES) },
  "ring-of-resistance": { variants: resistVariants(DAMAGE_TYPES) },
  "potion-of-resistance": { variants: resistVariants(DAMAGE_TYPES) },
  "brooch-of-shielding": { grants: { resistances: ["force"] } },
  "boots-of-the-winterlands": { grants: { resistances: ["cold"] } },
  "staff-of-fire": { grants: { resistances: ["fire"] } },
  "staff-of-frost": { grants: { resistances: ["cold"] } },
  "boots-of-striding-and-springing": {
    grants: { effects: [{ target: "speed", op: "max", value: 30 }] },
  },
  "mithral-armor": { ignores_armor_penalties: true },
  "berserker-axe": { grants: { effects: [{ target: "hp_per_level", value: 1 }] } },
  // Staffs and rods that are magic Quarterstaffs or Maces.
  "staff-of-power": {
    base: { kind: "weapon", ids: ["quarterstaff"] },
    bonus: { attack: 2, damage: 2 },
  },
  "staff-of-striking": {
    base: { kind: "weapon", ids: ["quarterstaff"] },
    bonus: { attack: 3, damage: 3 },
  },
  "staff-of-the-magi": {
    base: { kind: "weapon", ids: ["quarterstaff"] },
    bonus: { attack: 2, damage: 2 },
  },
  "staff-of-the-woodlands": {
    base: { kind: "weapon", ids: ["quarterstaff"] },
    bonus: { attack: 2, damage: 2 },
  },
  "staff-of-thunder-and-lightning": {
    base: { kind: "weapon", ids: ["quarterstaff"] },
    bonus: { attack: 2, damage: 2 },
  },
  "rod-of-lordly-might": {
    base: { kind: "weapon", ids: ["mace"] },
    bonus: { attack: 3, damage: 3 },
  },
};

// Rolls, from each condition's "Attacks Affected", "Saving Throws Affected" and "Automatic
// Critical Hits" entries (SRD 5.2.1 Rules Glossary).
const ADV = "advantage";
const DIS = "disadvantage";
const STR_DEX_FAIL = { fail_saves: ["str", "dex"] };
const CONDITIONS: Record<string, Partial<Item>> = {
  blinded: { attack_rolls: DIS, attacked: ADV, attacked_beyond_5ft: ADV },
  // "while the source of fear is within line of sight": applied as if it were.
  frightened: { attack_rolls: DIS, ability_checks: DIS },
  grappled: { speed_zero: true, attack_rolls: DIS, except_against_source: true },
  incapacitated: { initiative: DIS },
  // "If a creature can somehow see you, you don't gain this benefit against that creature."
  invisible: { attack_rolls: ADV, attacked: DIS, attacked_beyond_5ft: DIS, initiative: ADV },
  paralyzed: {
    speed_zero: true,
    implies: ["incapacitated"],
    attacked: ADV,
    attacked_beyond_5ft: ADV,
    critical_within_5ft: true,
    ...STR_DEX_FAIL,
  },
  petrified: {
    speed_zero: true,
    implies: ["incapacitated"],
    attacked: ADV,
    attacked_beyond_5ft: ADV,
    ...STR_DEX_FAIL,
  },
  poisoned: { attack_rolls: DIS, ability_checks: DIS },
  prone: { attack_rolls: DIS, attacked: ADV, attacked_beyond_5ft: DIS },
  restrained: {
    speed_zero: true,
    attack_rolls: DIS,
    attacked: ADV,
    attacked_beyond_5ft: ADV,
    save_disadvantage: ["dex"],
  },
  stunned: { implies: ["incapacitated"], attacked: ADV, attacked_beyond_5ft: ADV, ...STR_DEX_FAIL },
  unconscious: {
    speed_zero: true,
    implies: ["incapacitated", "prone"],
    attacked: ADV,
    attacked_beyond_5ft: ADV,
    critical_within_5ft: true,
    ...STR_DEX_FAIL,
  },
  exhaustion: { levels: true },
};

// --- magic items -------------------------------------------------------------------------------

const CATEGORY: Record<string, string> = {
  Armor: "armor",
  Weapon: "weapon",
  Potion: "potion",
  Ring: "ring",
  Rod: "rod",
  Scroll: "scroll",
  Staff: "staff",
  Wand: "wand",
  "Wondrous Item": "wondrous",
};
const CLASSES = [
  "barbarian",
  "bard",
  "cleric",
  "druid",
  "fighter",
  "monk",
  "paladin",
  "ranger",
  "rogue",
  "sorcerer",
  "warlock",
  "wizard",
];

/** `Armor (Any Light, Medium, or Heavy)` → the base-item filter. */
function parseBase(category: string, inside: string | undefined) {
  if (!inside) return null;
  if (category === "Armor") {
    if (/shield/i.test(inside)) return { kind: "shield" };
    const except = [...inside.matchAll(/Except ([\w ]+)/g)].map((m) => slug(m[1] as string));
    const any = /^Any /.test(inside);
    if (any) {
      const categories = ["light", "medium", "heavy"].filter((c) =>
        new RegExp(c, "i").test(inside),
      );
      return { kind: "armor", categories, except };
    }
    return { kind: "armor", ids: inside.split(/, (?:or )?| or /).map(slug) };
  }
  if (category === "Weapon") {
    if (/Ammunition/.test(inside)) return { kind: "ammunition" };
    if (/^Any Melee/.test(inside)) {
      return { kind: "weapon", categories: ["simple", "martial"], weapon_kind: "melee" };
    }
    if (/^Any/.test(inside)) return { kind: "weapon", categories: ["simple", "martial"] };
    return { kind: "weapon", ids: inside.split(/, (?:or )?| or /).map(slug) };
  }
  return null;
}

function magicItems(): Item[] {
  const md = read("magic-items.md");
  const body = md.slice(md.indexOf("## Magic Items A–Z"));
  const HEADER =
    /^_(Armor|Weapon|Potion|Ring|Rod|Scroll|Staff|Wand|Wondrous Item)(?: \(([^)]*)\))?, ([^_]*?)_/;
  // Sections that aren't items (stat blocks inside one) belong to the previous item.
  const sections: string[] = [];
  for (const section of body.split(/\n#### /).slice(1)) {
    const text = section.split("\n").slice(1).join("\n").trim();
    if (HEADER.test(text) || !sections.length) sections.push(section);
    else sections[sections.length - 1] += `\n\n#### ${section}`;
  }
  const items: Item[] = [];
  for (const section of sections) {
    const [name = "", ...rest] = section.split("\n");
    const text = rest.join("\n").trim();
    const m = HEADER.exec(text);
    if (!m) throw new Error(`Can't parse ${name}`);
    const [, cat = "", inside, tail = ""] = m;
    const description = clean(text.slice(m[0].length));
    const attunement = /Requires Attunement/.test(tail);
    const by = /Requires Attunement by (an? )?([^)]*)\)/.exec(tail)?.[2] ?? null;
    const item: Item = {
      id: slug(name.trim()),
      name: name.trim(),
      category: CATEGORY[cat] as string,
      rarity: tail.replace(/\s*\(Requires Attunement[^)]*\)/, "").trim(),
      attunement,
      description,
    };
    if (by) {
      item.attunement_by = by;
      item.attunement_classes = CLASSES.filter((c) => new RegExp(`\\b${c}\\b`, "i").test(by));
      if (/Spellcaster/i.test(by)) item.attunement_spellcaster = true;
    }
    const base = parseBase(cat, inside) as Record<string, unknown> | null;
    if (base) {
      if (base.ids) base.ids = (base.ids as string[]).filter((id) => id !== "");
      item.base = base;
    }
    if (base?.kind === "ammunition") item.category = "ammunition";
    const plus =
      /a \+(\d) bonus to attack rolls and damage rolls made with this (?:magic weapon|weapon)/.exec(
        description,
      );
    if (plus) item.bonus = { attack: Number(plus[1]), damage: Number(plus[1]) };
    const charges = /has (\d+) charges/.exec(description);
    if (charges) item.charges = Number(charges[1]);
    if (["potion", "scroll"].includes(item.category as string) || base?.kind === "ammunition") {
      item.consumable = true;
    }
    items.push(...expand(item));
  }
  return items.map((i) => ({ ...i, ...(MECHANICS[i.id] ?? {}) }));
}

/** Items that come in versions: "+1, +2, or +3", Belts of Giant Strength, Potions of Healing. */
function expand(item: Item): Item[] {
  const plus = /^(.*), \+1, \+2, or \+3$/.exec(item.name);
  if (plus) {
    const rarities = [...(item.rarity as string).matchAll(/(\w[\w ]*?) \(\+(\d)\)/g)];
    return rarities.map((r) => {
      const n = Number(r[2]);
      const bonus: Record<string, number> = {};
      if (item.category === "armor") bonus.ac = n;
      else if (item.category === "wand") bonus.spell_attack = n;
      else {
        bonus.attack = n;
        bonus.damage = n;
      }
      return {
        ...item,
        id: slug(`${plus[1]} ${n}`),
        name: `${plus[1]}, +${n}`,
        rarity: (r[1] as string).replace(/^or /, ""),
        bonus,
      };
    });
  }
  if (item.id === "belt-of-giant-strength") {
    const kinds: [string, number, string][] = [
      ["hill", 21, "Rare"],
      ["frost or stone", 23, "Very Rare"],
      ["fire", 25, "Very Rare"],
      ["cloud", 27, "Legendary"],
      ["storm", 29, "Legendary"],
    ];
    return kinds.map(([kind, score, rarity]) => ({
      ...item,
      id: slug(`belt of giant strength ${kind}`),
      name: `Belt of Giant Strength (${kind})`,
      rarity,
      grants: floor("str", score),
    }));
  }
  if (item.id === "potions-of-healing") {
    const kinds: [string, string, string][] = [
      ["", "2d4+2", "Common"],
      [" (greater)", "4d4+4", "Uncommon"],
      [" (superior)", "8d4+8", "Rare"],
      [" (supreme)", "10d4+20", "Very Rare"],
    ];
    return kinds.map(([kind, heal, rarity]) => ({
      ...item,
      id: slug(`potion of healing${kind}`),
      name: `Potion of Healing${kind}`,
      rarity,
      heal,
    }));
  }
  return [item];
}

// --- conditions --------------------------------------------------------------------------------

function conditions(): Item[] {
  const md = read("rules-glossary.md");
  const names = [
    "Blinded",
    "Charmed",
    "Deafened",
    "Exhaustion",
    "Frightened",
    "Grappled",
    "Incapacitated",
    "Invisible",
    "Paralyzed",
    "Petrified",
    "Poisoned",
    "Prone",
    "Restrained",
    "Stunned",
    "Unconscious",
  ];
  return names.map((name) => {
    const m = new RegExp(
      `\\n#### ${name}(?: \\[[^\\]]*\\])?\\n(.*?)(?=\\n#### |\\n### |$)`,
      "s",
    ).exec(md);
    if (!m) throw new Error(`No condition ${name}`);
    const id = slug(name);
    return { id, name, description: clean(m[1] as string), ...(CONDITIONS[id] ?? {}) };
  });
}

const header = (schema: string, what: string) =>
  `# yaml-language-server: $schema=../../schemas/${schema}.schema.json\n` +
  `# SRD 5.2.1 — ${what}. Generated by scripts/import-srd-items.ts; mechanics are in its overlay tables.\n`;

const items = magicItems();
writeFileSync(
  join(root, "content/srd-5.2.1/magic-items.yaml"),
  header("magic_items", '"Magic Items A–Z"') + stringify(items, { lineWidth: 100 }),
);
const conds = conditions();
writeFileSync(
  join(root, "content/srd-5.2.1/conditions.yaml"),
  header("conditions", '"Rules Glossary" conditions') + stringify(conds, { lineWidth: 100 }),
);
console.log(`wrote ${items.length} magic items, ${conds.length} conditions`);
