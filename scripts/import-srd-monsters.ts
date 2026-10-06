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
 * (damage, half on a success, conditions on a failure, the area or range) become `attack` and
 * `save`, actions that cast spells `casts`; everything else stays in the SRD text. Checked by
 * tests/monsters.test.ts (invariants for every stat block, and golden stat blocks compared field
 * by field with the Markdown).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";

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
  castings: 0,
  castsAsText: [] as string[],
  attacks: 0,
  attacksWithDamage: 0,
  saves: 0,
  traits: 0,
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
      // Who it affects: "each creature in a 60-foot Cone", "…in a 30-foot-long, 5-foot-wide
      // Line", "…in a 20-foot-radius Sphere centered on a point … within 90 feet", "…in a
      // 10-foot Emanation originating from…"; "one creature … within 30 feet" gives a range.
      const head = text.slice(save.index, text.indexOf("_Failure", save.index) >>> 0);
      const shape =
        /in an? (\d+)-foot(?:-long, (\d+)-foot-wide|-radius)? (Cone|Line|Sphere|Emanation|Cube)\b/.exec(
          head,
        );
      const within = /within (\d+) feet/.exec(head);
      action.save = {
        ability: ABILITY[save[1] as string],
        dc: Number(save[2]),
        damage,
        on_success: success && damage.length ? "half" : "none",
        conditions,
        area: shape
          ? {
              shape: (shape[3] as string).toLowerCase(),
              size: Number(shape[1]),
              ...(shape[2] ? { width: Number(shape[2]) } : {}),
            }
          : null,
        range: within ? Number(within[1]) : null,
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
  // Multiattack: the attacks it makes, summed from its first sentence ("makes two Claw attacks
  // and one Bite attack": 3); `null` when it isn't a plain count (Hydra: one per head).
  const multiattack = sections
    .get("Actions")
    ?.join("\n")
    .match(/\*\*_Multiattack\._\*\* ([^.]*)\./)?.[1];
  if (multiattack) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 } as Record<string, number>;
    const counts = [
      ...multiattack.matchAll(/\b(one|two|three|four|five|six)\b (?:[\w'-]+ ){0,3}?attacks?\b/g),
    ];
    const total = counts.reduce((sum, m) => sum + (words[m[1] as string] ?? 0), 0);
    monster.multiattack = total || null;
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
  legendary(monster, where);
  spellcasting(monster, where);
  traitMechanics(monster);
  return monster;
}

/**
 * Legendary actions and Legendary Resistance as data: uses per round ("Legendary Action Uses: 3
 * (4 in Lair)") and per day ("Legendary Resistance (3/Day, or 4/Day in Lair)"); for each
 * legendary action, whether it's once per round, the attacks it makes ("makes one Rend attack",
 * "one Claw or Tail attack") and the action it uses ("uses Lightning Strike").
 */
function legendary(monster: Record<string, unknown>, where: string): void {
  const text = (monster.legendary_text as string | undefined) ?? "";
  const uses = /^Legendary Action Uses: (\d+)(?: \((\d+) in Lair\))?/.exec(text);
  const actions = (monster.legendary_actions as Action[] | undefined) ?? [];
  if (actions.length && !uses) throw new Error(`${where}: can't read the Legendary Action Uses`);
  if (uses)
    monster.legendary_uses = { uses: Number(uses[1]), in_lair: uses[2] ? Number(uses[2]) : null };
  const resistance = ((monster.traits as Action[] | undefined) ?? [])
    .map((t) => /^Legendary Resistance \((\d+)\/Day(?:, or (\d+)\/Day in Lair)?\)$/.exec(t.name))
    .find(Boolean);
  if (resistance) {
    monster.legendary_resistance = {
      uses: Number(resistance[1]),
      in_lair: resistance[2] ? Number(resistance[2]) : null,
    };
  }
  const own = [
    ...((monster.actions as Action[] | undefined) ?? []),
    ...((monster.bonus_actions as Action[] | undefined) ?? []),
  ].map((a) => a.name);
  // "Grave Strike" matches the action "Grave Strike (Vampire Form Only)".
  const named = (name: string) =>
    own.find((n) => n === name || n.startsWith(`${name} (`)) ??
    fail(`${where}: a legendary action names '${name}', which isn't one of its actions`);
  function fail(message: string): never {
    throw new Error(message);
  }
  for (const action of actions) {
    action.once_per_round = /can't take this action again until the start of its next turn/.test(
      action.text,
    );
    const attack = /makes one ([\w' ]+?) attack\b/.exec(action.text);
    if (attack) action.attacks = (attack[1] as string).split(" or ").map(named);
    const used = /\buses ([A-Z][\w' -]+?)(?: and|\.|,)/.exec(action.text);
    // "uses Spellcasting to cast Fear" stays text (monster spellcasting isn't modeled yet).
    if (used && !used[1]?.startsWith("Spellcasting")) action.uses = named(used[1] as string);
  }
}

/** Catalog spell ids by lowercase name ("Acid Arrow" → `acid-arrow`). */
const SPELLS = new Map(
  (
    parse(readFileSync(join(root, "content/srd-5.2.1/spells.yaml"), "utf-8")) as {
      id: string;
      name: string;
    }[]
  ).map((s) => [s.name.toLowerCase(), s.id]),
);
/** Spell names the SRD Markdown misspells in stat blocks, with the catalog name. */
const SPELL_NAME_FIXES: Record<string, string> = {
  "long-strider": "longstrider", // the Druid's list; the spell is "Longstrider" in "Spells"
};
const ABILITY_NAME = /^(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma)$/;
/**
 * "using Charisma as the spellcasting ability (spell save DC 17, +9 to hit with spell attacks)",
 * or "using the same spellcasting ability as Spellcasting" (`same`).
 */
const USING =
  /using (?:(the same spellcasting ability as Spellcasting)|(\w+) as (?:the )?spell-?casting ability)(?: \((?:spell save DC (\d+))?(?:, )?(?:([+−-]\d+) to hit with spell attacks)?\))?/;

type SpellEntry = { spell: string; level: number | null; per_day: number | null; note: string };
type Casting = {
  ability: string;
  save_dc: number | null;
  attack_bonus: number | null;
  spells: SpellEntry[];
};

/**
 * "_Acid Arrow_ (level 3 version), _Detect Magic_, or _Fear_" → spells, or `null` when an item
 * isn't a plain catalog spell (then the action stays text). Commas inside parentheses (a
 * restriction) don't split; "on itself" becomes the note "self only".
 */
function spellItems(list: string, per_day: number | null): SpellEntry[] | null {
  const items: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of list.replace(/_/g, "")) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      items.push(current);
      current = "";
    } else current += ch;
  }
  items.push(current);
  const out: SpellEntry[] = [];
  // "_Bless, Healing Word,_ or _Sanctuary,_ using…": a trailing comma leaves an empty item.
  for (const raw of items.filter((x) => x.trim())) {
    // "_Counterspell_ or _Shield_": "or" joins two spells without a comma.
    for (const piece of raw
      .trim()
      .replace(/^or /, "")
      .split(/ or (?![^(]*\))/)) {
      const m = /^([A-Z][\w'’ /-]*?)(?: \(([^)]*)\))?( on itself)?$/.exec(piece.trim());
      const name = m ? (m[1] as string).toLowerCase().replace(/’/g, "'") : "";
      const id = m && SPELLS.get(SPELL_NAME_FIXES[name] ?? name);
      if (!m || !id) return null;
      const level = /^level (\d) version$/.exec(m[2] ?? "");
      const note = [level ? "" : (m[2] ?? ""), m[3] ? "self only" : ""].filter(Boolean).join("; ");
      out.push({ spell: id, level: level ? Number(level[1]) : null, per_day, note });
    }
  }
  return out;
}

/**
 * Spells as data (SRD "Spellcasting": "a spell of level 1 or higher is always cast at its lowest
 * possible level and can't be cast at a higher level"):
 * - the Spellcasting action's lists ("**At Will:**", "**1/Day Each:**"), with its ability, save DC
 *   and attack bonus;
 * - other actions that cast spells ("The priest casts _Bless_, _Healing Word_, or _Sanctuary_,
 *   using the same spellcasting ability as Spellcasting"), whose "(2/Day)" is `per_day`;
 * - legendary actions that "use Spellcasting to cast _Fear_".
 * Anything else that casts a spell (twice, or with a condition the sentence adds) stays text and
 * is listed by `--report`. A Multiattack's "replace one attack with a use of Spellcasting" stays
 * text too.
 */
/**
 * Traits that act in combat, read from their exact SRD sentences: Death Burst ("explodes when it
 * dies", with its parsed save), damage auras ("At the end of each of the azer's turns, each
 * creature … in a 5-foot Emanation … takes 5 (1d10) Fire damage"), Regeneration, and Aura of
 * Authority's Advantage. Anything worded otherwise stays text.
 */
function traitMechanics(monster: Record<string, unknown>): void {
  for (const trait of (monster.traits as Action[] | undefined) ?? []) {
    const text = trait.text;
    if (/explodes when it dies/.test(text) && trait.save) {
      trait.trigger = "death";
      stats.traits++;
    }
    const aura =
      /^At the end of each of the [\w' -]+?'s turns, each creature (of the [\w' -]+?'s choice )?in a (\d+)-foot Emanation originating from the [\w' -]+? takes (\d+) \((\d+d\d+(?: [+−-] \d+)?)\) (\w+) damage( unless the [\w' -]+? has the Incapacitated condition)?\./.exec(
        text,
      );
    if (aura) {
      trait.aura = {
        size: Number(aura[2]),
        damage: damageParts(`${aura[3]} (${aura[4]}) ${aura[5]} damage`),
        choice: !!aura[1],
        not_incapacitated: !!aura[6],
      };
      stats.traits++;
    }
    const regen =
      /regains (\d+) Hit Points at the start of each of its turns\. If the [\w' -]+? takes ([\w ]+?) damage, this trait doesn't function on the [\w' -]+?'s next turn\. The [\w' -]+? dies only if it starts its turn with 0 Hit Points/.exec(
        text,
      );
    if (regen) {
      trait.regeneration = {
        amount: Number(regen[1]),
        stopped_by: (regen[2] as string).toLowerCase().split(/ or |, /),
      };
      stats.traits++;
    }
    const authority =
      /^While in a (\d+)-foot Emanation originating from the [\w' -]+?, the [\w' -]+? and its allies have Advantage on attack rolls and saving throws/.exec(
        text,
      );
    if (authority) {
      trait.advantage_aura = { size: Number(authority[1]) };
      stats.traits++;
    }
  }
}

function spellcasting(monster: Record<string, unknown>, where: string): void {
  const sections = ["traits", "actions", "bonus_actions", "reactions", "legendary_actions"];
  const all = sections.flatMap((k) => (monster[k] as Action[] | undefined) ?? []);
  for (const action of all) {
    const perDay = /\((\d+)\/Day(?:;[^)]*)?\)$/.exec(action.name);
    if (perDay && !action.name.startsWith("Legendary Resistance"))
      action.per_day = Number(perDay[1]);
  }
  const main = all.find((a) => a.name === "Spellcasting");
  const using = (text: string): Omit<Casting, "spells"> | null => {
    const u = USING.exec(text);
    if (!u) return null;
    if (u[1]) {
      const from = main?.casts as Casting | undefined;
      if (!from)
        throw new Error(`${where}: "the same spellcasting ability as Spellcasting" without one`);
      return { ability: from.ability, save_dc: from.save_dc, attack_bonus: from.attack_bonus };
    }
    if (!ABILITY_NAME.test(u[2] as string))
      throw new Error(`${where}: spellcasting ability '${u[2]}'`);
    return {
      ability: ABILITY[u[2] as string] as string,
      save_dc: u[3] ? Number(u[3]) : null,
      attack_bonus: u[4] ? int(u[4]) : null,
    };
  };
  // The Spellcasting action first: the others refer to it.
  if (main) {
    const [intro, ...lists] = main.text.split("\n").filter((l) => l.trim());
    const how = using(intro ?? "");
    if (!how || !/casts one of the following spells/.test(intro ?? "")) {
      throw new Error(`${where}: can't read the Spellcasting action`);
    }
    const spells = lists.flatMap((line) => {
      const m = /^\*\*(At Will|(\d)\/Day( Each)?):\*\* (.+)$/.exec(line.trim());
      if (!m) throw new Error(`${where}: Spellcasting line '${line}'`);
      const items = spellItems(m[4] as string, m[2] ? Number(m[2]) : null);
      if (!items) throw new Error(`${where}: a Spellcasting spell isn't in the catalog: '${m[4]}'`);
      if (m[2] && !m[3] && items.length > 1) throw new Error(`${where}: shared uses in '${line}'`);
      return items;
    });
    main.casts = { ...how, spells };
    stats.castings++;
  }
  for (const action of all) {
    if (action === main || action.name === "Multiattack") continue;
    if (!/\bcasts? _/.test(action.text)) continue;
    const viaSpellcasting =
      /uses Spellcasting to cast (_[^_]+_(?: \(level \d version\))?)( on itself)?/.exec(
        action.text,
      );
    let casting: Casting | null = null;
    if (viaSpellcasting && main) {
      const spells = spellItems(`${viaSpellcasting[1]}${viaSpellcasting[2] ?? ""}`, null);
      const from = main.casts as Casting;
      if (spells) casting = { ...from, spells };
    } else {
      // "The priest casts _Bless_, … or _Sanctuary_, [requiring no … components,] using …"
      const m =
        /casts (.+?),?(?: in response to the spell's trigger)?,? (?:requiring no [\w ]+? components,? (?:and )?)?using /.exec(
          action.text,
        );
      const how = m && using(action.text);
      const spells = m && spellItems(m[1] as string, null);
      if (how && spells) casting = { ...how, spells };
    }
    if (casting) {
      action.casts = casting;
      stats.castings++;
    } else stats.castsAsText.push(`${where}: ${action.name}`);
  }
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
  console.log(`traits that act in combat (death bursts, auras, regeneration): ${stats.traits}`);
  console.log(`spellcasting actions as data: ${stats.castings}`);
  console.log(`actions that cast spells left as text: ${stats.castsAsText.length}`);
  for (const line of stats.castsAsText) console.log(`  ${line}`);
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
