# Data Sources

Every rules entity in `content/` carries a `source` field. Current sources:

| `source` | Where | License |
|---|---|---|
| `srd-5.2.1` | `content/srd-5.2.1/` | CC-BY-4.0 |

## SRD 5.2.1

This work includes material taken from the System Reference Document 5.2.1 ("SRD 5.2.1")
by Wizards of the Coast LLC and available at https://www.dndbeyond.com/srd. The SRD 5.2.1
is licensed under the Creative Commons Attribution 4.0 International License available at
https://creativecommons.org/licenses/by/4.0/legalcode.

Transcribed from the Markdown edition in `data/srd-5-2-1/` (a local copy of
`downfallx/dnd-5e-srd-markdown`; the folder is git-ignored, so it isn't committed):

| File | SRD section | Notes |
|---|---|---|
| `creation.yaml` | Character Creation (steps 2–3) | standard array, point buy, languages |
| `species.yaml` | Character Origins › Species | trait text summarized |
| `backgrounds.yaml` | Character Origins › Backgrounds | |
| `feats.yaml` | Feats › Origin, Fighting Style | descriptions summarized |
| `classes/fighter.yaml` | Classes › Fighter | level 1 only |
| `weapons.yaml`, `armor.yaml` | Equipment tables | generated from the tables, then reviewed |
| `tools.yaml`, `gear.yaml`, `masteries.yaml`, `languages.yaml` | Equipment, Character Creation | only what the builder uses so far |

Non-SRD content must use a different `source` value and be listed here.
