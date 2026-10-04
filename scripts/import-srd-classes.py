"""Generate class levels 2–20, subclasses, Eldritch Invocations, Metamagic options, and the
General and Epic Boon feats from the SRD 5.2.1 Markdown.

    npm run content:import-classes        # = python3 scripts/import-srd-classes.py
    npm run content                       # validate + rebuild the bundled JSON and schemas
    git diff content/                     # review what changed

Requires Python 3 and PyYAML (`pip install pyyaml`). Only maintainers regenerating content need
it; the package, the tests and CI never run this script.

Inputs
    docs/srd-5.2.1/classes.md, feats.md: the SRD 5.2.1 in Markdown, a local copy of
    downfallx/dnd-5e-srd-markdown (git-ignored; see DATA-SOURCES.md).
    content/srd-5.2.1/spells.yaml: for spell ids (run scripts/import-srd-spells.ts first).

Outputs (overwritten)
    content/srd-5.2.1/classes/*.yaml    progression columns, multiclass grants, features 2–20
    content/srd-5.2.1/subclasses.yaml   one subclass per class
    content/srd-5.2.1/features.yaml     Eldritch Invocations and Metamagic options
    content/srd-5.2.1/feats.yaml        General and Epic Boon feats added, Fighting Style
                                        prerequisites set; the Origin feats are kept

What is hand-maintained, and where
    * Level 1 of each class (`grants` and `features["1"]` in its YAML) is read back from the
      YAML and kept, so edit level 1 in the YAML. (The first run split the old single
      `grants` block into core traits and level 1 features; see `restructure`.)
    * Feature text for levels 2+ comes verbatim from the Markdown.
    * Mechanics for levels 2+ (effects, choices, spells, swaps…) live in the OVERLAY,
      SUBCLASS_OVERLAY and MULTICLASS tables below. Change them here, not in the YAML: a
      rerun regenerates levels 2–20 and would overwrite hand edits there.

The script is idempotent: running it twice gives the same files.
"""

import copy
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CONTENT = ROOT / "content/srd-5.2.1"
MD = (ROOT / "docs/srd-5.2.1/classes.md").read_text()
FEATS_MD = (ROOT / "docs/srd-5.2.1/feats.md").read_text()
SPELLS = {s["id"]: s for s in yaml.safe_load((CONTENT / "spells.yaml").read_text())}


def slug(name):
    return re.sub(r"^-|-$", "", re.sub(r"[^a-z0-9]+", "-", name.lower().replace("'", "").replace("’", "")))


def cells(row):
    return [re.sub("<.*?>", "", c).strip() for c in re.findall(r"<t[hd][^>]*>(.*?)</t[hd]>", row, re.S)]


def clean(text):
    text = text.strip().replace("’", "'")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text


# --- parse classes.md -------------------------------------------------------------------------

CLASS_SECTIONS = {}
for m in re.finditer(r"\n## (\w+)\n(.*?)(?=\n## \w+\n|\Z)", MD, re.S):
    CLASS_SECTIONS[m.group(1)] = m.group(2)


def features_table(section):
    m = re.search(r"\*\*\w+ Features\*\*\s*<table>(.*?)</table>", section, re.S)
    rows = re.findall(r"<tr>(.*?)</tr>", m.group(1), re.S)
    head = cells(rows[0])
    body = [cells(r) for r in rows if cells(r) and cells(r)[0].isdigit()]
    if "——Spell Slots per Spell Level——" in head[-1]:
        head = head[:-1] + [f"slot{i}" for i in range(1, 10)]
    table = []
    for r in body:
        table.append(dict(zip(head, r)))
    return table


def level_features(section, name):
    """{level: [(feature name, text)]} for the class (not subclasses)."""
    main = section.split(f"\n### {name} Subclass:")[0]
    main = main.split(f"\n### Eldritch Invocation Options")[0].split("\n### Metamagic Options")[0]
    main = re.split(rf"\n### {name} Spell List", main)[0]
    out = {}
    for m in re.finditer(r"\n#### Level (\d+): (.+?)\n(.*?)(?=\n#### |\n### |\Z)", main, re.S):
        out.setdefault(int(m.group(1)), []).append((m.group(2).strip(), clean(m.group(3))))
    return out


def subclass_sections(section, name):
    out = []
    for m in re.finditer(rf"\n### {name} Subclass: (.+?)\n(.*?)(?=\n### |\Z)", section, re.S):
        title, body = m.group(1).strip(), m.group(2)
        intro = clean(body.split("\n#### ")[0])
        feats = {}
        for f in re.finditer(r"\n#### Level (\d+): (.+?)\n(.*?)(?=\n#### |\Z)", body, re.S):
            feats.setdefault(int(f.group(1)), []).append((f.group(2).strip(), clean(f.group(3))))
        out.append((title, intro, feats))
    return out


def option_sections(section, heading):
    i = section.index(f"\n### {heading}")
    body = section[i + 1 :]
    body = body[body.index("\n") :]
    body = re.split(r"\n### ", body)[0]
    out = []
    for m in re.finditer(r"\n#### (.+?)\n(.*?)(?=\n#### |\Z)", body, re.S):
        out.append((m.group(1).strip(), clean(m.group(2))))
    return out


def text_block(text):
    return text


# --- YAML output ------------------------------------------------------------------------------


class Dumper(yaml.SafeDumper):
    def ignore_aliases(self, data):
        return True


def str_rep(dumper, data):
    if "\n" in data:
        return dumper.represent_scalar("tag:yaml.org,2002:str", data, style="|")
    return dumper.represent_scalar("tag:yaml.org,2002:str", data)


def list_rep(dumper, data):
    flow = all(isinstance(x, (str, int)) and len(str(x)) < 30 for x in data) and len(data) <= 24
    return dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=flow)


def dict_rep(dumper, data):
    flow = len(data) <= 4 and all(isinstance(v, (str, int, bool)) and len(str(v)) < 40 for v in data.values())
    return dumper.represent_mapping("tag:yaml.org,2002:map", data.items(), flow_style=flow)


Dumper.add_representer(str, str_rep)
Dumper.add_representer(list, list_rep)
Dumper.add_representer(dict, dict_rep)


def dump(data):
    return yaml.dump(data, Dumper=Dumper, sort_keys=False, width=100, allow_unicode=True)


# --- level 1 restructuring --------------------------------------------------------------------

CORE_CHOICES = {"skills", "equipment", "instruments", "tool"}
CORE_KEYS = {"saving_throws", "weapon_proficiencies", "armor_training", "tools", "skills", "items", "gp"}

MULTICLASS = {
    "barbarian": {"weapon_proficiencies": ["martial"], "armor_training": ["shield"]},
    "bard": {
        "armor_training": ["light"],
        "choices": [
            {"id": "skills", "label": "Bard multiclass skill", "kind": "skill"},
            {"id": "instruments", "label": "Bard multiclass musical instrument", "kind": "tool", "category": "musical-instrument"},
        ],
    },
    "cleric": {"armor_training": ["light", "medium", "shield"]},
    "druid": {"armor_training": ["light", "shield"]},
    "fighter": {"weapon_proficiencies": ["martial"], "armor_training": ["light", "medium", "shield"]},
    "monk": {},
    "paladin": {"weapon_proficiencies": ["martial"], "armor_training": ["light", "medium", "shield"]},
    "ranger": {
        "weapon_proficiencies": ["martial"],
        "armor_training": ["light", "medium", "shield"],
        "choices": [{"id": "skills", "label": "Ranger multiclass skill", "kind": "skill", "allowed": None}],
    },
    "rogue": {
        "armor_training": ["light"],
        "tools": ["thieves-tools"],
        "choices": [{"id": "skills", "label": "Rogue multiclass skill", "kind": "skill", "allowed": None}],
    },
    "sorcerer": {},
    "warlock": {"armor_training": ["light"]},
    "wizard": {},
}

CASTER = {"bard": "full", "cleric": "full", "druid": "full", "sorcerer": "full", "wizard": "full",
          "paladin": "half", "ranger": "half", "warlock": "pact"}

# Columns of the class tables shown on the sheet as class resources.
RESOURCE_COLUMNS = {"Rages", "Rage Damage", "Weapon Mastery", "Bardic Die", "Channel Divinity", "Wild Shape",
                    "Second Wind", "Martial Arts", "Focus Points", "Unarmored Movement", "Favored Enemy",
                    "Sneak Attack", "Sorcery Points", "Eldritch Invocations"}


def restructure(data):
    """Split the old level 1 `grants` into core traits and `features['1']` (first run only)."""
    if "features" in data:
        return data
    grants = data["grants"]
    core, feat1 = {}, {}
    for key, value in grants.items():
        if key == "choices":
            core_c = [c for c in value if c["id"] in CORE_CHOICES]
            feat_c = [c for c in value if c["id"] not in CORE_CHOICES]
            if core_c:
                core["choices"] = core_c
            if feat_c:
                feat1["choices"] = feat_c
        elif key in CORE_KEYS:
            core[key] = value
        else:
            feat1[key] = value
    data["grants"] = core
    data["features"] = {"1": feat1}
    return data


# --- mechanics overlay (hand-written from the SRD text) --------------------------------------


def spells_at(class_id, table_levels):
    """at_class_level entries for always-prepared spell tables: {class level: [spell names]}."""
    out = []
    first = min(table_levels)
    for lvl, names in sorted(table_levels.items()):
        ids = [slug(n) for n in names]
        if lvl == first:
            continue
        out.append({"level": lvl, "grants": {"spells": ids}})
    return [slug(n) for n in table_levels[first]], out


def expertise(count, label, allowed=None, hint=""):
    c = {"id": "expertise", "label": label, "kind": "expertise", "count": count}
    if allowed:
        c["allowed"] = allowed
    if hint:
        c["hint"] = hint
    return c


def extra_attack(n):
    return {"target": "attacks", "op": "max", "value": n}


FIGHTING_STYLE_FEAT = {"id": "style", "label": "Fighting Style feat", "kind": "feat", "category": "fighting_style"}

def PRIMAL_STRIKE(dice):
    return {"id": "primal-strike", "name": "Primal Strike", "damage": dice,
            "type": ["cold", "fire", "lightning", "thunder"], "applies_to": {"weapon": True}, "once_per_turn": True}


def POTENT_SPELLCASTING(cls):
    return {"spell_damage": [{"name": "Potent Spellcasting", "ability": "wis", "cantrip": True, "list": cls}]}


def DIVINE_STRIKE(dice):
    return {"id": "divine-strike", "name": "Divine Strike", "damage": dice, "type": ["necrotic", "radiant"],
            "applies_to": {"weapon": True}, "once_per_turn": True}


OVERLAY = {
    "barbarian": {
        2: {"advantages": [{"target": "save.dex", "unless": ["incapacitated"]}],  # Danger Sense
            # Reckless Attack: until the start of your next turn.
            "toggles": [{"id": "reckless-attack", "name": "Reckless Attack", "ends_at_turn_start": True,
                         "grants": {"advantages": ["attack.str", "attacked"]}}]},
        7: {"advantages": ["initiative"]},  # Feral Instinct
        3: {"choices": [{"id": "primal_knowledge", "label": "Primal Knowledge skill", "kind": "skill",
                         "allowed": ["animal-handling", "athletics", "intimidation", "nature", "perception", "survival"]}]},
        5: {"effects": [extra_attack(2), {"target": "speed", "value": 10, "when": "not_wearing_heavy_armor"}]},
        20: {"ability_bonuses": [{"ability": "str", "value": 4, "max": 25}, {"ability": "con", "value": 4, "max": 25}]},
    },
    "bard": {
        2: {"choices": [expertise(2, "Bard Expertise")],
            "effects": [{"target": "skill.unproficient", "value": "half_prof"}]},
        9: {"choices": [expertise(2, "Bard Expertise")]},
        20: {"spells": ["power-word-heal", "power-word-kill"]},
    },
    "cleric": {
        7: {"choices": [{"id": "blessed_strikes", "label": "Blessed Strikes", "kind": "option", "options": [
            {"id": "divine-strike", "name": "Divine Strike",
             "description": "Once per turn, a weapon hit deals an extra 1d8 Necrotic or Radiant damage.",
             "grants": {"damage_riders": [DIVINE_STRIKE("1d8")],
                        # Improved Blessed Strikes: 2d8 (same id: replaces the 1d8).
                        "at_class_level": [{"level": 14, "grants": {"damage_riders": [DIVINE_STRIKE("2d8")]}}]}},
            {"id": "potent-spellcasting", "name": "Potent Spellcasting",
             "description": "Add your Wisdom modifier to the damage of your Cleric cantrips.",
             "grants": POTENT_SPELLCASTING("cleric")}]}]},
    },
    "druid": {
        7: {"choices": [{"id": "elemental_fury", "label": "Elemental Fury", "kind": "option", "options": [
            {"id": "potent-spellcasting", "name": "Potent Spellcasting",
             "description": "Add your Wisdom modifier to the damage of your Druid cantrips.",
             "grants": POTENT_SPELLCASTING("druid")},
            {"id": "primal-strike", "name": "Primal Strike",
             "description": "Once per turn, a weapon or Beast-form hit deals an extra 1d8 Cold, Fire, Lightning, or Thunder damage.",
             "grants": {"damage_riders": [PRIMAL_STRIKE("1d8")],
                        # Improved Elemental Fury: 2d8 (same id: replaces the 1d8).
                        "at_class_level": [{"level": 15, "grants": {"damage_riders": [PRIMAL_STRIKE("2d8")]}}]}}]}]},
    },
    "fighter": {
        2: {"actions": [{"id": "action-surge", "name": "Action Surge", "economy": "free", "uses": "action-surge",
                         "extra_action": True}]},
        5: {"effects": [extra_attack(2)]},
        11: {"effects": [extra_attack(3)]},
        20: {"effects": [extra_attack(4)]},
    },
    "monk": {
        2: {"effects": [{"target": "speed", "value": 10, "when": "unarmored"}],
            # Monk's Focus: the Focus Point versions (the free ones are a Bonus Action Unarmed
            # Strike, `disengage` and `dash` with `bonus_action`).
            "actions": [
                {"id": "flurry-of-blows", "name": "Flurry of Blows", "economy": "bonus_action", "uses": "focus-points",
                 "attacks": {"attack": "Unarmed Strike", "count": 2}},
                {"id": "patient-defense", "name": "Patient Defense", "economy": "bonus_action", "uses": "focus-points",
                 "also": ["disengage", "dodge"]},
                {"id": "step-of-the-wind", "name": "Step of the Wind", "economy": "bonus_action",
                 "uses": "focus-points", "also": ["disengage", "dash"]}]},
        5: {"effects": [extra_attack(2), {"target": "martial_arts.die", "op": "max", "value": 8}],
            "actions": [{"id": "stunning-strike", "name": "Stunning Strike", "economy": "free", "uses": "focus-points",
                         "target": "other", "after_hit": True, "once_per_turn": True,
                         "save": {"ability": "con", "dc_ability": "wis", "conditions": ["stunned"]}}]},
        6: {"effects": [{"target": "speed", "value": 5, "when": "unarmored"}]},
        7: {"rules": ["evasion"]},
        10: {"effects": [{"target": "speed", "value": 5, "when": "unarmored"}]},
        11: {"effects": [{"target": "martial_arts.die", "op": "max", "value": 10}]},
        14: {"effects": [{"target": "speed", "value": 5, "when": "unarmored"}],
             "saving_throws": ["str", "dex", "con", "int", "wis", "cha"]},
        17: {"effects": [{"target": "martial_arts.die", "op": "max", "value": 12}]},
        18: {"effects": [{"target": "speed", "value": 5, "when": "unarmored"}]},
        20: {"ability_bonuses": [{"ability": "dex", "value": 4, "max": 25}, {"ability": "wis", "value": 4, "max": 25}]},
    },
    "paladin": {
        2: {"spells": ["divine-smite"],
            "choices": [{"id": "fighting_style", "label": "Fighting Style", "kind": "option", "options": [
                {"id": "feat", "name": "Fighting Style feat", "description": "A Fighting Style feat of your choice.",
                 "grants": {"choices": [FIGHTING_STYLE_FEAT]}},
                {"id": "blessed-warrior", "name": "Blessed Warrior",
                 "description": "Two Cleric cantrips; Charisma is your spellcasting ability for them.",
                 "grants": {"choices": [{"id": "cantrips", "label": "Blessed Warrior cantrips", "kind": "spell",
                                         "count": 2, "spell_level": 0, "spell_list": "cleric",
                                         "hint": "Guidance and Sacred Flame are recommended."}]}}]}]},
        5: {"effects": [extra_attack(2)], "spells": ["find-steed"]},
        6: {"effects": [{"target": "saves", "value": "cha", "min": 1}]},
    },
    "ranger": {
        2: {"choices": [
            expertise(1, "Deft Explorer Expertise"),
            {"id": "languages", "label": "Deft Explorer languages", "kind": "language", "count": 2},
            {"id": "fighting_style", "label": "Fighting Style", "kind": "option", "options": [
                {"id": "feat", "name": "Fighting Style feat", "description": "A Fighting Style feat of your choice.",
                 "grants": {"choices": [FIGHTING_STYLE_FEAT]}},
                {"id": "druidic-warrior", "name": "Druidic Warrior",
                 "description": "Two Druid cantrips; Wisdom is your spellcasting ability for them.",
                 "grants": {"choices": [{"id": "cantrips", "label": "Druidic Warrior cantrips", "kind": "spell",
                                         "count": 2, "spell_level": 0, "spell_list": "druid",
                                         "hint": "Guidance and Starry Wisp are recommended."}]}}]}]},
        5: {"effects": [extra_attack(2)]},
        6: {"effects": [{"target": "speed", "value": 10, "when": "not_wearing_heavy_armor"}]},
        9: {"choices": [expertise(2, "Ranger Expertise")]},
    },
    "rogue": {
        5: {"actions": [{"id": "uncanny-dodge", "name": "Uncanny Dodge", "economy": "reaction",
                         "halves_attack_damage": True}]},
        6: {"choices": [expertise(2, "Rogue Expertise")]},
        7: {"rules": ["evasion", "reliable_talent"]},
        15: {"saving_throws": ["wis", "cha"]},
    },
    "sorcerer": {
        2: {"choices": [{"id": "metamagic", "label": "Metamagic options", "kind": "feature", "count": 2, "category": "metamagic"}]},
        10: {"choices": [{"id": "metamagic", "label": "Metamagic options", "kind": "feature", "count": 2, "category": "metamagic"}]},
        17: {"choices": [{"id": "metamagic", "label": "Metamagic options", "kind": "feature", "count": 2, "category": "metamagic"}]},
    },
    "warlock": {
        9: {"spells": ["contact-other-plane"]},
        **{lvl: {"choices": [{"id": "mystic_arcanum", "label": f"Mystic Arcanum (level {sl} spell)", "kind": "spell",
                              "spell_level": sl, "spell_list": "warlock", "always_prepared": True}]}
           for lvl, sl in [(11, 6), (13, 7), (15, 8), (17, 9)]},
    },
    "wizard": {
        2: {"choices": [expertise(1, "Scholar Expertise",
                                  allowed=["arcana", "history", "investigation", "medicine", "nature", "religion"])]},
        18: {"choices": [
            {"id": "mastery_1", "label": "Spell Mastery (level 1 spell)", "kind": "spell", "spell_level": 1,
             "subset_of": "wizard-spellbook", "always_prepared": True, "rest_change": "long",
             "hint": "A level 1 spell in your spellbook with a casting time of an action."},
            {"id": "mastery_2", "label": "Spell Mastery (level 2 spell)", "kind": "spell", "spell_level": 2,
             "subset_of": "wizard-spellbook", "always_prepared": True, "rest_change": "long",
             "hint": "A level 2 spell in your spellbook with a casting time of an action."}]},
        20: {"choices": [{"id": "signature", "label": "Signature Spells", "kind": "spell", "count": 2,
                          "spell_level": 3, "subset_of": "wizard-spellbook", "always_prepared": True}]},
    },
}

LIFE = {3: ["Aid", "Bless", "Cure Wounds", "Lesser Restoration"], 5: ["Mass Healing Word", "Revivify"],
        7: ["Aura of Life", "Death Ward"], 9: ["Greater Restoration", "Mass Cure Wounds"]}
DEVOTION = {3: ["Protection from Evil and Good", "Shield of Faith"], 5: ["Aid", "Zone of Truth"],
            9: ["Beacon of Hope", "Dispel Magic"], 13: ["Freedom of Movement", "Guardian of Faith"],
            17: ["Commune", "Flame Strike"]}
DRACONIC = {3: ["Alter Self", "Chromatic Orb", "Command", "Dragon's Breath"], 5: ["Fear", "Fly"],
            7: ["Arcane Eye", "Charm Monster"], 9: ["Legend Lore", "Summon Dragon"]}
FIEND = {3: ["Burning Hands", "Command", "Scorching Ray", "Suggestion"], 5: ["Fireball", "Stinking Cloud"],
         7: ["Fire Shield", "Wall of Fire"], 9: ["Geas", "Insect Plague"]}
LAND = {
    "arid": ({3: ["Blur", "Burning Hands", "Fire Bolt"], 5: ["Fireball"], 7: ["Blight"], 9: ["Wall of Stone"]}, "fire"),
    "polar": ({3: ["Fog Cloud", "Hold Person", "Ray of Frost"], 5: ["Sleet Storm"], 7: ["Ice Storm"], 9: ["Cone of Cold"]}, "cold"),
    "temperate": ({3: ["Misty Step", "Shocking Grasp", "Sleep"], 5: ["Lightning Bolt"], 7: ["Freedom of Movement"], 9: ["Tree Stride"]}, "lightning"),
    "tropical": ({3: ["Acid Splash", "Ray of Sickness", "Web"], 5: ["Stinking Cloud"], 7: ["Polymorph"], 9: ["Insect Plague"]}, "poison"),
}


def spell_grants(table):
    first, rest = spells_at(None, table)
    g = {"spells": first}
    if rest:
        g["at_class_level"] = rest
    return g


def land_options():
    opts = []
    for land, (table, resistance) in LAND.items():
        g = spell_grants(table)
        g.setdefault("at_class_level", []).append({"level": 10, "grants": {"resistances": [resistance]}})
        names = ", ".join(table[3])
        opts.append({"id": land, "name": land.title(), "description": f"{names}; later spells, and {resistance.title()} resistance at level 10.", "grants": g})
    return opts


EVOCATION_SAVANT = {lvl: {"choices": [{"id": "evocation_savant", "label": "Evocation Savant (free evocation spell)", "kind": "spell",
                                       "spell_list": "wizard", "school": "evocation", "max_spell_level": sl, "tag": "wizard-spellbook"}]}
                    for lvl, sl in [(5, 3), (7, 4), (9, 5), (11, 6), (13, 7), (15, 8), (17, 9)]}

SUBCLASS_OVERLAY = {
    "path-of-the-berserker": {
        # Frenzy: Reckless Attack while raging; "a number of d6s equal to your Rage Damage bonus".
        3: {"damage_riders": [{"id": "frenzy", "name": "Frenzy", "damage": {"progression": "Rage Damage", "die": 6},
                               "applies_to": {"ability": "str"}, "once_per_turn": True,
                               "while_active": ["rage", "reckless-attack"]}]},
    },
    "college-of-lore": {
        3: {"choices": [{"id": "bonus_proficiencies", "label": "Bonus Proficiencies (skills)", "kind": "skill", "count": 3}]},
        6: {"choices": [{"id": "magical_discoveries", "label": "Magical Discoveries", "kind": "spell", "count": 2,
                         "tag": "lore-discoveries", "swap": "class_level",
                         "spell_list": ["cleric", "druid", "wizard"], "max_spell_level": 3, "always_prepared": True,
                         "hint": "Two spells from the Cleric, Druid, or Wizard list (cantrips or spells you have slots for)."}]},
    },
    "life-domain": {3: spell_grants(LIFE)},
    "circle-of-the-land": {3: {"choices": [{"id": "land", "label": "Circle of the Land: land type", "kind": "option",
                                             "options": land_options()}]}},
    "champion": {
        3: {"effects": [{"target": "attack.critical", "op": "min", "value": 19}]},
        7: {"choices": [dict(FIGHTING_STYLE_FEAT, label="Additional Fighting Style")]},
        15: {"effects": [{"target": "attack.critical", "op": "min", "value": 18}]},
    },
    "warrior-of-the-open-hand": {},
    "oath-of-devotion": {3: spell_grants(DEVOTION)},
    "hunter": {
        3: {"choices": [{"id": "hunters_prey", "label": "Hunter's Prey", "kind": "option", "rest_change": "short", "options": [
            {"id": "colossus-slayer", "name": "Colossus Slayer",
             "description": "Once per turn, +1d8 damage to a creature that's missing any of its Hit Points.",
             "grants": {"damage_riders": [{"id": "colossus-slayer", "name": "Colossus Slayer", "damage": "1d8",
                                           "applies_to": {"weapon": True}, "once_per_turn": True,
                                           "requires": "target_damaged"}]}},
            {"id": "horde-breaker", "name": "Horde Breaker",
             "description": "Once per turn, attack another creature within 5 ft of the first target and within reach."}]}]},
        7: {"choices": [{"id": "defensive_tactics", "label": "Defensive Tactics", "kind": "option", "rest_change": "short", "options": [
            {"id": "escape-the-horde", "name": "Escape the Horde",
             "description": "Opportunity Attacks have Disadvantage against you."},
            {"id": "multiattack-defense", "name": "Multiattack Defense",
             "description": "After a creature hits you, it has Disadvantage on its other attacks against you this turn."}]}]},
    },
    "thief": {},
    "draconic-sorcery": {
        3: {**spell_grants(DRACONIC),
            "effects": [{"target": "hp_per_class_level", "value": 1}],
            "ac_calculations": [{"name": "Draconic Resilience", "abilities": ["dex", "cha"]}]},
        6: {"choices": [{"id": "elemental_affinity", "label": "Elemental Affinity", "kind": "option", "options": [
            {"id": t, "name": t.title(), "description": f"Resistance to {t.title()} damage; add Cha to one damage roll of spells dealing it.",
             "grants": {"resistances": [t],
                        "spell_damage": [{"name": "Elemental Affinity", "ability": "cha", "damage_type": t,
                                          "one_roll": True}]}}
            for t in ["acid", "cold", "fire", "lightning", "poison"]]}]},
    },
    "fiend-patron": {3: spell_grants(FIEND)},
    "evoker": {
        3: {"choices": [{"id": "evocation_savant", "label": "Evocation Savant (free evocation spells)", "kind": "spell",
                         "count": 2, "spell_list": "wizard", "school": "evocation", "max_spell_level": 2,
                         "tag": "wizard-spellbook"}],
            "rules": ["potent_cantrip"]},
        10: {"spell_damage": [{"name": "Empowered Evocation", "ability": "int", "list": "wizard",
                               "school": "evocation", "one_roll": True}]},
        **EVOCATION_SAVANT,
    },
}


def merge(a, b):
    out = copy.deepcopy(a)
    for k, v in b.items():
        if isinstance(v, list):
            out[k] = out.get(k, []) + copy.deepcopy(v)
        else:
            out[k] = copy.deepcopy(v)
    return out


# --- per class generation ---------------------------------------------------------------------


def num(value):
    return int(value) if re.fullmatch(r"\d+", value) else value


def max_slot(row, class_id):
    if class_id == "warlock":
        return int(row["Slot Level"])
    levels = [i for i in range(1, 10) if row.get(f"slot{i}", "—") not in ("—", "", None)]
    return max(levels) if levels else 0


# --- changing choices later -------------------------------------------------------------------
#
# "After a Long Rest" lists (prepared spells of Clerics, Druids, Paladins, Rangers and Wizards,
# Wizard cantrips, Weapon Mastery) can be changed freely, so each is ONE level 1 choice that
# grows with the class (`scaling`) instead of new picks at each level.
PREPARED_POOLS = {"cleric", "druid", "paladin", "ranger", "wizard"}
CANTRIP_POOLS = {"wizard"}

# "Whenever you gain a <class> level, you can replace one ...": choices in the same family
# (`tag`) get `swap: class_level`, and the engine offers one replacement per family per level.
# Keys are choice ids, wherever they appear in the class's grants (including nested options).
SWAP_FAMILIES = {
    "bard": {"cantrips": "bard-cantrips", "prepared": "bard-prepared"},
    "cleric": {"cantrips": "cleric-cantrips", "cantrip": "cleric-cantrips"},  # + Thaumaturge
    "druid": {"cantrips": "druid-cantrips", "cantrip": "druid-cantrips"},  # + Magician
    "fighter": {"fighting_style": "fighter-style"},
    "paladin": {"cantrips": "paladin-blessed-warrior"},
    "ranger": {"cantrips": "ranger-druidic-warrior"},
    "sorcerer": {"cantrips": "sorcerer-cantrips", "prepared": "sorcerer-prepared",
                 "metamagic": "sorcerer-metamagic"},
    "warlock": {"cantrips": "warlock-cantrips", "prepared": "warlock-prepared",
                "invocation": "warlock-invocations", "invocations": "warlock-invocations",
                "mystic_arcanum": "warlock-arcanum"},
}
SAME_LEVEL_TAGS = {"warlock-arcanum"}  # "another Warlock spell of the same level"


# Limited-use features tracked in play. A later level's entry with the same id replaces the
# earlier one (Action Surge: 2 uses at 17). `short`: all back on a Short Rest; `long` with
# `short_rest_regain`: one back on a Short Rest, all on a Long Rest.
def res(id, name, recharge, short=None, **max_spec):
    r = {"id": id, "name": name, "max": max_spec, "recharge": recharge}
    if short:
        r["short_rest_regain"] = short
    return r


CHANNEL = res("channel-divinity", "Channel Divinity", "long", short=1, progression="Channel Divinity")
RESOURCES = {
    "barbarian": {1: [res("rage", "Rage", "long", short=1, progression="Rages")]},
    "bard": {1: [res("bardic-inspiration", "Bardic Inspiration", "long", ability="cha", min=1)],
             5: [res("bardic-inspiration", "Bardic Inspiration", "short", ability="cha", min=1)]},
    "cleric": {2: [CHANNEL], 10: [res("divine-intervention", "Divine Intervention", "long", value=1)]},
    "druid": {2: [res("wild-shape", "Wild Shape", "long", short=1, progression="Wild Shape")]},
    "fighter": {1: [res("second-wind", "Second Wind", "long", short=1, progression="Second Wind")],
                2: [res("action-surge", "Action Surge", "short", value=1)],
                9: [res("indomitable", "Indomitable", "long", value=1)],
                13: [res("indomitable", "Indomitable", "long", value=2)],
                17: [res("action-surge", "Action Surge", "short", value=2),
                     res("indomitable", "Indomitable", "long", value=3)]},
    "monk": {2: [res("focus-points", "Focus Points", "short", progression="Focus Points"),
                 res("uncanny-metabolism", "Uncanny Metabolism", "long", value=1)]},
    "paladin": {1: [res("lay-on-hands", "Lay On Hands (Hit Point pool)", "long", per_class_level=5)],
                2: [res("paladins-smite", "Paladin's Smite (free Divine Smite)", "long", value=1)],
                3: [CHANNEL]},
    "ranger": {1: [res("favored-enemy", "Favored Enemy (free Hunter's Mark)", "long", progression="Favored Enemy")]},
    "rogue": {20: [res("stroke-of-luck", "Stroke of Luck", "short", value=1)]},
    "sorcerer": {1: [res("innate-sorcery", "Innate Sorcery", "long", value=2)],
                 2: [res("sorcery-points", "Sorcery Points", "long", progression="Sorcery Points")]},
    "warlock": {2: [res("magical-cunning", "Magical Cunning", "long", value=1)],
                9: [res("contact-patron", "Contact Patron", "long", value=1)],
                **{lvl: [res(f"mystic-arcanum-{sl}", f"Mystic Arcanum (level {sl})", "long", value=1)]
                   for lvl, sl in [(11, 6), (13, 7), (15, 8), (17, 9)]}},
    "wizard": {1: [res("arcane-recovery", "Arcane Recovery", "long", value=1)]},
}
SUBCLASS_RESOURCES = {
    "warrior-of-the-open-hand": {6: [res("wholeness-of-body", "Wholeness of Body", "long", ability="wis", min=1)]},
    "circle-of-the-land": {6: [res("natural-recovery", "Natural Recovery", "long", value=1)]},
    "draconic-sorcery": {14: [res("dragon-wings", "Dragon Wings", "long", value=1)]},
    "fiend-patron": {6: [res("dark-ones-own-luck", "Dark One's Own Luck", "long", ability="cha", min=1)],
                     14: [res("hurl-through-hell", "Hurl Through Hell", "long", value=1)]},
}


def tag_swaps(choices, class_id):
    """Mark swap families on a list of choices (and the choices nested in their options)."""
    families = SWAP_FAMILIES.get(class_id, {})
    for c in choices:
        tag = families.get(c["id"])
        if tag:
            c["tag"] = tag
            c["swap"] = "class_level"
            if tag in SAME_LEVEL_TAGS:
                c["same_level"] = True
        for option in c.get("options", []):
            tag_swaps(option.get("grants", {}).get("choices", []), class_id)


def make_pools(f1, class_id, table):
    for c in f1.get("choices", []):
        if c["id"] == "weapon_mastery" or (c["id"] == "prepared" and class_id in PREPARED_POOLS) \
                or (c["id"] == "cantrips" and class_id in CANTRIP_POOLS):
            c["rest_change"] = "long"
        if c["id"] == "prepared" and class_id in PREPARED_POOLS:
            c.pop("spell_level", None)
            c.pop("max_spell_level", None)
            c["scaling"] = {"count": [int(r["Prepared Spells"]) for r in table],
                            "max_spell_level": [max_slot(r, class_id) for r in table]}
            hint = c.get("hint", "")
            if "Long Rest" not in hint:
                c["hint"] = (hint + " " if hint else "") + "You can change these after a Long Rest."
        if c["id"] == "cantrips" and class_id in CANTRIP_POOLS:
            c["scaling"] = {"count": [int(r["Cantrips"]) for r in table], "max_spell_level": None}
        if c["id"] == "weapon_mastery" and "Weapon Mastery" in table[0]:
            c["scaling"] = {"count": [int(r["Weapon Mastery"]) for r in table], "max_spell_level": None}


def generate_class(class_id):
    name = class_id.title()
    section = CLASS_SECTIONS[name]
    path = CONTENT / "classes" / f"{class_id}.yaml"
    data = restructure(yaml.safe_load(path.read_text()))
    table = features_table(section)
    feats = level_features(section, name)
    data["multiclass"] = copy.deepcopy(MULTICLASS[class_id])
    core_skills = next((c for c in data["grants"].get("choices", []) if c["id"] == "skills"), None)
    for c in data["multiclass"].get("choices", []):
        if c["id"] == "skills" and "allowed" in c:
            c["allowed"] = core_skills["allowed"]
    data["subclass_level"] = 3

    # Level 1 spellcasting: slot progression instead of fixed slots.
    f1 = data["features"]["1"]
    sc = f1.get("spellcasting")
    if sc:
        sc.pop("slots", None)
        sc.pop("pact", None)
        sc["progression"] = CASTER[class_id]
        if class_id == "warlock":
            sc["pact_slots"] = [{"count": int(r["Spell Slots"]), "level": int(r["Slot Level"])} for r in table]
    if class_id == "wizard":
        for c in f1["choices"]:
            if c["id"] == "spellbook":
                c["tag"] = "wizard-spellbook"
            if c["id"] == "prepared":
                c["subset_of"] = "wizard-spellbook"
    if class_id == "warlock":
        f1["choices"] = [c for c in f1["choices"] if c["id"] != "invocation"]
        f1["choices"].insert(1, {"id": "invocation", "label": "Eldritch Invocation", "kind": "feature",
                                 "category": "eldritch_invocation", "hint": "Pact of the Tome is recommended."})
    make_pools(f1, class_id, table)
    tag_swaps(f1.get("choices", []), class_id)
    f1.pop("resources", None)
    if RESOURCES.get(class_id, {}).get(1):
        f1["resources"] = copy.deepcopy(RESOURCES[class_id][1])

    data["progression"] = {
        col: [num(r[col]) for r in table] for col in table[0] if col in RESOURCE_COLUMNS
    }

    features = {"1": f1}
    for level in range(2, 21):
        row, prev = table[level - 1], table[level - 2]
        g = {}
        traits = []
        for fname, text in feats.get(level, []):
            traits.append({"name": fname, "text": text})
        if traits:
            g["traits"] = traits
        choices = []
        cf = row["Class Features"]
        if "Subclass" in cf and level == 3:
            choices.append({"id": "subclass", "label": f"{name} subclass", "kind": "subclass"})
        if "Ability Score Improvement" in cf:
            choices.append({"id": "feat", "label": "Ability Score Improvement or feat", "kind": "feat",
                            "hint": "The Ability Score Improvement feat, or another feat you qualify for."})
        if "Epic Boon" in cf:
            choices.append({"id": "feat", "label": "Epic Boon or feat", "kind": "feat", "category": ["epic_boon", "general", "origin", "fighting_style"],
                            "hint": "An Epic Boon feat, or another feat you qualify for."})
        # Spellcasting growth.
        if "Cantrips" in row and int(row["Cantrips"]) > int(prev["Cantrips"]) and class_id not in CANTRIP_POOLS:
            choices.append({"id": "cantrips", "label": f"{name} cantrips", "kind": "spell",
                            "count": int(row["Cantrips"]) - int(prev["Cantrips"]), "spell_level": 0, "spell_list": class_id})
        lists = ["bard", "cleric", "druid", "wizard"] if class_id == "bard" and level >= 10 else class_id
        if class_id == "wizard":
            choices.append({"id": "spellbook", "label": "Spellbook (new spells)", "kind": "spell", "count": 2,
                            "max_spell_level": max_slot(row, class_id), "spell_list": "wizard", "tag": "wizard-spellbook"})
        if ("Prepared Spells" in row and int(row["Prepared Spells"]) > int(prev["Prepared Spells"])
                and class_id not in PREPARED_POOLS):
            c = {"id": "prepared", "label": f"{name} prepared spells", "kind": "spell",
                 "count": int(row["Prepared Spells"]) - int(prev["Prepared Spells"]), "max_spell_level": max_slot(row, class_id)}
            if class_id == "wizard":
                c["subset_of"] = "wizard-spellbook"
            else:
                c["spell_list"] = lists
            if class_id == "bard" and level >= 10:
                c["hint"] = "Magical Secrets: from the Bard, Cleric, Druid, or Wizard list."
            choices.append(c)
        if "Eldritch Invocations" in row and int(row["Eldritch Invocations"]) > int(prev["Eldritch Invocations"]):
            choices.append({"id": "invocations", "label": "Eldritch Invocations", "kind": "feature",
                            "category": "eldritch_invocation",
                            "count": int(row["Eldritch Invocations"]) - int(prev["Eldritch Invocations"])})
        if choices:
            g["choices"] = choices
        g = merge(g, OVERLAY.get(class_id, {}).get(level, {}))
        if RESOURCES.get(class_id, {}).get(level):
            g["resources"] = copy.deepcopy(RESOURCES[class_id][level])
        tag_swaps(g.get("choices", []), class_id)
        if g:
            features[str(level)] = g
    data["features"] = features

    key_order = ["id", "name", "description", "primary_abilities", "primary_mode", "hit_die", "complexity",
                 "standard_array", "subclass_level", "progression", "grants", "multiclass", "features"]
    ordered = {k: data[k] for k in key_order if k in data}
    header = (f"# yaml-language-server: $schema=../../../schemas/classes.schema.json\n"
              f"# SRD 5.2.1 — \"Classes\" > \"{name}\". Level 1 traits are summarized; level 2+ feature text is\n"
              f"# the SRD's, generated from docs/srd-5.2.1/classes.md; mechanics were added by hand.\n")
    path.write_text(header + dump(ordered))

    subs = []
    for title, intro, sfeats in subclass_sections(section, name):
        sid = slug(title)
        features_s = {}
        overlay = SUBCLASS_OVERLAY.get(sid)
        if overlay is None:
            sys.exit(f"no overlay entry for subclass {sid}")
        for lvl in sorted(set(sfeats) | set(overlay) | set(SUBCLASS_RESOURCES.get(sid, {}))):
            g = {}
            if lvl in sfeats:
                g["traits"] = [{"name": n, "text": t} for n, t in sfeats[lvl]]
            g = merge(g, overlay.get(lvl, {}))
            if SUBCLASS_RESOURCES.get(sid, {}).get(lvl):
                g["resources"] = copy.deepcopy(SUBCLASS_RESOURCES[sid][lvl])
            features_s[str(lvl)] = g
        tagline, _, rest = intro.partition("\n")
        desc = tagline.strip("_ ") + ". " + " ".join(rest.split())
        subs.append({"id": sid, "name": title, "class": class_id, "description": desc, "features": features_s})
    return subs, section


# --- invocations and metamagic ----------------------------------------------------------------


def invocations(section):
    out = []
    for title, text in option_sections(section, "Eldritch Invocation Options"):
        pre_m = re.search(r"^_Prerequisite: (.*?)_\s*\n", text)
        body = clean(text[pre_m.end():] if pre_m else text)
        pre = {}
        if pre_m:
            p = pre_m.group(1)
            lm = re.search(r"Level (\d+)\+ Warlock", p)
            if lm:
                pre["class_level"] = {"class": "warlock", "level": int(lm.group(1))}
            req = re.findall(r"([A-Z][\w' ]+?) Invocation", p)
            if req:
                pre["requires"] = [slug(r) for r in req]
            if "Cantrip That Deals Damage" in p:
                pre["spells"] = ["chill-touch", "eldritch-blast", "poison-spray"]
        repeatable = "_Repeatable._" in body
        spells = []
        for sm in re.finditer(r"cast (?:the )?_([^_]+)_", body):
            sid = slug(sm.group(1))
            if sid in SPELLS and sid not in spells:
                spells.append(sid)
        entry = {"id": slug(title), "name": title, "category": "eldritch_invocation",
                 "description": body.split("\n\n")[0]}
        if pre:
            entry["prerequisite"] = pre
        if repeatable:
            entry["repeatable"] = True
        grants = {"traits": [{"name": title, "text": body}]}
        if spells:
            grants["spells"] = spells
        entry["grants"] = grants
        out.append(entry)
    by_id = {e["id"]: e for e in out}
    # Mechanics beyond text.
    by_id["armor-of-shadows"]["grants"]["ac_calculations"] = [{"name": "Mage Armor", "base": 13, "abilities": ["dex"]}]
    for iid in ["agonizing-blast", "eldritch-spear", "repelling-blast"]:
        by_id[iid]["grants"]["choices"] = [{"id": "cantrip", "label": f"{by_id[iid]['name']}: cantrip", "kind": "spell",
                                            "spell_level": 0, "known_only": True,
                                            "allowed": ["chill-touch", "eldritch-blast", "poison-spray"]}]
        by_id[iid]["repeat_requires_different"] = "cantrip"
    by_id["lessons-of-the-first-ones"]["grants"]["choices"] = [{"id": "feat", "label": "Lessons of the First Ones: Origin feat",
                                                                "kind": "feat", "category": "origin"}]
    by_id["pact-of-the-chain"]["grants"]["spells"] = ["find-familiar"]
    by_id["pact-of-the-tome"]["grants"]["choices"] = [
        {"id": "cantrips", "label": "Book of Shadows cantrips", "kind": "spell", "count": 3, "spell_level": 0,
         "always_prepared": True, "rest_change": "short"},
        {"id": "rituals", "label": "Book of Shadows rituals", "kind": "spell", "count": 2, "spell_level": 1, "ritual": True,
         "always_prepared": True, "rest_change": "short"},
    ]
    return out


def metamagic(section):
    out = []
    for title, text in option_sections(section, "Metamagic Options"):
        cost = re.search(r"^_Cost: (.*?)_\s*\n", text)
        body = clean(text[cost.end():] if cost else text)
        out.append({"id": slug(title), "name": title, "category": "metamagic",
                    "description": (f"{cost.group(1)}. " if cost else "") + body.split("\n\n")[0],
                    "grants": {"traits": [{"name": title, "text": (f"Cost: {cost.group(1)}.\n\n" if cost else "") + body}]}})
    return out


# --- feats ------------------------------------------------------------------------------------


def update_feats():
    path = CONTENT / "feats.yaml"
    feats = yaml.safe_load(path.read_text())
    by_id = {f["id"]: f for f in feats}
    for f in feats:
        if f["category"] == "fighting_style":
            f["prerequisite"] = {"trait": "Fighting Style"}
        if f["id"] == "magic-initiate":
            # "Whenever you gain a new level, you can replace one of the spells you chose for this
            # feat with a different spell of the same level from the chosen spell list."
            for c in f["grants"]["choices"]:
                if c["id"] in ("cantrips", "spell"):
                    c.update({"tag": "magic-initiate", "swap": "any_level", "same_level": True})
            f["grants"]["resources"] = [res("free-cast", "Magic Initiate (free level 1 spell)", "long", value=1)]
    new = [
        {"id": "ability-score-improvement", "name": "Ability Score Improvement", "category": "general", "repeatable": True,
         "prerequisite": {"level": 4},
         "description": "Increase one ability score by 2, or two ability scores by 1 (maximum 20).",
         "grants": {"choices": [{"id": "increase", "label": "Ability Score Improvement", "kind": "ability_increase", "count": 2,
                                 "hint": "Pick one ability twice for +2, or two abilities for +1 each."}]}},
        {"id": "grappler", "name": "Grappler", "category": "general",
         "prerequisite": {"level": 4, "abilities": {"any_of": ["str", "dex"], "min": 13}},
         "description": "Str or Dex +1; Punch and Grab, Advantage against creatures you Grapple, move grappled creatures freely.",
         "grants": {"choices": [{"id": "increase", "label": "Grappler: +1 Strength or Dexterity", "kind": "ability_increase",
                                 "allowed": ["str", "dex"]}]}},
    ]
    boons = {
        "boon-of-combat-prowess": ("Boon of Combat Prowess", None, "Peerless Aim: turn a missed attack into a hit, once per turn."),
        "boon-of-dimensional-travel": ("Boon of Dimensional Travel", None, "Blink Steps: teleport 30 ft after the Attack or Magic action."),
        "boon-of-fate": ("Boon of Fate", None, "Improve Fate: add or subtract 2d4 to a D20 Test within 60 ft."),
        "boon-of-irresistible-offense": ("Boon of Irresistible Offense", ["str", "dex"],
                                         "Your Bludgeoning, Piercing, and Slashing damage ignores Resistance; extra damage on a 20."),
        "boon-of-spell-recall": ("Boon of Spell Recall", ["int", "wis", "cha"],
                                 "Free Casting: level 1–4 slots may not be expended (1d4 roll)."),
        "boon-of-the-night-spirit": ("Boon of the Night Spirit", None,
                                     "Invisible as a Bonus Action and resistant to most damage in Dim Light or Darkness."),
        "boon-of-truesight": ("Boon of Truesight", None, "Truesight 60 ft."),
    }
    texts = {m.group(1).strip(): clean(m.group(2)) for m in re.finditer(r"\n#### (.+?)\n(.*?)(?=\n#### |\n### |\Z)", FEATS_MD, re.S)}
    for bid, (name, allowed, desc) in boons.items():
        choice = {"id": "increase", "label": f"{name}: +1 ability", "kind": "ability_increase", "max_score": 30}
        if allowed:
            choice["allowed"] = allowed
        body = re.sub(r"^_Epic Boon Feat.*?_\s*\n", "", texts[name]).strip()
        entry = {"id": bid, "name": name, "category": "epic_boon", "prerequisite": {"level": 19}, "description": desc,
                 "grants": {"choices": [choice], "traits": [{"name": name, "text": body}]}}
        if bid == "boon-of-spell-recall":
            entry["prerequisite"]["spellcasting"] = True
        if bid == "boon-of-truesight":
            entry["grants"]["effects"] = []
        new.append(entry)
    for f in new:
        by_id[f["id"]] = f
    order = ["origin", "general", "fighting_style", "epic_boon"]
    feats = sorted(by_id.values(), key=lambda f: order.index(f["category"]))
    header = ("# yaml-language-server: $schema=../../schemas/feats.schema.json\n"
              "# SRD 5.2.1 — \"Feats\": Origin, General, Fighting Style, and Epic Boon feats. Descriptions summarized.\n")
    path.write_text(header + dump(feats))


def main():
    all_subs = []
    invs = mm = None
    for class_id in ["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"]:
        subs, section = generate_class(class_id)
        all_subs += subs
        if class_id == "warlock":
            invs = invocations(section)
        if class_id == "sorcerer":
            mm = metamagic(section)
    (CONTENT / "subclasses.yaml").write_text(
        "# yaml-language-server: $schema=../../schemas/subclasses.schema.json\n"
        "# SRD 5.2.1 — \"Classes\": the subclass of each class. Feature text is the SRD's; mechanics added by hand.\n"
        + dump(all_subs))
    (CONTENT / "features.yaml").write_text(
        "# yaml-language-server: $schema=../../schemas/features.schema.json\n"
        "# SRD 5.2.1 — Selectable class features: Warlock Eldritch Invocations and Sorcerer Metamagic options.\n"
        + dump(invs + mm))
    update_feats()
    print("ok", len(all_subs), "subclasses,", len(invs), "invocations,", len(mm), "metamagic")


main()
