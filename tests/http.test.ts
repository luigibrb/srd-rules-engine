import { describe, expect, it } from "vitest";
import { createHandler, type FetchHandler } from "../src/http/index";
import { fixedRng } from "../src/index";
import { fighterBuild } from "./helpers";

const character = (overrides = {}) => ({
  name: "Test",
  character_class: "fighter",
  level: 5,
  ability_scores: {
    strength: 16,
    dexterity: 14,
    constitution: 15,
    intelligence: 10,
    wisdom: 12,
    charisma: 8,
  },
  max_hit_points: 44,
  current_hit_points: 44,
  armor_class: 16,
  proficiency_bonus: 3,
  ...overrides,
});

function client(handler: FetchHandler) {
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await handler(
      new Request(`http://test${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return {
    get: (path: string) => call("GET", path),
    post: (path: string, body: unknown) => call("POST", path, body),
  };
}

const api = client(createHandler({ rng: fixedRng(20) }));

describe("HTTP API", () => {
  it("health", async () => {
    expect(await api.get("/health")).toMatchObject({ status: 200, body: { status: "ok" } });
  });

  it("validates characters", async () => {
    expect((await api.post("/v1/characters/", character())).status).toBe(200);
    const bad = await api.post("/v1/characters", character({ level: 25 }));
    expect(bad.status).toBe(422);
    expect(bad.body.message).toContain("level");
  });

  it("alive and passive perception", async () => {
    expect((await api.post("/v1/characters/Bob/alive", character())).body).toEqual({
      name: "Bob",
      alive: true,
    });
    const pp = await api.post("/v1/characters/Bob/passive-perception?proficient=true", character());
    expect(pp.body.passive_perception).toBe(14);
  });

  it("rolls dice", async () => {
    const res = await api.post("/v1/combat/roll", { expression: "2d6+3" });
    expect(res.body).toEqual({ dice_expression: "2d6+3", rolls: [20, 20], modifier: 3, total: 43 });
    expect((await api.post("/v1/combat/roll", { expression: "nope" })).status).toBe(400);
    expect((await api.post("/v1/combat/roll", { expression: "99999d6" })).status).toBe(400);
  });

  it("resolves an attack", async () => {
    const res = await api.post("/v1/combat/attack", {
      attacker: character(),
      target: character(),
      attack_bonus: 5,
      damage_dice: "1d8",
      damage_type: "slashing",
    });
    expect(res.body.attack.critical_hit).toBe(true);
    expect(res.body.damage.dice_expression).toBe("2d8");
    expect(res.body.target_hp).toBe(44 - 40);
  });

  it("saving throws accept any ability capitalization", async () => {
    const res = await api.post("/v1/combat/saving-throw", {
      character: character(),
      ability: "Dexterity",
      dc: 15,
    });
    expect(res.body.success).toBe(true);
  });

  it("spell stats", async () => {
    const res = await api.post("/v1/spells/stats", {
      caster: character(),
      spellcasting_ability: "wisdom",
    });
    expect(res.body).toEqual({ save_dc: 12, attack_bonus: 4 });
  });

  it("serves content", async () => {
    expect((await api.get("/v1/content")).body.weapons).toBe(38);
    expect((await api.get("/v1/content/armor/chain-mail")).body.base_ac).toBe(16);
    expect((await api.get("/v1/content/armor/nope")).status).toBe(404);
    expect((await api.get("/v1/content/spaceships")).status).toBe(404);
  });

  it("evaluates a build", async () => {
    const res = await api.post("/v1/builds/evaluate", fighterBuild());
    expect(res.body.report.is_complete).toBe(true);
    expect(res.body.sheet.armor_class.total).toBe(17);
    const skills = res.body.choices.find((c: { key: string }) => c.key === "class:fighter#skills");
    expect(skills.selected).toEqual(["acrobatics", "survival"]);
    expect(skills.options.find((o: { id: string }) => o.id === "athletics").unavailable).toBe(
      "already proficient from Soldier",
    );
  });

  it("rejects bad requests", async () => {
    expect((await api.get("/nope")).status).toBe(404);
    expect((await api.get("/v1/combat/roll")).status).toBe(405);
    const res = await createHandler()(
      new Request("http://test/v1/combat/roll", { method: "POST", body: "{not json" }),
    );
    expect(res.status).toBe(400);
  });

  it("supports a base path and CORS", async () => {
    const mounted = client(createHandler({ basePath: "/api", cors: true }));
    const res = await mounted.get("/api/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
