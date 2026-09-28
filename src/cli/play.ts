/**
 * Play mode: track a character at the table (HP, slots, conditions, inventory…) with short
 * commands. The build is read-only here; everything goes into a separate state file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Catalog } from "../content/catalog";
import type { CharacterBuild } from "../models/build";
import { type CharacterState, CURRENCIES, type Currency, type PlayAction } from "../models/state";
import { resolve } from "../rules/build-resolution";
import { signed } from "../rules/dice";
import { mathRng, type Rng } from "../rules/rng";
import {
  applyAction,
  computePlaySheet,
  createState,
  PlayError,
  type PlaySheet,
  playBuild,
  reconcileState,
  validateState,
} from "../services/play";
import { BackToMenu, type Console, QuitBuilder } from "./console";

export interface PlayAppOptions {
  state?: CharacterState;
  rng?: Rng;
  /** Where the state file goes (default: `characters`). */
  saveDir?: string;
}

const HELP = `Commands (ids are shown in brackets; numbers work for uses, items and choices):
  dmg 7 [fire] [crit]   take damage          heal 5 · hp 10 · temp 5
  ds [roll]             Death Saving Throw    stabilize
  short [10 10]         Short Rest, spending Hit Dice of those sizes      long   Long Rest
  slot 2 · unslot 2     spend / restore a spell slot    pact · unpact   Pact Magic slot
  use 1 [n] · regain 1  spend / restore a limited-use feature
  cond poisoned · cond -poisoned · exh 2 · conc bless · conc - · insp on|off
  prep [n]              today's prepared spells and other after-a-rest choices
  items                 inventory        add weapon-1 base=longsword · add potion-of-healing 2
  equip 3 · unequip 3 · attune 3 · unattune 3 · useitem 3 [roll] · drop 3 [n] · charges 3 2
  money +5gp -3sp       adjust coins
  sheet · help · save · quit`;

export class PlayApp {
  private state: CharacterState;
  private readonly rng: Rng;
  private readonly saveDir: string;
  private dirty = false;

  constructor(
    private readonly con: Console,
    private readonly catalog: Catalog,
    private readonly build: CharacterBuild,
    { state, rng, saveDir }: PlayAppOptions = {},
  ) {
    this.rng = rng ?? mathRng;
    this.saveDir = saveDir ?? "characters";
    if (state) {
      const fixed = reconcileState(build, state, catalog);
      this.state = fixed.state;
      for (const note of fixed.notes) con.warn(note);
    } else {
      this.state = createState(build, catalog);
    }
  }

  get current(): CharacterState {
    return this.state;
  }

  async run(): Promise<CharacterState> {
    const con = this.con;
    con.title(`Play · ${this.build.name || "Unnamed"}`);
    con.info("Type 'help' for commands. The build isn't changed here.");
    this.status();
    try {
      for (;;) {
        let line: string;
        try {
          line = await con.ask(">");
        } catch (error) {
          if (error instanceof BackToMenu) continue;
          throw error;
        }
        await this.command(line);
      }
    } catch (error) {
      if (!(error instanceof QuitBuilder)) throw error;
      if (this.dirty) {
        try {
          if (await con.confirm("Save the state before leaving?")) this.save();
        } catch (e) {
          if (!(e instanceof QuitBuilder || e instanceof BackToMenu)) throw e;
        }
      }
    }
    return this.state;
  }

  private sheet(): PlaySheet {
    return computePlaySheet(this.build, this.state, this.catalog);
  }

  private async command(line: string): Promise<void> {
    const [word = "", ...args] = line.split(/\s+/).filter(Boolean);
    const cmd = word.toLowerCase();
    const num = (i: number) =>
      args[i] !== undefined && /^-?\d+$/.test(args[i]) ? Number(args[i]) : undefined;
    const sheet = this.sheet();
    const itemRef = (i: number) => {
      const ref = args[i] ?? "";
      const inv = this.state.inventory;
      return /^\d+$/.test(ref) ? (inv[Number(ref) - 1]?.id ?? ref) : ref;
    };
    const useRef = (ref = "") =>
      /^\d+$/.test(ref) ? (sheet.play.uses[Number(ref) - 1]?.key ?? ref) : ref;
    switch (cmd) {
      case "":
      case "sheet":
      case "status":
        return this.status();
      case "help":
      case "?":
        return this.con.say(HELP);
      case "save":
        this.save();
        return;
      case "items":
      case "inv":
        return this.inventory(sheet);
      case "prep":
        return this.prepare(num(0));
      case "dmg":
      case "damage": {
        const type = args.slice(1).find((a) => !/^crit/i.test(a));
        return this.act({
          type: "damage",
          amount: num(0) ?? 0,
          ...(type ? { damage_type: type.toLowerCase() } : {}),
          critical: args.some((a) => /^crit/i.test(a)),
        });
      }
      case "heal":
        return this.act({ type: "heal", amount: num(0) ?? 0 });
      case "hp":
        return this.act({ type: "set_hp", current: num(0) ?? 0 });
      case "temp":
        return this.act({ type: "set_temp_hp", amount: num(0) ?? 0 });
      case "ds":
        return this.act({ type: "death_save", ...(num(0) ? { roll: num(0) } : {}) });
      case "stabilize":
        return this.act({ type: "stabilize" });
      case "short":
        return this.act({
          type: "short_rest",
          hit_dice: args.map((a) => ({ die: Number(a.replace(/^d/i, "")) })),
        });
      case "long":
        return this.act({ type: "long_rest" });
      case "slot":
        return this.act({ type: "spend_slot", level: num(0) ?? 1 });
      case "unslot":
        return this.act({ type: "restore_slot", level: num(0) ?? 1 });
      case "pact":
        return this.act({ type: "spend_pact_slot" });
      case "unpact":
        return this.act({ type: "restore_pact_slot" });
      case "use":
        return this.act({ type: "use", key: useRef(args[0]), amount: num(1) ?? 1 });
      case "regain":
        return this.act({ type: "restore_use", key: useRef(args[0]), amount: num(1) ?? 1 });
      case "cond": {
        const id = (args[0] ?? "").toLowerCase();
        return id.startsWith("-")
          ? this.act({ type: "remove_condition", condition: id.slice(1) })
          : this.act({ type: "add_condition", condition: id.replace(/^\+/, "") });
      }
      case "exh":
        return this.act({ type: "set_exhaustion", level: num(0) ?? 0 });
      case "conc": {
        const spell = args.join(" ");
        return this.act({
          type: "set_concentration",
          spell: !spell || spell === "-" ? null : spell,
        });
      }
      case "insp":
        return this.act({
          type: "set_inspiration",
          value: !/^(off|no|0|-)$/i.test(args[0] ?? "on"),
        });
      case "add": {
        const opts = Object.fromEntries(
          args.filter((a) => a.includes("=")).map((a) => a.split("=", 2)),
        );
        const qty = args.slice(1).find((a) => /^\d+$/.test(a));
        return this.act({
          type: "add_item",
          item: (args[0] ?? "").toLowerCase(),
          ...(qty ? { qty: Number(qty) } : {}),
          ...(opts.base ? { base: opts.base } : {}),
          ...(opts.variant ? { variant: opts.variant } : {}),
        });
      }
      case "drop":
        return this.act({
          type: "remove_item",
          id: itemRef(0),
          ...(num(1) ? { qty: num(1) } : {}),
        });
      case "equip":
      case "unequip":
        return this.act({ type: "equip", id: itemRef(0), equipped: cmd === "equip" });
      case "attune":
      case "unattune":
        return this.act({ type: "attune", id: itemRef(0), attuned: cmd === "attune" });
      case "useitem":
        return this.act({
          type: "use_item",
          id: itemRef(0),
          ...(num(1) !== undefined ? { roll: num(1) } : {}),
        });
      case "charges":
        return this.act({ type: "set_charges", id: itemRef(0), spent: num(1) ?? 0 });
      case "money": {
        const changes: Partial<Record<Currency, number>> = {};
        for (const a of args) {
          const m = /^([+-]?\d+)(cp|sp|ep|gp|pp)$/i.exec(a);
          if (!m) return this.con.error(`Not an amount: '${a}' (e.g. +5gp, -3sp)`);
          const coin = (m[2] as string).toLowerCase() as Currency;
          changes[coin] = (changes[coin] ?? 0) + Number(m[1]);
        }
        return this.act({ type: "adjust_currency", changes });
      }
      default:
        this.con.error(`Unknown command '${word}'. Type 'help'.`);
    }
  }

  /** Apply an action and show what happened (or why it can't). */
  act(action: PlayAction): void {
    try {
      const { state, notes } = applyAction(this.build, this.state, this.catalog, action, {
        rng: this.rng,
      });
      this.state = state;
      this.dirty = true;
      for (const note of notes) this.con.info(note);
      this.status();
    } catch (error) {
      if (!(error instanceof PlayError)) throw error;
      for (const message of error.messages) this.con.error(message);
    }
  }

  private status(): void {
    const con = this.con;
    const s = this.sheet();
    const p = s.play;
    const hp = `HP ${p.hp.current}/${p.hp.max}${p.hp.temp ? ` (+${p.hp.temp} temp)` : ""}`;
    const state = p.dead
      ? con.style(" DEAD", "red", "bold")
      : p.dying
        ? con.style(` DYING ✔${p.death_saves.successes} ✘${p.death_saves.failures}`, "red")
        : p.stable && p.hp.current === 0
          ? con.style(" stable", "yellow")
          : "";
    const hd = p.hit_dice.map((d) => `${d.total - d.spent}/${d.total} d${d.die}`).join(", ");
    con.say();
    con.say(
      `${con.style(hp, "bold")}${state}  ·  AC ${s.armor_class.total}  ·  Speed ${s.speed.total} ft  ·  Init ${signed(s.initiative.total)}  ·  Hit Dice ${hd}`,
    );
    const slots = p.spell_slots
      .filter((x) => x.total)
      .map((x) => `${x.level}: ${"●".repeat(x.total - x.spent)}${"○".repeat(x.spent)}`);
    if (p.pact_magic) {
      const pm = p.pact_magic;
      slots.push(
        `Pact (level ${pm.slot_level}): ${"●".repeat(pm.slots - pm.spent)}${"○".repeat(pm.spent)}`,
      );
    }
    if (slots.length) con.say(`Slots  ${slots.join("   ")}`);
    if (p.uses.length) {
      con.say(
        `Uses   ${p.uses.map((u, i) => `${i + 1}. ${u.name} ${u.max - u.spent}/${u.max}${u.recharge === "short" ? " (SR)" : ""}`).join("   ")}`,
      );
    }
    const tags = [
      ...p.conditions.filter((c) => !c.implied && c.id !== "exhaustion").map((c) => c.name),
      ...(p.exhaustion ? [`Exhaustion ${p.exhaustion}`] : []),
      ...(p.concentration ? [`Concentrating: ${p.concentration}`] : []),
      ...(p.heroic_inspiration ? ["Heroic Inspiration"] : []),
    ];
    if (tags.length) con.say(con.style(tags.join(" · "), "yellow"));
    for (const w of s.warnings) con.warn(w);
    for (const issue of validateState(this.build, this.state, this.catalog))
      con.warn(issue.message);
  }

  private inventory(s: PlaySheet): void {
    const con = this.con;
    const p = s.play;
    con.title("Inventory");
    p.inventory.forEach((i, n) => {
      const flags = [
        i.equipped ? "equipped" : "",
        i.requires_attunement ? (i.attuned ? "attuned" : "needs attunement") : "",
        i.charges !== null ? `${i.charges - i.charges_spent}/${i.charges} charges` : "",
      ].filter(Boolean);
      con.say(
        `  ${String(n + 1).padStart(2)}. ${i.qty > 1 ? `${i.qty}× ` : ""}${i.name}${flags.length ? con.style(` (${flags.join(", ")})`, "dim") : ""}`,
      );
    });
    if (!p.inventory.length) con.info("Nothing.");
    const coins = CURRENCIES.filter((c) => p.currency[c]).map(
      (c) => `${p.currency[c]} ${c.toUpperCase()}`,
    );
    con.say(`  Coins: ${coins.join(", ") || "none"}`);
    con.say(
      `  Attuned ${p.attuned}/3 · Carrying ${p.carried_weight} lb of ${p.carrying_capacity} lb`,
    );
  }

  /** List the after-a-rest choices, or re-pick one. */
  private async prepare(n: number | undefined): Promise<void> {
    const res = resolve(this.build, this.catalog);
    const rest = res.choices.filter((c) => c.definition.rest_change !== null);
    if (!rest.length) return this.con.info("Nothing to change after a rest.");
    const current = (key: string) => this.state.choices[key] ?? this.build.choices[key] ?? [];
    const choice = n !== undefined ? rest[n - 1] : undefined;
    if (!choice) {
      rest.forEach((c, i) => {
        const today = this.state.choices[c.key] ? " (today)" : "";
        this.con.say(
          `  ${i + 1}. ${c.label}${today}: ${current(c.key)
            .map((v) => this.name(v))
            .join(", ")}`,
        );
      });
      this.con.info("'prep <number>' to change one.");
      return;
    }
    const played = resolve(playBuild(this.build, this.state, this.catalog), this.catalog);
    const active = played.choice(choice.key) ?? choice;
    const options = played.options(active);
    const picked = new Set(current(choice.key));
    options.forEach((o, i) => {
      const mark = picked.has(o.id) ? "●" : "○";
      const note =
        o.unavailable && !picked.has(o.id) ? this.con.style(` (${o.unavailable})`, "dim") : "";
      this.con.say(`  ${String(i + 1).padStart(3)}. ${mark} ${o.name}${note}`);
    });
    const count = played.countOf(active);
    const answer = await this.con.ask(
      `Pick ${count} (numbers, space-separated), 'reset' for the build's picks >`,
    );
    if (answer.toLowerCase() === "reset")
      return this.act({ type: "reset_choice", key: choice.key });
    const values = answer
      .split(/[\s,]+/)
      .filter(Boolean)
      .map((a) => options[Number(a) - 1]?.id ?? a);
    this.act({ type: "set_choice", key: choice.key, values });
  }

  private name(id: string): string {
    return this.catalog.spells[id]?.name ?? this.catalog.weapons[id]?.name ?? id;
  }

  save(): string {
    const slug =
      this.build.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "character";
    mkdirSync(this.saveDir, { recursive: true });
    const path = join(this.saveDir, `${slug}.state.json`);
    writeFileSync(path, `${JSON.stringify(this.state, null, 2)}\n`, "utf-8");
    this.dirty = false;
    this.con.say(this.con.style(`Saved to ${path}`, "green"));
    return path;
  }
}
