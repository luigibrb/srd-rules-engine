/**
 * Drafts spell mechanics from a spell's text (SRD 5.2.1 wording). Used by
 * import-srd-spells.ts, and usable by any importer of text in the same style: a draft is only a
 * suggestion, each one is checked by hand before it's used.
 */

const ABILITY_WORDS: Record<string, string> = {
  Strength: "str",
  Dexterity: "dex",
  Constitution: "con",
  Intelligence: "int",
  Wisdom: "wis",
  Charisma: "cha",
};
const DAMAGE =
  /(\d+d\d+)(?: \+ (\d+))? (Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Piercing|Poison|Psychic|Radiant|Slashing|Thunder) damage/g;
const CONDITION_NAMES =
  "Blinded|Charmed|Deafened|Frightened|Grappled|Incapacitated|Invisible|Paralyzed|Petrified|Poisoned|Prone|Restrained|Stunned|Unconscious";
/** "the Blinded condition", or "the Prone and Incapacitated conditions". */
const CONDITION = new RegExp(
  `\\b((?:${CONDITION_NAMES})(?: and (?:${CONDITION_NAMES}))?) conditions?`,
  "g",
);
/** Damage or effects that happen after casting: modeled in the Encounter phase, not here. */
const LATER =
  /starts (?:its|their) turn|ends (?:its|their) turn|\benters\b|moves into|for the first time on a turn|at the start of each|at the end of its next turn|whenever|each of your turns/i;

export type Draft = { mechanics: Record<string, unknown> } | { skip: string };

/**
 * Draft mechanics from a spell's text, or say why not. Conservative: one kind of roll (a single
 * saving throw ability, or a spell attack), every damage die in the sentence that resolves it,
 * nothing that happens later. Every draft still needs a review (REVIEWED).
 */
export function parseMechanics(level: number, description: string): Draft {
  const [main = "", ...tail] = description.split(
    /\n\n_(?=Using a Higher-Level Spell Slot|Cantrip Upgrade)/,
  );
  const extra = tail.join("\n");
  // "Can't benefit from the Invisible condition" doesn't give it.
  const text = main.replace(/\n/g, " ").replace(/(?:can't|no) benefit from the \w+ condition/g, "");
  // What happens on a repeated save (at the end of each turn…) comes later: stop before it.
  const all = text.split(/(?<=[.!?])\s+/);
  const repeat = all.findIndex((x) =>
    /at the end of each of its turns|makes another \w+ saving throw|repeats the save/i.test(x),
  );
  const sentences = repeat < 0 ? all : all.slice(0, repeat);
  const saveAbilities = new Set(
    [
      ...main.matchAll(
        /(Strength|Dexterity|Constitution|Intelligence|Wisdom|Charisma) saving throw/g,
      ),
    ].map((m) => ABILITY_WORDS[m[1] as string]),
  );
  const attack = /\b(ranged|melee) spell attack/.exec(main)?.[1] ?? null;
  const heal =
    /regains? (?:a number of )?Hit Points equal to (\d+d\d+)( plus your spellcasting ability modifier)?/.exec(
      main,
    );
  const damageAll = [...main.matchAll(DAMAGE)];
  if (!damageAll.length && !heal && !(saveAbilities.size === 1 && CONDITION.test(main))) {
    return { skip: "no damage, healing or condition to model" };
  }
  CONDITION.lastIndex = 0;
  if (LATER.test(main)) return { skip: "effects that happen after casting" };
  if (attack && saveAbilities.size) return { skip: "both a spell attack and a saving throw" };
  if (saveAbilities.size > 1) return { skip: "several saving throws" };
  if (/\btable\b|<table>/.test(main)) return { skip: "a table of outcomes" };
  if (/\bDC \d+/.test(main)) return { skip: "a fixed DC (not the caster's spell save DC)" };

  const mechanics: Record<string, unknown> = {};
  let resolving: string[] = [];
  if (attack) {
    mechanics.attack = attack;
    resolving = sentences.filter((x) => /[Oo]n a hit/.test(x));
  } else if (saveAbilities.size === 1) {
    const ability = [...saveAbilities][0];
    const half = /half as much damage/.test(main);
    mechanics.save = { ability, on_success: half ? "half" : "none" };
    resolving = sentences.filter((x) =>
      /failed save|saving throw or (?:take|have)|saving throw, taking|saving throw\. A creature takes/.test(
        x,
      ),
    );
  }
  const damage = resolving.flatMap((x) =>
    [...x.matchAll(DAMAGE)].map((m) => ({
      dice: m[1],
      type: (m[3] as string).toLowerCase(),
      ...(m[2] ? { bonus: Number(m[2]) } : {}),
    })),
  );
  if (damageAll.length !== damage.length) {
    return { skip: "damage outside the sentence that resolves the attack or save" };
  }
  if ((attack || mechanics.save) && !damage.length && !resolving.some((x) => CONDITION.test(x))) {
    CONDITION.lastIndex = 0;
    return { skip: "no damage or condition where the attack or save resolves" };
  }
  CONDITION.lastIndex = 0;
  if (damage.length) mechanics.damage = damage;
  const conditions = resolving.flatMap((x) => {
    // "has the Blinded condition until the end of your next turn"
    const until = /conditions? until the (start|end) of your next turn/.exec(x)?.[1];
    return [...x.matchAll(CONDITION)].flatMap((m) =>
      (m[1] as string).split(" and ").map((name) => ({
        condition: name.toLowerCase(),
        on: attack ? "hit" : "failed_save",
        ...(until ? { until: `${until}_of_your_next_turn` } : {}),
      })),
    );
  });
  if (conditions.length) mechanics.conditions = conditions;
  if (heal) {
    if (damage.length || attack || mechanics.save) return { skip: "healing mixed with damage" };
    mechanics.heal = { dice: heal[1], ...(heal[2] ? { add_modifier: true } : {}) };
  }

  const area =
    /(\d+)-foot(?:-radius|-long)?(?:[ ,-]+\d+-foot-(?:high|wide|tall))*,? (Sphere|Cone|Cube|Line|Cylinder|Emanation)\b/.exec(
      main,
    );
  if (area) mechanics.area = { shape: (area[2] as string).toLowerCase(), size: Number(area[1]) };
  else if (
    /^[^.]*\b(?:a|one) (?:creature|target|Humanoid|Beast|Undead|willing creature)\b/i.test(
      sentences[0] ?? "",
    ) ||
    attack
  ) {
    mechanics.targets = 1;
  }

  const upcast: Record<string, unknown> = {};
  const upDamage =
    /The (?:(\w+) )?damage increases by (\d+d\d+) for each spell slot level above (\d)/.exec(extra);
  if (upDamage) {
    const types = [...new Set(damage.map((d) => d.type))];
    const type = upDamage[1] ? upDamage[1].toLowerCase() : types.length === 1 ? types[0] : null;
    if (!type || !types.includes(type)) return { skip: "an upcast whose damage type is unclear" };
    if (Number(upDamage[3]) !== level) return { skip: "an upcast from another level" };
    upcast.damage = [{ dice: upDamage[2], type }];
  }
  const upHeal = /The healing increases by (\d+d\d+) for each spell slot level above/.exec(extra);
  if (upHeal) upcast.heal = upHeal[1];
  if (/target one additional \w+ for each spell slot level above/.test(extra)) upcast.targets = 1;
  if (Object.keys(upcast).length) mechanics.upcast = upcast;
  else if (level > 0 && /_?Using a Higher-Level Spell Slot/.test(description)) {
    return { skip: "an upcast the parser doesn't read" };
  }
  if (level === 0) {
    const cantrip = /The damage increases by (\d+d\d+) when you reach levels 5/.exec(extra);
    if (cantrip && damage.length === 1 && cantrip[1] === damage[0]?.dice) {
      mechanics.cantrip_scaling = "dice";
    } else if (/Cantrip Upgrade/.test(description)) {
      return { skip: "a Cantrip Upgrade the parser doesn't read" };
    }
  }
  return { mechanics };
}
