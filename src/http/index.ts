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
import { SpellSchema } from "../models/spell";
import { savingThrow } from "../rules/combat";
import { roll } from "../rules/dice";
import { mathRng, type Rng } from "../rules/rng";
import { spellAttackBonus, spellSaveDc } from "../rules/spells";
import {
  BuildError,
  evaluate,
  levelUp,
  levelUpOptions,
  removeLastLevel,
  STEP_TITLES,
  setChoice,
} from "../services/builder";
import {
  isAlive,
  passivePerception,
  resolveAttack,
  resolveSpellAttack,
  resolveSpellSave,
} from "../services/combat";

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
const SetChoiceRequest = BuildRequest.extend({ key: z.string(), values: z.array(z.string()) });
const LevelUpRequest = BuildRequest.extend({
  class_id: z.string(),
  hp: z.int().nullable().default(null),
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
      pattern: /^\/v1\/content\/(?<table>[a-z]+)\/?$/,
      handle: ({ params }) => Object.values(getCatalog()[contentTable(params.table)]),
    },
    {
      method: "GET",
      pattern: /^\/v1\/content\/(?<table>[a-z]+)\/(?<id>[a-z0-9-]+)$/,
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
            count: c.definition.count,
            required: res.required(c),
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
      pattern: /^\/v1\/builds\/remove-level$/,
      handle: ({ body }) =>
        removeLastLevel(parseBuild(BuildRequest.parse(body).build), getCatalog()),
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
      return json(500, { detail: "Internal Server Error" }, cors);
    }
  };
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function contentTable(name: string | undefined): TableName {
  if (!name || !(TABLE_NAMES as string[]).includes(name)) {
    throw new HttpError(
      404,
      `Unknown content table '${name}'. Try one of: ${TABLE_NAMES.join(", ")}`,
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
