/**
 * Generate `content/srd-5.2.1/monsters.yaml` from the SRD 5.2.1 Markdown in `docs/srd-5.2.1/`
 * ("Monsters A–Z" and "Animals"; git-ignored, see DATA-SOURCES.md).
 *
 *   npm run content:import-monsters
 *   npx tsx scripts/import-srd-monsters.ts --report   # what was structured, write nothing
 *   npm run content                                   # validate + rebuild the bundled JSON
 *
 * Stat block fields (AC, HP, speed, abilities, saves, defenses, CR…) are parsed exactly; anything
 * unexpected throws, so no field is guessed. In actions, attack rolls and saving throw effects
 * (damage, half on a success, conditions on a failure) become `attack` and `save`; everything
 * else stays in the SRD text. Checked by tests/monsters.test.ts (invariants for every stat block,
 * and golden stat blocks compared field by field with the Markdown).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";

const root = join(import.meta.dirname, "..");
const report = process.argv.includes("--report");

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
/** The SRD writes minus as "−" (U+2212). */
const int = (text: string) => Number(text.replace("−", "-").replace(/,/g, ""));
const clean = (text: string) =>
  text
    .replace(/<br>\s*/g, "\n")
    .replace(/&emsp;/g, "")
    .replace(/’/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const SIZE = "Tiny|Small|Medium|Large|Huge|Gargantuan";
const TYPE_LINE = new RegExp(`^_((?:${SIZE})(?: or (?:${SIZE}))?) (.+), ([^_]+)_$`);
const SECTION = /^#{3,4} (Traits|Actions|Bonus Actions|Reactions|Legendary Actions)\s*$/;
const DAMAGE_TYPES = [
  "acid",
  "bludgeoning",
  "cold",
  "fire",
  "force",
  "lightning",
  "necrotic",
  "piercing",
  "poison",
  "psychic",
  "radiant",
  "slashing",
  "thunder",
];
const CONDITIONS = [
  "blinded",
  "charmed",
  "deafened",
  "exhaustion",
  "frightened",
  "grappled",
  "incapacitated",
  "invisible",
  "paralyzed",
  "petrified",
  "poisoned",
  "prone",
  "restrained",
  "stunned",
  "unconscious",
];
const ABILITY: Record<string, string> = {
  STR: "str",
  DEX: "dex",
  CON: "con",
  INT: "int",
  WIS: "wis",
  CHA: "cha",
  Strength: "str",
  Dexterity: "dex",
  Constitution: "con",
  Intelligence: "int",
  Wisdom: "wis",
  Charisma: "cha",
};

type Action = Record<string, unknown> & { name: string; text: string };

/**
 * Values the SRD Markdown garbles, each checked against the rest of the stat block. Keys are
 * monster ids; the importer applies them to the ability table before validating it.
 */
const FIXES: Record<
  string,
  { scores?: Record<string, number>; saves?: Record<string, number>; why: string }
> = {
  "will-o-wisp": {
    scores: { str: 1 },
    why: "the STR row has only its modifier and save (−5 −5); a −5 modifier means a score of 1",
  },
  "young-white-dragon": {
    saves: { int: -2 },
    why: "the INT save reads 2 with no sign; with a −2 modifier and PB +3 a save can only be −2 or +1, and the minus sign is the one missing",
  },
};
const stats = {
  attacks: 0,
  attacksWithDamage: 0,
  saves: 0,
  unparsedRolls: [] as string[],
  missedRolls: [] as string[],
};

/**
 * `13 (1d10 + 8) Slashing damage plus 5 (2d4) Fire damage` → parts; stops at other text and at
 * damage that depends on something ("…if the attack roll had Advantage").
 */
function damageParts(text: string): Record<string, unknown>[] {
  const parts: Record<string, unknown>[] = [];
  // "…damage plus 5 (2d4) Fire damage", and "…if the target is Grappled—plus 4 (1d8)…" (Mimic).
  for (const piece of text.split(/ plus |—plus /)) {
    const m = /^(\d+)(?: \((\d+d\d+)(?: ([+−-]) (\d+))?\))? (\w+) damage/.exec(piece.trim());
    const type = m?.[5]?.toLowerCase();
    if (!m || !type || !DAMAGE_TYPES.includes(type)) break;
    // "plus 2 (1d4) Slashing damage if the attack roll had Advantage", "…at the start of each
    // turn": conditional or later damage stays in the text.
    if (/^,? (?:if|at|when|while|unless)\b/.test(piece.trim().slice(m[0].length))) break;
    const bonus = m[3] ? int(`${m[3]}${m[4]}`) : 0;
    parts.push({ average: Number(m[1]), dice: m[2] ?? null, bonus, type });
  }
  return parts;
}

function parseAction(name: string, text: string, where: string): Action {
  const action: Action = { name, text };
  const recharge = /\s*\(Recharge ([\d–-]+)\)$/.exec(name);
  if (recharge) {
    action.name = name.slice(0, recharge.index);
    action.recharge = recharge[1];
  }
  // "Melee or _Ranged Attack Roll:_" (misplaced italics), "+17 to hit", "+5 (with Advantage if…)"
  // (the condition stays in the text) and "reach 5 ft or" appear too.
  const attack =
    /(Melee or )?_(Melee|Ranged|Melee or Ranged) Attack Roll:_ ([+−-]\d+)(?: to hit)?(?: \([^)]*\))?,(?: reach (\d+) ft\.?)?(?: or)?(?: range ([\d/]+) ft\.)?/.exec(
      text,
    );
  if (attack) {
    stats.attacks++;
    const hit = /_Hit:_ ([^.]*(?:\.\d[^.]*)*)/.exec(text);
    const damage = hit ? damageParts(hit[1] as string) : [];
    if (damage.length) stats.attacksWithDamage++;
    const kind = { Melee: "melee", Ranged: "ranged", "Melee or Ranged": "melee_or_ranged" };
    action.attack = {
      kind: attack[1] ? "melee_or_ranged" : kind[attack[2] as keyof typeof kind],
      bonus: int(attack[3] as string),
      reach: attack[4] ? Number(attack[4]) : null,
      range: attack[5] ?? null,
      damage,
    };
  }
  const save = /_(\w+) Saving Throw:_ DC (\d+)/.exec(text);
  if (save && !attack) {
    // "First Failure" is what a failed save does; a "Second Failure" comes later (text).
    const failure =
      /_(?:First )?Failure:_ (.*?)(?=_Second Failure:_|_Failure by|_Success:_|_Failure or Success:_|$)/s.exec(
        text,
      )?.[1] ?? "";
    const success = /_Success:_ Half damage/.test(text);
    // Conditions the target gets: sentences where the target gets them ("The target has…", "…
    // damage, and the target has…", "The target is pushed… and has…", "While Poisoned, the
    // target has…"). Left as text: size- or HP-dependent ones ("If the target is Large or
    // smaller, it has…"), states after a special effect ("A swallowed creature has…", "Until the
    // grapple ends…"), and "the Grappled condition ends".
    const sentences = failure
      .split(/(?<=\.)\s+/)
      .filter((x) =>
        /^(?:[^.]*?,? and )?(?:the target|it) (?:is [^.]*? and )?has the |^While [^,]+, the target (?:also )?has the /i.test(
          x,
        ),
      );
    const conditions = [
      ...sentences.join(" ").matchAll(/has the (\w+)(?: and (\w+))? conditions?/g),
    ]
      .flatMap((m) => [m[1], m[2]])
      .filter((c): c is string => c !== undefined)
      .map((c) => c.toLowerCase())
      .filter((c) => CONDITIONS.includes(c));
    const damage = damageParts(failure);
    if (damage.length || conditions.length) {
      stats.saves++;
      action.save = {
        ability: ABILITY[save[1] as string],
        dc: Number(save[2]),
        damage,
        on_success: success && damage.length ? "half" : "none",
        conditions,
      };
    } else stats.unparsedRolls.push(`${where}: ${name} (saving throw with no damage or condition)`);
  }
  return action;
}

/** Paragraphs of a section: `**_Name._** text` starts an action; other paragraphs continue it. */
function parseSection(lines: string[], where: string): { intro: string; actions: Action[] } {
  const paragraphs = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && p !== "<hr>");
  const actions: Action[] = [];
  let intro = "";
  for (const paragraph of paragraphs) {
    const m = /^\*\*_(.+?)\._\*\*\s*([\s\S]*)$/.exec(paragraph);
    if (m) actions.push({ name: m[1] as string, text: clean(m[2] as string) });
    else if (!actions.length) intro = clean(paragraph.replace(/^_|_$/g, ""));
    else {
      const last = actions.at(-1) as Action;
      last.text = `${last.text}\n\n${clean(paragraph)}`;
    }
  }
  return { intro, actions: actions.map((a) => parseAction(a.name, a.text, where)) };
}

function field(head: string, label: string): string | null {
  return new RegExp(`\\*\\*${label}\\*\\* ([^<\\n]+)`).exec(head)?.[1]?.trim() ?? null;
}

function parseBlock(name: string, group: string | null, lines: string[]): Record<string, unknown> {
  const where = name;
  const fail = (what: string): never => {
    throw new Error(`${where}: can't read ${what}`);
  };
  const typeLine = lines.find((l) => TYPE_LINE.test(l.trim())) ?? fail("the size and type line");
  const [, size, creatureType, alignment] = TYPE_LINE.exec(typeLine.trim()) as RegExpExecArray;
  const firstSection = lines.findIndex((l) => SECTION.test(l));
  const head = lines.slice(0, firstSection < 0 ? undefined : firstSection).join("\n");

  // The ability table, read as tokens: after each bold label come its score, modifier and save.
  // (Some tables in the SRD Markdown have merged cells, "+10 +10"; the numbers stay in order.)
  const abilities: Record<string, number> = {};
  const saves: Record<string, number> = {};
  const labels = [...head.matchAll(/<strong>(STR|DEX|CON|INT|WIS|CHA)<\/strong>/g)];
  for (const [n, m] of labels.entries()) {
    const cells = head.slice(
      (m.index ?? 0) + m[0].length,
      labels[n + 1]?.index ?? head.indexOf("</table>"),
    );
    const numbers = (cells.replace(/<[^>]+>/g, " ").match(/[+−-]?\d+/g) ?? []).map(int);
    const ability = ABILITY[m[1] as string] as string;
    const fixed = FIXES[slug(name)]?.scores?.[ability];
    if (fixed !== undefined && numbers.length === 2) numbers.unshift(fixed);
    const [score, modifier, save] = numbers;
    if (score === undefined || save === undefined || modifier !== Math.floor((score - 10) / 2)) {
      fail(`the ${m[1]} row of the ability table`);
    }
    abilities[ability] = score as number;
    saves[ability] = FIXES[slug(name)]?.saves?.[ability] ?? (save as number);
  }
  if (Object.keys(abilities).length !== 6) fail("the ability table");

  const pb = Number(/PB \+(\d+)/.exec(head)?.[1] ?? fail("PB"));
  for (const [ability, save] of Object.entries(saves)) {
    const modifier = Math.floor(((abilities[ability] as number) - 10) / 2);
    if (save !== modifier && save !== modifier + pb) fail(`the ${ability} save (${save})`);
  }
  const ac = /\*\*AC\*\* (\d+)(?: \*\*Initiative\*\* ([+−-]\d+))?/.exec(head) ?? fail("AC");
  const hp = /\*\*HP\*\* (\d+)(?: \((\d+d\d+)(?: ([+−]) (\d+))?\))?/.exec(head) ?? fail("HP");
  const hitDice = hp[2] ? `${hp[2]}${hp[3] ? `${hp[3] === "−" ? "-" : "+"}${hp[4]}` : ""}` : null;

  const speed: Record<string, number> = {};
  const speedNotes: string[] = [];
  let hover = false;
  for (const item of (field(head, "Speed") ?? fail("Speed")).split(/,\s*/)) {
    const m = /^(?:(\w+) )?(\d+) ft\.(?: \(([^)]+)\))?$/.exec(item.trim());
    if (!m) {
      speedNotes.push(item.trim()); // "Climb or Fly 20 ft. (GM's choice)"
      continue;
    }
    // A qualified speed ("40 ft. (bear form only)") isn't the creature's usual one: note it.
    if (m[3] && m[3] !== "hover") {
      speedNotes.push(item.trim());
      continue;
    }
    speed[(m[1] ?? "walk").toLowerCase()] = Number(m[2]);
    if (m[3] === "hover") hover = true;
  }

  const skills: Record<string, number> = {};
  for (const item of (field(head, "Skills") ?? "").split(/,\s*/).filter(Boolean)) {
    const m = /^(.+) ([+−-]\d+)$/.exec(item.trim()) ?? fail(`skill '${item}'`);
    skills[slug(m[1] as string)] = int(m[2] as string);
  }

  // Defenses: damage types, and (after ";" in Immunities) conditions; anything else is a note.
  const notes: string[] = [];
  const defenses = (label: string) => {
    const damage: string[] = [];
    const conditions: string[] = [];
    const text = field(head, label);
    for (const item of (text ?? "").split(/[;,]\s*/).filter(Boolean)) {
      const word = item.replace(/^and /, "").trim().toLowerCase();
      if (DAMAGE_TYPES.includes(word)) damage.push(word);
      else if (CONDITIONS.includes(word)) conditions.push(word);
      else notes.push(`${label}: ${item.trim()}`);
    }
    return { damage, conditions };
  };
  const resistances = defenses("Resistances");
  const vulnerabilities = defenses("Vulnerabilities");
  const immunities = defenses("Immunities");

  const senses = field(head, "Senses") ?? "";
  const passive = /Passive Perception (\d+)/.exec(senses) ?? fail("Passive Perception");
  const cr =
    /\*\*CR\*\* ([\d/]+) \((?:XP )?([\d,]+)(?: XP)?[^;]*; PB \+(\d+)\)/.exec(head) ?? fail("CR");

  const monster: Record<string, unknown> = {
    id: slug(name),
    name,
    group,
    size,
    creature_type: creatureType,
    alignment,
    armor_class: Number(ac[1]),
    // One stat block leaves out Initiative: it's the Dexterity modifier then.
    initiative: ac[2] ? int(ac[2]) : Math.floor(((abilities.dex as number) - 10) / 2),
    hit_points: Number(hp[1]),
    hit_dice: hitDice,
    speed,
    hover,
    speed_note: speedNotes.join("; "),
    abilities,
    saving_throws: saves,
    skills,
    resistances: resistances.damage,
    vulnerabilities: vulnerabilities.damage,
    immunities: immunities.damage,
    condition_immunities: immunities.conditions,
    defenses_note: notes.join("; "),
    gear: field(head, "Gear") ?? "",
    senses,
    passive_perception: Number(passive[1]),
    languages: field(head, "Languages") ?? "",
    cr: cr[1],
    xp: int(cr[2] as string),
    proficiency_bonus: Number(cr[3]),
  };

  // Sections: Traits, Actions, Bonus Actions, Reactions, Legendary Actions.
  let current: string | null = null;
  const sections = new Map<string, string[]>();
  for (const line of lines.slice(firstSection < 0 ? lines.length : firstSection)) {
    const m = SECTION.exec(line);
    if (m) {
      current = m[1] as string;
      sections.set(current, []);
    } else if (current) sections.get(current)?.push(line);
  }
  for (const [section, key] of [
    ["Traits", "traits"],
    ["Actions", "actions"],
    ["Bonus Actions", "bonus_actions"],
    ["Reactions", "reactions"],
    ["Legendary Actions", "legendary_actions"],
  ] as const) {
    const body = sections.get(section);
    if (!body) continue;
    const { intro, actions } = parseSection(body, where);
    monster[key] = actions;
    if (section === "Legendary Actions" && intro) monster.legendary_text = intro;
  }
  return monster;
}

/** Split a file into stat blocks: a heading followed by a size and type line. */
function statBlocks(file: string): Record<string, unknown>[] {
  const lines = readFileSync(join(root, "docs/srd-5.2.1", file), "utf-8").split("\n");
  const heading = (i: number) => /^(#{2,3}) (.+?)\s*$/.exec(lines[i] ?? "");
  const nextContent = (i: number) => {
    let j = i + 1;
    while (j < lines.length && !(lines[j] ?? "").trim()) j++;
    return j;
  };
  const starts: { index: number; name: string; group: string | null }[] = [];
  let group: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const h = heading(i);
    if (!h || SECTION.test(lines[i] as string)) continue;
    const isBlock = TYPE_LINE.test((lines[nextContent(i)] ?? "").trim());
    if (!isBlock && h[1] === "##") group = h[2] as string;
    if (isBlock) {
      const name = h[2] as string;
      starts.push({ index: i, name, group: h[1] === "###" && group !== name ? group : null });
    }
  }
  return starts.flatMap((start, n) => {
    // A block ends at the next heading that isn't one of its sections.
    let end = starts[n + 1]?.index ?? lines.length;
    for (let i = start.index + 1; i < end; i++) {
      if (heading(i) && !SECTION.test(lines[i] as string)) {
        end = i;
        break;
      }
    }
    try {
      const block = lines.slice(start.index + 1, end);
      const monster = parseBlock(start.name, start.group, block);
      const inText = block.join("\n").match(/Attack Roll:_/g)?.length ?? 0;
      const parsed = ["traits", "actions", "bonus_actions", "reactions", "legendary_actions"]
        .flatMap((k) => (monster[k] as Action[] | undefined) ?? [])
        .filter((a) => a.attack).length;
      if (inText !== parsed)
        stats.missedRolls.push(`${start.name}: ${inText} in the text, ${parsed} parsed`);
      return [monster];
    } catch (e) {
      failures.push((e as Error).message);
      return [];
    }
  });
}

const failures: string[] = [];
const monsters = [...statBlocks("monsters-A-Z.md"), ...statBlocks("animals.md")].sort((a, b) =>
  String(a.id).localeCompare(String(b.id)),
);
if (failures.length) throw new Error(`Stat blocks that can't be read:\n${failures.join("\n")}`);
const ids = monsters.map((m) => m.id as string);
const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
if (duplicates.length) throw new Error(`duplicate monster ids: ${duplicates.join(", ")}`);

if (report) {
  console.log(`${monsters.length} stat blocks`);
  console.log(`attack rolls: ${stats.attacks} (${stats.attacksWithDamage} with damage parsed)`);
  console.log(`saving throw effects: ${stats.saves}`);
  console.log(`stat blocks where attack rolls were missed: ${stats.missedRolls.length}`);
  for (const line of stats.missedRolls) console.log(`  ${line}`);
  console.log(`saving throws left as text: ${stats.unparsedRolls.length}`);
  for (const line of stats.unparsedRolls) console.log(`  ${line}`);
  const noted = monsters.filter((m) => m.defenses_note);
  console.log(`defenses kept as a note: ${noted.length}`);
  for (const m of noted) console.log(`  ${m.id}: ${m.defenses_note}`);
  process.exit(0);
}

const header =
  "# yaml-language-server: $schema=../../schemas/monsters.schema.json\n" +
  `# SRD 5.2.1 — "Monsters A–Z" and "Animals".\n` +
  "# Generated by scripts/import-srd-monsters.ts from docs/srd-5.2.1/; edit the script, not this file.\n";
writeFileSync(
  join(root, "content/srd-5.2.1/monsters.yaml"),
  header + stringify(monsters, { lineWidth: 100 }),
);
console.log(`wrote ${monsters.length} monsters`);
