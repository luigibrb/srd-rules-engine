/**
 * The engine's English message templates, by code (syntax in `rules/messages.ts`). An app's
 * translation is a catalog with the same codes; `renderMessage` falls back to a message's English
 * `text` for a code it lacks. Codes are stable: a sentence that changes meaning gets a new code.
 */
export const MESSAGES_EN = {
  /** A sentence without a code yet, or free text from the content. */
  text: "{text}",
  "ability.str": "Strength",
  "ability.dex": "Dexterity",
  "ability.con": "Constitution",
  "ability.int": "Intelligence",
  "ability.wis": "Wisdom",
  "ability.cha": "Charisma",
  "save.automatic_failure": "fails automatically: {condition}",
  "save.total": "{total} vs DC {dc}{mode, select, normal {} other {, {mode}}}",
  "damage.amount": "{amount} {type}",
  "readied.taken": "{name} takes its readied action ({trigger}).",
  "relentless_rage.hp": "Relentless Rage: {name}'s Hit Points become {hp} instead.",
  "relentless_rage.save":
    "Relentless Rage: {name} {success, select, true {succeeds} other {fails}} ({save}).",
  "concentration.kept": "{name} keeps Concentration on {spell} ({save}).",
  "concentration.lost": "{name} loses Concentration on {spell} ({save}).",
  "effect.ends": "{condition} on {target} ends ({label}: {why}).",
  "why.took_damage": "it took damage",
  "why.duration_over": "its duration is over",
  "why.enters_zone": "{count, plural, one {enters it} other {are in it now}}",
  "why.starts_turn_in": "starts its turn in it",
  "why.ends_turn_in": "ends its turn in it",
  "zone.save": "{label}: {names} {why} ({ability} DC {dc}).",
  "zone.no_actions": "{name} can't take an action or a Bonus Action this turn.",
  "zone.lose_concentration": "{name} loses Concentration on {spell} ({label}).",
  "zone.damage": "{label}: {name} {why}: {dealt, list, plus}.",
  "zone.move_damage": "{label}: {name} moves {feet} feet in it: {dealt, list, plus}.",
  "zone.ends": "{label} ends ({why}).",
  "why.zone_save": "{count, plural, one {saves} other {save}}",
  "why.in_its_way": "is in its way",
} as const;

export type MessageCode = keyof typeof MESSAGES_EN;
