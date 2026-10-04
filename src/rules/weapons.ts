import type { WeaponDef } from "../models/content";

/**
 * Whether a list of weapon proficiencies covers a weapon. Entries are a category (`simple`,
 * `martial`), a category restricted to a property (`martial:light`, `martial:finesse`: "Martial
 * weapons that have the Light property"), or a weapon id (`longsword`).
 */
export function isWeaponProficient(weapon: WeaponDef, proficiencies: readonly string[]): boolean {
  return proficiencies.some((p) => {
    if (p === weapon.id || p === weapon.category) return true;
    const [category, property] = p.split(":");
    return (
      category === weapon.category && property !== undefined && weapon.properties.includes(property)
    );
  });
}

/** Monk weapons: Simple Melee weapons and Martial Melee weapons that have the Light property. */
export function isMonkWeapon(weapon: WeaponDef): boolean {
  return (
    weapon.kind === "melee" && (weapon.category === "simple" || weapon.properties.includes("light"))
  );
}

/** "80/320" (feet) → `{ normal: 80, long: 320 }`; a single number is both. */
export function parseRange(text: string | null): { normal: number; long: number } | null {
  const m = text ? /^(\d+)(?:\/(\d+))?/.exec(text) : null;
  if (!m) return null;
  return { normal: Number(m[1]), long: Number(m[2] ?? m[1]) };
}
