/**
 * Generate `content/srd-5.2.1/gear.yaml` and add prices and weights to `tools.yaml`, from the
 * SRD 5.2.1 Markdown in `docs/srd-5.2.1/equipment.md` (git-ignored; see DATA-SOURCES.md).
 *
 *   npx tsx scripts/import-srd-gear.ts
 *   npm run content                  # validate + rebuild the bundled JSON and schemas
 *
 * Gear comes from the Adventuring Gear table (name, weight, cost) and the Ammunition and focus
 * tables, with each item's text from its section. Entries already in gear.yaml that the tables
 * don't name (starting-equipment placeholders, book variants) are kept, with a price from
 * `PRICED_AS` when they stand for a listed item. Potions and Spell Scrolls are magic items.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

const root = join(import.meta.dirname, "..");
const md = readFileSync(join(root, "docs/srd-5.2.1/equipment.md"), "utf-8");
const gearPath = join(root, "content/srd-5.2.1/gear.yaml");
const toolsPath = join(root, "content/srd-5.2.1/tools.yaml");

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
/** `Clothes, Traveler's` → `Traveler's Clothes` (the SRD lists some items noun first). */
const natural = (name: string) => {
  const m = /^([^,(]+), ([^(]+)$/.exec(name);
  return m ? `${m[2]?.trim()} ${m[1]?.trim()}` : name;
};
const clean = (text: string) => text.replace(/’/g, "'").replace(/\s+/g, " ").trim();
const none = (s: string) => (s === "—" ? "" : s);

/** Rows of the first table after a bold title. */
function table(title: string): string[][] {
  const i = md.indexOf(`**${title}**`);
  if (i < 0) throw new Error(`no table ${title}`);
  const j = md.indexOf("</table>", i);
  return [...md.slice(i, j).matchAll(/<tr>\s*((?:<td>[\s\S]*?<\/td>\s*)+)<\/tr>/g)].map((m) =>
    [...(m[1] as string).matchAll(/<td>([\s\S]*?)<\/td>/g)].map((c) => clean(c[1] as string)),
  );
}

/** Each gear section's text, by the name in its heading (`#### Rope (1 GP)`). */
const start = md.indexOf("## Adventuring Gear");
const end = md.indexOf("## Mounts and Vehicles");
const texts = new Map<string, string>();
for (const m of md
  .slice(start, end)
  .matchAll(/^#### (.+?) \((?:[^)]*)\)\n\n([\s\S]*?)(?=\n#### |\n\*\*|$)/gm)) {
  texts.set(m[1] as string, clean(m[2] as string));
}

const SKIP = new Set([
  "Ammunition",
  "Arcane Focus",
  "Druidic Focus",
  "Holy Symbol",
  "Potion of Healing",
]);
type Gear = {
  id: string;
  name: string;
  description?: string;
  cost?: string;
  weight?: string;
  bundle?: number;
  ammunition?: boolean;
};
const generated: Gear[] = [];
for (const [name, weight, cost] of table("Adventuring Gear")) {
  if (!name || SKIP.has(name) || name.startsWith("Spell Scroll")) continue;
  const text = texts.get(name);
  generated.push({
    id: slug(natural(name)),
    name: natural(name),
    ...(text ? { description: text } : {}),
    cost: cost as string,
    ...(none(weight as string) ? { weight: weight as string } : {}),
  });
}
const AMMO: Record<string, string> = {
  Arrows: "arrow",
  Bolts: "crossbow-bolt",
  "Bullets, Firearm": "firearm-bullet",
  "Bullets, Sling": "sling-bullet",
  Needles: "blowgun-needle",
};
for (const [name, amount, , weight, cost] of table("Ammunition")) {
  generated.push({
    id: AMMO[name as string] ?? slug(name as string),
    name: natural(name as string).replace(/s$/, ""),
    cost: cost as string,
    weight: weight as string,
    bundle: Number(amount),
    ammunition: true,
  });
}
for (const [title, prefix] of [
  ["Arcane Focuses", "Arcane Focus"],
  ["Druidic Focuses", "Druidic Focus"],
  ["Holy Symbols", "Holy Symbol"],
] as const) {
  for (const [form, weight, cost] of table(title)) {
    const short = (form as string).replace(/ \(.*\)$/, "");
    generated.push({
      id: slug(`${prefix} ${short}`),
      name: `${prefix} (${short.toLowerCase()})`,
      cost: cost as string,
      ...(none(weight as string) ? { weight: weight as string } : {}),
    });
  }
}

/** Existing ids that stand for a listed item: its price and weight. */
const PRICED_AS: Record<string, string> = {
  "book-history": "book",
  "book-prayers": "book",
  "book-occult-lore": "book",
  "druidic-focus-mistletoe": "druidic-focus-sprig-of-mistletoe",
  "holy-symbol": "holy-symbol-amulet",
  parchment: "parchment",
};

const existing = (parse(readFileSync(gearPath, "utf-8")) ?? []) as Gear[];
const byId = new Map(generated.map((g) => [g.id, g]));
const out: Gear[] = [];
for (const old of existing) {
  const made = byId.get(old.id);
  const priced = PRICED_AS[old.id] ? byId.get(PRICED_AS[old.id] as string) : undefined;
  // Keep the id, name and description it had (packs list their contents); add the price.
  const source = made ?? priced;
  out.push({
    ...old,
    ...(source?.cost ? { cost: source.cost } : {}),
    ...(source?.weight ? { weight: source.weight } : {}),
    ...(source?.bundle ? { bundle: source.bundle } : {}),
    ...(made?.ammunition ? { ammunition: true } : {}),
    ...(made?.description && !old.description ? { description: made.description } : {}),
  });
  byId.delete(old.id);
}
out.push(...[...byId.values()].sort((a, b) => a.id.localeCompare(b.id)));

const header = `# yaml-language-server: $schema=../../schemas/gear.schema.json
# SRD 5.2.1 — "Equipment" > "Adventuring Gear", generated by scripts/import-srd-gear.ts (prices,
# weights, text); entries it doesn't list are kept. Items marked "of your choice" stand in for a
# pick the builder doesn't automate.
`;
writeFileSync(gearPath, header + stringify(out, { lineWidth: 100 }));

// Tools: "**Alchemist's Supplies (50 GP)**" then "**Ability:** … **Weight:** 8 lb.".
const tools = (parse(readFileSync(toolsPath, "utf-8")) ?? []) as {
  id: string;
  name: string;
  cost?: string;
  weight?: string;
}[];
const toolInfo = new Map<string, { cost: string; weight: string }>();
for (const m of md.matchAll(
  /\*\*(.+?) \(([^)]+)\)\*\*\s*\n+\*\*Ability:\*\*[^\n]*?\*\*Weight:\*\* ([^\n]+)/g,
)) {
  toolInfo.set(slug(m[1] as string), { cost: m[2] as string, weight: none(clean(m[3] as string)) });
}
// Variants priced in a list: "Dice (1 SP), dragonchess (1 GP)…".
for (const m of md.matchAll(/\*\*Variants:\*\* ([^\n]+)/g)) {
  for (const v of (m[1] as string).matchAll(/([A-Za-z' -]+?) \(([^)]+)\)/g)) {
    toolInfo.set(slug(v[1] as string), { cost: v[2] as string, weight: "" });
  }
}
const VARIANT_IDS: Record<string, string> = {
  "dice-set": "dice",
  "playing-card-set": "playing-cards",
  "dragonchess-set": "dragonchess",
  "three-dragon-ante-set": "three-dragon-ante",
};
let priced = 0;
for (const t of tools) {
  const info =
    toolInfo.get(t.id) ?? toolInfo.get(VARIANT_IDS[t.id] ?? "") ?? toolInfo.get(slug(t.name));
  if (!info || info.cost === "Varies") continue;
  t.cost = info.cost;
  if (info.weight) t.weight = info.weight;
  priced++;
}
const toolsHeader = readFileSync(toolsPath, "utf-8")
  .split("\n")
  .filter((l) => l.startsWith("#"))
  .join("\n");
writeFileSync(toolsPath, `${toolsHeader}\n${stringify(tools, { lineWidth: 100 })}`);
console.log(`wrote ${out.length} gear items; priced ${priced} of ${tools.length} tools`);
