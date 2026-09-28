/**
 * Build a validated, immutable `Catalog` from one or more content packs.
 *
 * A pack is plain data (parsed YAML or JSON), so this module works everywhere: Node, Deno,
 * Bun, browsers, workers. Packs are layered in order: a later pack adds entities and replaces
 * any entity with the same id (that's how homebrew overrides or extends the SRD). An entity
 * without a `source` gets its pack's name. Loading packs from disk lives in `node.ts`.
 */

import { type ZodType, z } from "zod";
import {
  ABILITIES,
  type ArmorDef,
  ArmorSchema,
  type BackgroundDef,
  BackgroundSchema,
  type ClassDef,
  ClassSchema,
  type ConditionDef,
  ConditionSchema,
  type CreationRules,
  CreationSchema,
  DEFAULT_SOURCE,
  type FeatDef,
  FeatSchema,
  type GearDef,
  GearSchema,
  type Grants,
  type LanguageDef,
  LanguageSchema,
  type MagicItemDef,
  MagicItemSchema,
  type MasteryDef,
  MasterySchema,
  type SpeciesDef,
  SpeciesSchema,
  type SpellDef,
  SpellDefSchema,
  type SubclassDef,
  SubclassSchema,
  type ToolDef,
  ToolSchema,
  type WeaponDef,
  WeaponSchema,
} from "../models/content";

export type Table<T> = Readonly<Record<string, T>>;
export type Item = WeaponDef | ArmorDef | GearDef | ToolDef | MagicItemDef;

export interface Catalog {
  readonly creation: CreationRules;
  readonly classes: Table<ClassDef>;
  readonly species: Table<SpeciesDef>;
  readonly backgrounds: Table<BackgroundDef>;
  readonly feats: Table<FeatDef>;
  readonly weapons: Table<WeaponDef>;
  readonly armor: Table<ArmorDef>;
  readonly gear: Table<GearDef>;
  readonly tools: Table<ToolDef>;
  readonly languages: Table<LanguageDef>;
  readonly masteries: Table<MasteryDef>;
  readonly spells: Table<SpellDef>;
  readonly subclasses: Table<SubclassDef>;
  /** Selectable class features (Eldritch Invocations, Metamagic): feats in shape, not in kind. */
  readonly features: Table<FeatDef>;
  readonly magic_items: Table<MagicItemDef>;
  readonly conditions: Table<ConditionDef>;
}

/** Raw, unvalidated content: what a YAML/JSON content directory parses to. */
export interface ContentPack {
  /**
   * Used in error messages, e.g. `srd-5.2.1` or `my-homebrew`, and as the `source` of entities
   * that don't declare one (`homebrew` for a pack without a name).
   */
  name?: string;
  creation?: unknown;
  classes?: unknown[];
  species?: unknown[];
  backgrounds?: unknown[];
  feats?: unknown[];
  weapons?: unknown[];
  armor?: unknown[];
  gear?: unknown[];
  tools?: unknown[];
  languages?: unknown[];
  masteries?: unknown[];
  spells?: unknown[];
  subclasses?: unknown[];
  features?: unknown[];
  magic_items?: unknown[];
  conditions?: unknown[];
}

export const TABLE_SCHEMAS = {
  classes: ClassSchema,
  species: SpeciesSchema,
  backgrounds: BackgroundSchema,
  feats: FeatSchema,
  weapons: WeaponSchema,
  armor: ArmorSchema,
  gear: GearSchema,
  tools: ToolSchema,
  languages: LanguageSchema,
  masteries: MasterySchema,
  spells: SpellDefSchema,
  subclasses: SubclassSchema,
  features: FeatSchema,
  magic_items: MagicItemSchema,
  conditions: ConditionSchema,
} as const;

export type TableName = keyof typeof TABLE_SCHEMAS;
export const TABLE_NAMES = Object.keys(TABLE_SCHEMAS) as TableName[];

export class ContentError extends Error {
  override name = "ContentError";
}

/** Look up an id in a catalog table without tripping over prototype keys. */
export function lookup<T>(table: Table<T>, id: string | null | undefined): T | undefined {
  return id != null && Object.hasOwn(table, id) ? table[id] : undefined;
}

/** Any equipment item by id. Throws `ContentError` if the id is unknown. */
export function catalogItem(catalog: Catalog, itemId: string): Item {
  for (const table of [
    catalog.weapons,
    catalog.armor,
    catalog.gear,
    catalog.tools,
    catalog.magic_items,
  ] as Table<Item>[]) {
    const item = lookup(table, itemId);
    if (item) return item;
  }
  throw new ContentError(`Unknown item '${itemId}'`);
}

export function createCatalog(...packs: ContentPack[]): Catalog {
  const errors: string[] = [];
  let creation: CreationRules | undefined;
  const tables = Object.fromEntries(TABLE_NAMES.map((t) => [t, {}])) as Record<
    TableName,
    Record<string, unknown>
  >;

  packs.forEach((pack, i) => {
    const packName = pack.name ?? `pack ${i + 1}`;
    const withSource = (entry: unknown): unknown =>
      entry !== null && typeof entry === "object" && !Array.isArray(entry) && !("source" in entry)
        ? { ...entry, source: pack.name ?? DEFAULT_SOURCE }
        : entry;
    if (pack.creation !== undefined) {
      const where = `${packName}/creation`;
      const parsed = parse(CreationSchema, withSource(pack.creation), where, errors);
      if (parsed) creation = parsed;
    }
    for (const table of TABLE_NAMES) {
      const entries = pack[table];
      if (entries === undefined) continue;
      const seen = new Set<string>();
      entries.forEach((entry, j) => {
        const where = `${packName}/${table}[${j}]`;
        const schema = TABLE_SCHEMAS[table] as ZodType<{ id: string }>;
        const parsed = parse(schema, withSource(entry), where, errors);
        if (!parsed) return;
        if (seen.has(parsed.id)) {
          errors.push(`${packName}/${table}: duplicate id '${parsed.id}'`);
          return;
        }
        seen.add(parsed.id);
        tables[table][parsed.id] = parsed;
      });
    }
  });

  if (!creation) errors.push("No pack provides the character creation rules (`creation`)");
  if (errors.length) throw new ContentError(errors.join("\n"));

  const catalog = deepFreeze({ creation, ...tables } as Catalog);
  validateReferences(catalog);
  return catalog;
}

/** Throw `ContentError` if any id referenced by content doesn't exist. */
export function validateReferences(catalog: Catalog): void {
  const errors: string[] = [];
  const check = (ids: Iterable<string>, table: Table<unknown>, what: string, where: string) => {
    for (const id of ids) {
      if (!lookup(table, id)) errors.push(`${where}: unknown ${what} '${id}'`);
    }
  };
  const items: Table<unknown> = {
    ...catalog.weapons,
    ...catalog.armor,
    ...catalog.gear,
    ...catalog.tools,
  };
  const spellLists = new Set(Object.values(catalog.spells).flatMap((s) => s.lists));
  const tags = new Set<string>();
  for (const [, grants] of allGrants(catalog)) {
    for (const choice of grants.choices) if (choice.tag) tags.add(choice.tag);
  }
  for (const [where, grants] of allGrants(catalog)) {
    check(
      grants.feats.map((f) => f.feat),
      catalog.feats,
      "feat",
      where,
    );
    check(grants.tools, catalog.tools, "tool", where);
    check(grants.languages, catalog.languages, "language", where);
    check(
      grants.items.map((i) => i.item),
      items,
      "item",
      where,
    );
    check(grants.cantrips, catalog.spells, "spell", where);
    check(grants.spells, catalog.spells, "spell", where);
    const siblings = new Set(grants.choices.map((c) => c.id));
    const ref = (value: string | null, what: string, known: (v: string) => boolean): void => {
      if (value === null) return;
      if (value.startsWith("$")) {
        if (!siblings.has(value.slice(1)))
          errors.push(`${where}: ${what} refers to unknown choice '${value}'`);
      } else if (!known(value)) {
        errors.push(`${where}: unknown ${what} '${value}'`);
      }
    };
    const isList = (list: string) => spellLists.has(list);
    if (grants.spellcasting) {
      ref(grants.spellcasting.list, "spell list", isList);
      ref(grants.spellcasting.ability, "spellcasting ability", (a) =>
        (ABILITIES as readonly string[]).includes(a),
      );
    }
    for (const choice of grants.choices) {
      for (const list of choice.spell_list ?? []) ref(list, "spell list", isList);
      if (choice.subset_of !== null && !tags.has(choice.subset_of)) {
        errors.push(`${where}.${choice.id}: subset_of refers to unknown tag '${choice.subset_of}'`);
      }
      if (choice.kind === "spell" && choice.allowed) {
        check(choice.allowed, catalog.spells, "spell", where);
      }
      if (choice.kind === "language" && choice.allowed) {
        check(choice.allowed, catalog.languages, "language", where);
      }
      if (choice.kind === "tool" && choice.allowed) {
        check(choice.allowed, catalog.tools, "tool", where);
      }
    }
  }
  for (const cls of Object.values(catalog.classes)) {
    const core = new Set([...cls.grants.choices, ...cls.multiclass.choices].map((c) => c.id));
    for (const choice of cls.features["1"]?.choices ?? []) {
      if (core.has(choice.id)) {
        errors.push(
          `${cls.id}: choice id '${choice.id}' is used by both core traits and level 1 features`,
        );
      }
    }
  }
  for (const item of Object.values(catalog.magic_items)) {
    const ids = [...(item.base?.ids ?? []), ...(item.base?.except ?? [])];
    check(ids, { ...catalog.weapons, ...catalog.armor, ...catalog.gear }, "base item", item.id);
    check(item.attunement_classes, catalog.classes, "class", item.id);
  }
  for (const condition of Object.values(catalog.conditions)) {
    check(condition.implies, catalog.conditions, "condition", condition.id);
  }
  check(
    Object.values(catalog.subclasses).map((s) => s.class),
    catalog.classes,
    "class",
    "subclasses",
  );
  for (const table of [catalog.feats, catalog.features]) {
    for (const feat of Object.values(table)) {
      const pre = feat.prerequisite;
      if (!pre) continue;
      check(pre.requires, { ...catalog.feats, ...catalog.features }, "feat or feature", feat.id);
      if (pre.class_level) check([pre.class_level.class], catalog.classes, "class", feat.id);
    }
  }
  check(
    Object.values(catalog.weapons).map((w) => w.mastery),
    catalog.masteries,
    "mastery",
    "weapons",
  );
  if (errors.length) throw new ContentError(errors.join("\n"));
}

function* allGrants(catalog: Catalog): Generator<[string, Grants]> {
  yield* walk("creation", catalog.creation.base_grants);
  for (const table of [catalog.species, catalog.backgrounds, catalog.feats, catalog.features]) {
    for (const entity of Object.values(table)) yield* walk(entity.id, entity.grants);
  }
  for (const item of Object.values(catalog.magic_items)) {
    yield* walk(item.id, item.grants);
    for (const v of item.variants) yield* walk(`${item.id}.${v.id}`, v.grants);
  }
  for (const cls of Object.values(catalog.classes)) {
    yield* walk(cls.id, cls.grants);
    yield* walk(`${cls.id}.multiclass`, cls.multiclass);
    for (const [level, grants] of Object.entries(cls.features)) {
      yield* walk(`${cls.id}.${level}`, grants);
    }
  }
  for (const sub of Object.values(catalog.subclasses)) {
    for (const [level, grants] of Object.entries(sub.features)) {
      yield* walk(`${sub.id}.${level}`, grants);
    }
  }
}

function* walk(where: string, grants: Grants): Generator<[string, Grants]> {
  yield [where, grants];
  for (const gate of grants.at_class_level) yield* walk(`${where}@${gate.level}`, gate.grants);
  for (const choice of grants.choices) {
    for (const option of choice.options) {
      yield* walk(`${where}.${choice.id}.${option.id}`, option.grants);
    }
  }
}

function parse<T>(schema: ZodType<T>, input: unknown, where: string, errors: string[]): T | null {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const id = (input as { id?: unknown } | null)?.id;
  const label = typeof id === "string" ? `${where} (${id})` : where;
  errors.push(`${label}:\n${indent(z.prettifyError(result.error))}`);
  return null;
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
