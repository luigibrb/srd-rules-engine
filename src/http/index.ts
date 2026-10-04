/**
 * The rules engine over HTTP, as a Web-standard fetch handler: `(Request) => Promise<Response>`.
 *
 * No framework and no dependencies, so it runs as-is on Deno (`Deno.serve(handler)`), Bun
 * (`Bun.serve({ fetch: handler })`), Cloudflare Workers (`export default { fetch: handler }`)
 * and Node (`serveNode` in `srd-rules-engine/node`). It can also be mounted in Hono, Next.js
 * route handlers, etc.
 */

import { z } from "zod";
import { type Catalog, lookup, TABLE_NAMES, type TableName } from "../content/catalog";
import { srdCatalog } from "../content/srd";
import { parseBuild } from "../models/build";
import { AbilityFullNameSchema, CharacterSchema } from "../models/character";
import { EncounterActionSchema, EncounterSchema } from "../models/encounter";
import { SpellSchema } from "../models/spell";
import { type CharacterState, CharacterStateSchema, PlayActionSchema } from "../models/state";
import { castSpell } from "../rules/casting";
import { savingThrow } from "../rules/combat";
import { makeAttack, ROLL_MODES } from "../rules/combatant";
import { roll } from "../rules/dice";
import { mathRng, type Rng } from "../rules/rng";
import { spellAttackBonus, spellSaveDc } from "../rules/spells";
import {
  BuildError,
  evaluate,
  levelUp,
  levelUpOptions,
  previewChange,
  removeLastLevel,
  STEP_TITLES,
  setChoice,
  setLevelClass,
  setLevelHp,
} from "../services/builder";
import {
  isAlive,
  passivePerception,
  resolveAttack,
  resolveSpellAttack,
  resolveSpellSave,
} from "../services/combat";
import { applyEncounterAction, type CharacterRef, EncounterError } from "../services/encounter";
import {
  applyAction,
  combatantFromCharacter,
  computePlaySheet,
  createState,
  PlayError,
  reconcileState,
  validateState,
} from "../services/play";

export interface HandlerOptions {
  /** Content to serve and build against. Defaults to the bundled SRD 5.2.1. */
  catalog?: Catalog;
  /** Random source for every roll. Defaults to `Math.random`. */
  rng?: Rng;
  /** Path prefix to strip, e.g. `/api` when mounted under it. */
  basePath?: string;
  /** Add permissive CORS headers so browser apps on other origins can call the API. */
  cors?: boolean;
}

export type FetchHandler = (request: Request) => Promise<Response>;

type Params = Record<string, string>;
type Route = {
  method: "GET" | "POST";
  pattern: RegExp;
  handle: (ctx: { body: unknown; params: Params; url: URL }) => unknown;
};

const RollRequest = z.object({ expression: z.string() });
const AttackRequest = z.object({
  attacker: CharacterSchema,
  target: CharacterSchema,
  attack_bonus: z.int(),
  damage_dice: z.string(),
  damage_type: z.string(),
});
const SavingThrowRequest = z.object({
  character: CharacterSchema,
  ability: AbilityFullNameSchema,
  dc: z.int(),
  proficient: z.boolean().default(false),
});
const SpellCastRequest = z.object({
  caster: CharacterSchema,
  target: CharacterSchema,
  spell: SpellSchema,
  spellcasting_ability: AbilityFullNameSchema,
});
const BuildRequest = z.object({ build: z.unknown() });
const StateRequest = z.object({ build: z.unknown(), state: CharacterStateSchema });
const ApplyRequest = StateRequest.extend({
  action: z.union([PlayActionSchema, z.array(PlayActionSchema)]),
});
const StateAttackRequest = z.object({
  attacker: StateRequest,
  target: StateRequest,
  /** The name of one of the attacker's attack lines (`Longsword`, `Unarmed Strike`). */
  attack: z.string(),
  mode: z.enum(ROLL_MODES).default("normal"),
  two_handed: z.boolean().default(false),
  /** Riders to add on a hit: `[{ rider: "sneak-attack" }, { rider: "divine-strike", type: "radiant" }]`. */
  riders: z.array(z.object({ rider: z.string(), type: z.string().optional() })).default([]),
  ally_adjacent: z.boolean().default(false),
  /** Within 5 feet of the target (default: a melee attack is, a ranged one isn't). */
  within_5ft: z.boolean().optional(),
});
const StateCastRequest = z.object({
  caster: StateRequest,
  /** Catalog spell id; the caster must have it prepared (or know the cantrip). */
  spell: z.string(),
  targets: z.array(StateRequest).default([]),
  slot_level: z.int().min(1).max(9).optional(),
  pact: z.boolean().default(false),
  spellcasting: z.string().optional(),
  mode: z.enum(ROLL_MODES).default("normal"),
});
const EncounterRequest = z.object({
  encounter: EncounterSchema,
  /** Characters by key (`add_character`'s `character`): their build and play state. */
  characters: z.record(z.string(), StateRequest).default({}),
  action: z.union([EncounterActionSchema, z.array(EncounterActionSchema)]),
});
const SetChoiceRequest = BuildRequest.extend({ key: z.string(), values: z.array(z.string()) });
const LevelUpRequest = BuildRequest.extend({
  class_id: z.string(),
  hp: z.int().nullable().default(null),
});
const LevelClassRequest = BuildRequest.extend({ level: z.int().min(1), class_id: z.string() });
const LevelHpRequest = BuildRequest.extend({ level: z.int().min(2), hp: z.int().nullable() });
const PreviewRequest = BuildRequest.extend({
  key: z.string().optional(),
  values: z.array(z.string()).optional(),
  level: z.int().min(1).optional(),
  class_id: z.string().optional(),
});
const SpellStatsRequest = z.object({
  caster: CharacterSchema,
  spellcasting_ability: AbilityFullNameSchema,
});

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : `HTTP ${status}`);
  }
}

export function createHandler(options: HandlerOptions = {}): FetchHandler {
  const rng = options.rng ?? mathRng;
  const basePath = (options.basePath ?? "").replace(/\/$/, "");
  let catalog = options.catalog;
  const getCatalog = () => {
    catalog ??= srdCatalog();
    return catalog;
  };

  const routes: Route[] = [
    { method: "GET", pattern: /^\/health$/, handle: () => ({ status: "ok" }) },

    // --- characters ---
    {
      method: "POST",
      pattern: /^\/v1\/characters\/?$/,
      handle: ({ body }) => CharacterSchema.parse(body),
    },
    {
      method: "POST",
      pattern: /^\/v1\/characters\/(?<name>[^/]+)\/alive$/,
      handle: ({ body, params }) => ({
        name: params.name,
        alive: isAlive(CharacterSchema.parse(body)),
      }),
    },
    {
      method: "POST",
      pattern: /^\/v1\/characters\/(?<name>[^/]+)\/passive-perception$/,
      handle: ({ body, params, url }) => ({
        name: params.name,
        passive_perception: passivePerception(
          CharacterSchema.parse(body),
          url.searchParams.get("proficient") === "true",
        ),
      }),
    },

    // --- combat ---
    {
      method: "POST",
      pattern: /^\/v1\/combat\/roll$/,
      handle: ({ body }) => roll(RollRequest.parse(body).expression, rng),
    },
    {
      method: "POST",
      pattern: /^\/v1\/combat\/attack$/,
      handle: ({ body }) => {
        const req = AttackRequest.parse(body);
        const out = resolveAttack(
          req.attacker,
          req.target,
          req.attack_bonus,
          req.damage_dice,
          req.damage_type,
          { rng },
        );
        return {
          attack: out.attack,
          damage: out.damage,
          target_hp: out.target.current_hit_points,
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/combat\/saving-throw$/,
      handle: ({ body }) => {
        const req = SavingThrowRequest.parse(body);
        return savingThrow(req.character, req.ability, req.dc, {
          proficient: req.proficient,
          rng,
        });
      },
    },

    // --- spells ---
    {
      method: "POST",
      pattern: /^\/v1\/spells\/stats$/,
      handle: ({ body }) => {
        const req = SpellStatsRequest.parse(body);
        return {
          save_dc: spellSaveDc(req.caster, req.spellcasting_ability),
          attack_bonus: spellAttackBonus(req.caster, req.spellcasting_ability),
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/spells\/attack$/,
      handle: ({ body }) => {
        const req = SpellCastRequest.parse(body);
        const out = resolveSpellAttack(
          req.caster,
          req.target,
          req.spell,
          req.spellcasting_ability,
          {
            rng,
          },
        );
        return {
          attack: out.attack,
          damage: out.damage,
          target_hp: out.target.current_hit_points,
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/spells\/save$/,
      handle: ({ body }) => {
        const req = SpellCastRequest.parse(body);
        const out = resolveSpellSave(req.caster, req.target, req.spell, req.spellcasting_ability, {
          rng,
        });
        return {
          save: out.save,
          damage: out.damage,
          damage_dealt: out.damage_dealt,
          target_hp: out.target.current_hit_points,
        };
      },
    },

    // --- content ---
    {
      method: "GET",
      pattern: /^\/v1\/content\/?$/,
      handle: () =>
        Object.fromEntries(TABLE_NAMES.map((t) => [t, Object.keys(getCatalog()[t]).length])),
    },
    {
      method: "GET",
      pattern: /^\/v1\/content\/packs\/?$/,
      handle: () => getCatalog().packs,
    },
    {
      method: "GET",
      pattern: /^\/v1\/content\/(?<table>[a-z_-]+)\/?$/,
      handle: ({ params }) => Object.values(getCatalog()[contentTable(params.table)]),
    },
    {
      method: "GET",
      pattern: /^\/v1\/content\/(?<table>[a-z_-]+)\/(?<id>[a-z0-9-]+)$/,
      handle: ({ params }) => {
        const entity = lookup(getCatalog()[contentTable(params.table)], params.id);
        if (!entity) throw new HttpError(404, `No ${params.table} with id '${params.id}'`);
        return entity;
      },
    },

    // --- character builder ---
    {
      method: "POST",
      pattern: /^\/v1\/builds\/evaluate$/,
      handle: ({ body }) => {
        const build = parseBuild(body);
        const ev = evaluate(build, getCatalog());
        const res = ev.resolution;
        return {
          report: ev.report,
          sheet: ev.sheet,
          levels: res.levels,
          level_up_options: levelUpOptions(build, getCatalog()),
          choices: res.choices.map((c) => ({
            key: c.key,
            label: c.label,
            level: c.level,
            step: c.step,
            step_title: STEP_TITLES[c.step],
            count: c.replaces ? 2 : res.countOf(c),
            required: res.required(c),
            // A replacement: answer [old, new]; `options` are the possible new picks.
            replaces: c.replaces ? { family: c.replaces.id, label: c.replaces.label } : null,
            replace_old_options: c.replaces ? res.replaceOld(c) : null,
            hint: c.definition.hint,
            source: c.source.name,
            fixed: c.fixed,
            selected: res.selected(c),
            options: res.options(c),
          })),
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/builds\/set-choice$/,
      handle: ({ body }) => {
        const req = SetChoiceRequest.parse(body);
        return setChoice(parseBuild(req.build), getCatalog(), req.key, req.values);
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/builds\/level-up$/,
      handle: ({ body }) => {
        const req = LevelUpRequest.parse(body);
        return levelUp(parseBuild(req.build), getCatalog(), req.class_id, req.hp);
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/builds\/set-level-class$/,
      handle: ({ body }) => {
        const req = LevelClassRequest.parse(body);
        return setLevelClass(parseBuild(req.build), getCatalog(), req.level, req.class_id);
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/builds\/set-level-hp$/,
      handle: ({ body }) => {
        const req = LevelHpRequest.parse(body);
        return setLevelHp(parseBuild(req.build), getCatalog(), req.level, req.hp);
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/builds\/preview$/,
      handle: ({ body }) => {
        // Preview a set-choice or set-level-class change without applying it.
        const req = PreviewRequest.parse(body);
        const build = parseBuild(req.build);
        const cat = getCatalog();
        if (req.key !== undefined) {
          const { key, values } = req;
          return previewChange(build, cat, (b) => setChoice(b, cat, key, values ?? []), key);
        }
        if (req.level !== undefined && req.class_id !== undefined) {
          const { level, class_id } = req;
          return previewChange(build, cat, (b) => setLevelClass(b, cat, level, class_id));
        }
        throw new HttpError(422, "Give either `key` and `values`, or `level` and `class_id`");
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/builds\/remove-level$/,
      handle: ({ body }) =>
        removeLastLevel(parseBuild(BuildRequest.parse(body).build), getCatalog()),
    },

    // --- play state (HP, slots, conditions, inventory…) ---
    {
      method: "POST",
      pattern: /^\/v1\/state\/new$/,
      handle: ({ body }) => createState(parseBuild(BuildRequest.parse(body).build), getCatalog()),
    },
    {
      method: "POST",
      pattern: /^\/v1\/state\/sheet$/,
      handle: ({ body }) => {
        const req = StateRequest.parse(body);
        const build = parseBuild(req.build);
        return {
          sheet: computePlaySheet(build, req.state, getCatalog()),
          issues: validateState(build, req.state, getCatalog()),
        };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/state\/apply$/,
      handle: ({ body }) => {
        // One action or a list, applied in order; all or nothing.
        const req = ApplyRequest.parse(body);
        const build = parseBuild(req.build);
        let state = req.state;
        const notes: string[] = [];
        for (const action of Array.isArray(req.action) ? req.action : [req.action]) {
          const result = applyAction(build, state, getCatalog(), action, { rng });
          state = result.state;
          notes.push(...result.notes);
        }
        return { state, notes };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/state\/attack$/,
      handle: ({ body }) => {
        // One attack between two characters; on a hit, the damage is applied to the target.
        const req = StateAttackRequest.parse(body);
        const catalog = getCatalog();
        const [attackerBuild, targetBuild] = [
          parseBuild(req.attacker.build),
          parseBuild(req.target.build),
        ];
        const attacker = combatantFromCharacter(attackerBuild, req.attacker.state, catalog);
        const target = combatantFromCharacter(targetBuild, req.target.state, catalog);
        const { mode, two_handed, riders, ally_adjacent, within_5ft } = req;
        let result: ReturnType<typeof makeAttack>;
        try {
          const options = { rng, mode, two_handed, riders, ally_adjacent, within_5ft };
          result = makeAttack(attacker, req.attack, target, options);
        } catch (e) {
          if (e instanceof RangeError) throw new PlayError([e.message]);
          throw e;
        }
        if (!result.hit) return { result, target_state: req.target.state, notes: [] };
        const action = {
          type: "damage" as const,
          instances: [...result.instances],
          critical: result.critical_hit,
        };
        const applied = applyAction(targetBuild, req.target.state, catalog, action, { rng });
        return { result, target_state: applied.state, notes: applied.notes };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/state\/cast$/,
      handle: ({ body }) => {
        // Cast a spell: spend the caster's slot, then apply the effects to each target's state.
        const req = StateCastRequest.parse(body);
        const catalog = getCatalog();
        const spell = lookup(catalog.spells, req.spell);
        if (!spell) throw new HttpError(404, `No spells with id '${req.spell}'`);
        const casterBuild = parseBuild(req.caster.build);
        const casterSheet = computePlaySheet(casterBuild, req.caster.state, catalog);
        if (!casterSheet.spells.some((s) => s.id === spell.id)) {
          throw new PlayError([`${casterBuild.name || "The caster"} can't cast ${spell.name}`]);
        }
        const caster = combatantFromCharacter(casterBuild, req.caster.state, catalog);
        const targets = req.targets.map((t) => ({ build: parseBuild(t.build), state: t.state }));
        const combatants = targets.map((t) => combatantFromCharacter(t.build, t.state, catalog));
        let result: ReturnType<typeof castSpell>;
        try {
          const { slot_level, pact, spellcasting, mode } = req;
          result = castSpell(caster, spell, combatants, {
            slot_level,
            pact,
            spellcasting,
            mode,
            rng,
          });
        } catch (e) {
          if (e instanceof RangeError) throw new PlayError([e.message]);
          throw e;
        }
        const notes = [...result.notes];
        let casterState = req.caster.state;
        for (const action of result.caster_actions) {
          const applied = applyAction(casterBuild, casterState, catalog, action, { rng });
          casterState = applied.state;
          notes.push(...applied.notes);
        }
        const targetStates = targets.map((t) => t.state);
        for (const hit of result.targets) {
          const target = targets[hit.target];
          if (!target) continue;
          for (const action of hit.actions) {
            const applied = applyAction(
              target.build,
              targetStates[hit.target] as CharacterState,
              catalog,
              action,
              { rng },
            );
            targetStates[hit.target] = applied.state;
            notes.push(...applied.notes);
          }
        }
        return { result, caster_state: casterState, target_states: targetStates, notes };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/encounters\/apply$/,
      handle: ({ body }) => {
        // One action or a list, applied in order; all or nothing. Changed character states are
        // returned in `states`, by character key. An action that stops for a decision ends the
        // list: `pending` asks the question, `applied` counts the actions done before it.
        const req = EncounterRequest.parse(body);
        const catalog = getCatalog();
        const characters: Record<string, CharacterRef> = Object.fromEntries(
          Object.entries(req.characters).map(([key, c]) => [
            key,
            { build: parseBuild(c.build), state: c.state },
          ]),
        );
        let encounter = req.encounter;
        const states: Record<string, CharacterState> = {};
        const notes: string[] = [];
        const actions = Array.isArray(req.action) ? req.action : [req.action];
        let applied = 0;
        for (const action of actions) {
          const result = applyEncounterAction(encounter, action, { catalog, characters, rng });
          encounter = result.encounter;
          if (result.pending) {
            notes.push(...result.notes);
            return { encounter, states, notes, pending: result.pending, applied };
          }
          applied += 1;
          for (const [key, state] of Object.entries(result.states)) {
            states[key] = state;
            characters[key] = { build: (characters[key] as CharacterRef).build, state };
          }
          notes.push(...result.notes);
        }
        return { encounter, states, notes, pending: null, applied };
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/state\/reconcile$/,
      handle: ({ body }) => {
        const req = StateRequest.parse(body);
        return reconcileState(parseBuild(req.build), req.state, getCatalog());
      },
    },
  ];

  return async (request) => {
    const url = new URL(request.url);
    const cors = options.cors ? CORS_HEADERS : {};
    if (options.cors && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    let path = url.pathname;
    if (basePath && path.startsWith(basePath)) path = path.slice(basePath.length) || "/";
    try {
      const matching = routes.filter((r) => r.pattern.test(path));
      if (!matching.length) throw new HttpError(404, "Not Found");
      const route = matching.find((r) => r.method === request.method);
      if (!route) throw new HttpError(405, "Method Not Allowed");
      const params = decodeParams(route.pattern.exec(path)?.groups ?? {});
      const body = route.method === "POST" ? await readJson(request) : undefined;
      return json(200, route.handle({ body, params, url }), cors);
    } catch (error) {
      if (error instanceof HttpError) return json(error.status, { detail: error.detail }, cors);
      if (error instanceof z.ZodError) {
        return json(422, { detail: z.treeifyError(error), message: z.prettifyError(error) }, cors);
      }
      if (error instanceof RangeError) return json(400, { detail: error.message }, cors);
      if (error instanceof BuildError) return json(400, { detail: error.messages }, cors);
      if (error instanceof PlayError || error instanceof EncounterError) {
        return json(400, { detail: error.messages }, cors);
      }
      return json(500, { detail: "Internal Server Error" }, cors);
    }
  };
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/** A table by name: `magic_items`, or `magic-items` like the YAML file. */
function contentTable(raw: string | undefined): TableName {
  const name = raw?.replaceAll("-", "_");
  if (!name || !(TABLE_NAMES as string[]).includes(name)) {
    throw new HttpError(
      404,
      `Unknown content table '${raw}'. Try one of: ${TABLE_NAMES.join(", ")}`,
    );
  }
  return name as TableName;
}

function decodeParams(groups: Params): Params {
  try {
    return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, decodeURIComponent(v)]));
  } catch {
    throw new HttpError(400, "Malformed URL");
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Request body must be JSON");
  }
}

function json(status: number, data: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
