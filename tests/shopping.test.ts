import { describe, expect, it } from "vitest";
import {
  applyAction,
  coinsFor,
  computePlaySheet,
  createState,
  PlayError,
  pay,
  priceInCp,
} from "../src/index";
import * as svc from "../src/services/builder";
import { apply, catalog, fighterBuild } from "./helpers";

// SRD 5.2.1 "Coins" (1 GP = 10 SP = 100 CP; 1 EP = 5 SP; 1 PP = 10 GP), the Adventuring Gear
// and Tools prices, "Selling Equipment" (half the cost).

const purse = (p: Partial<Record<"cp" | "sp" | "ep" | "gp" | "pp", number>>) => ({
  cp: 0,
  sp: 0,
  ep: 0,
  gp: 0,
  pp: 0,
  ...p,
});

describe("coins", () => {
  it("prices in copper; paying with change", () => {
    expect(priceInCp("1,500 GP")).toBe(150000);
    expect(priceInCp("5 SP")).toBe(50);
    expect(priceInCp("Varies")).toBeNull();
    expect(pay(purse({ gp: 2 }), 50)).toEqual(purse({ gp: 1, sp: 5 }));
    expect(pay(purse({ sp: 3, cp: 5 }), 35)).toEqual(purse({}));
    expect(pay(purse({ pp: 1 }), 120)).toEqual(purse({ gp: 8, sp: 8 }));
    expect(pay(purse({ gp: 1 }), 101)).toBeNull();
    expect(coinsFor(255)).toEqual(purse({ gp: 2, sp: 5, cp: 5 }));
  });
});

describe("buying and selling", () => {
  // Fighter option C: 155 GP and no gear.
  const gold = () => apply(fighterBuild(), svc.setChoice, "class:fighter#equipment", ["c"]);

  it("buys at the listed price, a bundle at a time (20 Arrows for 1 GP)", () => {
    const build = gold();
    let state = createState(build, catalog);
    const start = state.currency.gp;
    const r = applyAction(build, state, catalog, { type: "buy", item: "arrow", qty: 2 });
    state = r.state;
    expect(r.notes).toContain("Bought 40 × Arrow for 2 GP.");
    expect(state.currency.gp).toBe(start - 2);
    expect(state.inventory.find((i) => i.item === "arrow")?.qty).toBe(40);
    state = applyAction(build, state, catalog, { type: "buy", item: "rope" }).state;
    state = applyAction(build, state, catalog, { type: "buy", item: "chain-mail" }).state;
    const sheet = computePlaySheet(build, state, catalog);
    // Chain Mail 55 lb., Rope 5 lb., 40 Arrows 2 lb. (and the background's gear, if any).
    expect(sheet.play.carried_weight).toBeGreaterThanOrEqual(62);
    expect(() =>
      applyAction(build, state, catalog, { type: "buy", item: "spyglass", qty: 10 }),
    ).toThrow(PlayError);
  });

  it("sells for half; a price given overrides; a magic item needs one", () => {
    const build = gold();
    let state = createState(build, catalog);
    state = applyAction(build, state, catalog, { type: "buy", item: "longsword" }).state;
    const gp = state.currency.gp;
    const sword = state.inventory.find((i) => i.item === "longsword")?.id as string;
    const sold = applyAction(build, state, catalog, { type: "sell", id: sword });
    expect(sold.notes).toContain("Sold 1 × Longsword for 7 GP 5 SP.");
    expect(sold.state.currency).toMatchObject({ gp: gp + 7, sp: 5 });
    expect(() =>
      applyAction(build, state, catalog, { type: "buy", item: "potion-of-healing" }),
    ).toThrow('Potion of Healing has no listed price: give one (`price`, like "10 GP")');
    const potion = applyAction(build, state, catalog, {
      type: "buy",
      item: "potion-of-healing",
      price: "50 GP",
    });
    expect(potion.state.currency.gp).toBe(gp - 50);
  });
});
