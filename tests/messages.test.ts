import { describe, expect, it } from "vitest";
import {
  applyEncounterAction,
  createEncounter,
  type EncounterAction,
  formatMessage,
  MESSAGES_EN,
  renderMessage,
  seededRng,
} from "../src/index";
import { message } from "../src/rules/messages";
import { catalog } from "./helpers";

describe("message templates", () => {
  it("values, plurals, selects and lists", () => {
    expect(formatMessage("{n, plural, one {# turn} other {# turns}}", { n: 1 })).toBe("1 turn");
    expect(formatMessage("{n, plural, =0 {none} one {#} other {# turns}}", { n: 0 })).toBe("none");
    expect(formatMessage("{ok, select, true {yes} other {no}}", { ok: false })).toBe("no");
    expect(formatMessage("{a, list, plus} / {a}", { a: ["1", "2"] })).toBe("1 + 2 / 1, 2");
  });

  it("an English message renders from its template; another catalog translates it, nested ones too", () => {
    const save = message("save.total", { total: 12, dc: 15, mode: "advantage" });
    expect(save.text).toBe("12 vs DC 15, advantage");
    const m = message("concentration.lost", { name: "Brakka", spell: "Bless", save });
    expect(m.text).toBe("Brakka loses Concentration on Bless (12 vs DC 15, advantage).");
    const it = {
      "concentration.lost": "{name} perde la Concentrazione su {spell} ({save}).",
      "save.total": "{total} contro CD {dc}",
    };
    expect(renderMessage(m, it)).toBe("Brakka perde la Concentrazione su Bless (12 contro CD 15).");
    // A code the catalog lacks keeps its English text.
    expect(renderMessage(message("why.took_damage"), it)).toBe("it took damage");
  });

  it("a missing parameter is an engine bug", () => {
    expect(() => message("readied.taken", { name: "Brakka" })).toThrow("'trigger' missing");
  });
});

describe("encounter results", () => {
  // A catalog that marks every code: a coded message renders through it, `text` doesn't.
  const marked = Object.fromEntries(
    Object.entries(MESSAGES_EN).map(([code, t]) => [code, code === "text" ? t : `‹${t}›`]),
  );

  it("carry a message for every note, with a known code; English renders back to the note", () => {
    let e = createEncounter();
    const rng = seededRng(3);
    const actions: EncounterAction[] = [
      { type: "add_monster", monster: "mage" },
      { type: "add_monster", monster: "ogre" },
      { type: "add_monster", monster: "goblin-warrior", side: "party" },
      { type: "set_terrain", squares: [{ x: 4, y: 4 }], kind: "difficult" },
      { type: "roll_initiative" },
      { type: "set_initiative", id: "mage", value: 20 },
      { type: "set_initiative", id: "goblin-warrior", value: 15 },
      { type: "set_initiative", id: "ogre", value: 10 },
      { type: "start" },
      { type: "cast", id: "mage", spell: "fireball", targets: ["ogre"] },
      { type: "next_turn" },
      { type: "dodge", id: "goblin-warrior" },
      { type: "next_turn" },
      { type: "attack", id: "ogre", target: "goblin-warrior", attack: "Greatclub" },
      { type: "end" },
    ];
    const codes = new Set<string>();
    for (const action of actions) {
      const r = applyEncounterAction(e, action, { catalog, rng });
      e = r.encounter;
      expect(r.messages.map((m) => m.text)).toEqual(r.notes);
      for (const m of r.messages) {
        expect(m.code in MESSAGES_EN).toBe(true);
        expect(renderMessage(m)).toBe(m.text);
        if (m.code !== "text") expect(renderMessage(m, marked)).toMatch(/^‹.*›$/);
        codes.add(m.code);
      }
    }
    expect([...codes]).toEqual(
      expect.arrayContaining(["map.terrain", "initiative.rolled", "turn.starts", "spell.cast"]),
    );
    expect([...codes]).toEqual(expect.arrayContaining(["action.dodge", "fight.ends"]));
  });

  it("every English template parses", () => {
    for (const template of Object.values(MESSAGES_EN)) {
      expect(() => formatMessage(template, {})).not.toThrow();
    }
  });
});
