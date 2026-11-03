/**
 * Reads a stat block's action in the SRD 5.2.1 style ("_Melee Attack Roll:_ +4, reach 5 ft.
 * _Hit:_ 5 (1d6 + 2) Slashing damage", "_Dexterity Saving Throw:_ DC 13 … _Failure:_ …") into
 * `attack` and `save` data. Used by import-srd-monsters.ts, and usable by any importer that
 * writes actions in the same style.
 */

/** The SRD writes minus as "−" (U+2212). */
export const int = (text: string) => Number(text.replace("−", "-").replace(/,/g, ""));

export const DAMAGE_TYPES = [
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
export const CONDITIONS = [
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
export const ABILITY: Record<string, string> = {
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

export type Action = Record<string, unknown> & { name: string; text: string };

export const stats = {
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
export function damageParts(text: string): Record<string, unknown>[] {
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

export function parseAction(name: string, text: string, where: string): Action {
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

/**
 * Traits that act in combat, read from their exact SRD sentences: Magic Resistance, Pack Tactics,
 * Death Burst ("explodes when it dies", with its parsed save), damage auras ("At the end of each of the azer's turns, each
 * creature … in a 5-foot Emanation … takes 5 (1d10) Fire damage"), Regeneration, and Aura of
 * Authority's Advantage. Anything worded otherwise stays text.
 */
export function traitMechanics(monster: Record<string, unknown>): number {
  let read = 0;
  for (const trait of (monster.traits as Action[] | undefined) ?? []) {
    const text = trait.text;
    if (/explodes when it dies/.test(text) && trait.save) {
      trait.trigger = "death";
      read++;
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
      read++;
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
      read++;
    }
    // Magic Resistance: "has Advantage on saving throws against spells and other magical effects."
    if (/has Advantage on saving throws against spells and other magical effects\.$/.test(text)) {
      trait.save_advantage = "magic";
      read++;
    }
    // Pack Tactics: "has Advantage on (?:an attack roll|attack rolls) against a creature if at least one of the
    // …'s allies is within 5 feet of the creature and the ally doesn't have the Incapacitated
    // condition."
    if (
      /has Advantage on (?:an attack roll|attack rolls) against a creature if at least one of the [\w' -]+?'s allies is within 5 feet of the creature and the ally doesn't have the Incapacitated condition\.$/.test(
        text,
      )
    ) {
      trait.pack_tactics = true;
      read++;
    }
    // Bloodied Fury, Blood Frenzy.
    if (/^While Bloodied, the [\w' -]+? has Advantage on attack rolls\.$/.test(text)) {
      trait.attack_advantage = "bloodied";
      read++;
    } else if (/has Advantage on melee attack rolls while it is Bloodied\.$/.test(text)) {
      trait.attack_advantage = "bloodied_melee";
      read++;
    } else if (
      /has Advantage on attack rolls against any creature that doesn't have all its Hit Points\.$/.test(
        text,
      )
    ) {
      trait.attack_advantage = "target_damaged";
      read++;
    }
    // Agile, Flyby: "doesn't provoke an Opportunity Attack when it moves (flies) out of an enemy's
    // reach."
    const noOa =
      /doesn't provoke an Opportunity Attack when it (moves|flies) out of an enemy's reach\.$/.exec(
        text,
      );
    if (noOa) {
      trait.no_opportunity_attacks = noOa[1] === "flies" ? "flying" : "always";
      read++;
    }
    // Absorption: "Whenever the golem is subjected to Lightning damage, it (takes no damage and
    // instead) regains a number of Hit Points equal to the Lightning damage dealt."
    const absorb =
      /^Whenever the [\w' -]+? is subjected to (\w+) damage, it (takes no damage and instead )?regains a number of Hit Points equal to the \1 damage dealt\.$/.exec(
        text,
      );
    if (absorb) {
      trait.absorbs = (absorb[1] as string).toLowerCase();
      read++;
    }
    // Swarm: "The swarm can't regain Hit Points or gain Temporary Hit Points."
    if (/The swarm can't regain Hit Points or gain Temporary Hit Points\.$/.test(text)) {
      trait.no_healing = true;
      read++;
    }
    const authority =
      /^While in a (\d+)-foot Emanation originating from the [\w' -]+?, the [\w' -]+? and its allies have Advantage on attack rolls and saving throws/.exec(
        text,
      );
    if (authority) {
      trait.advantage_aura = { size: Number(authority[1]) };
      read++;
    }
  }
  return read;
}
