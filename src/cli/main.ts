/**
 * `srd-rules` command line:
 *
 *   srd-rules build     [--load file.json] [--seed N] [--no-color] [--save-dir dir] [--content dir]...
 *   srd-rules play      --load build.json [--state file.state.json] [--seed N] [--save-dir dir]
 *   srd-rules fight     --load a.json [--load b.json]... --monster id... [--ask] [--encounter file]
 *   srd-rules serve     [--port 8000] [--host 127.0.0.1] [--cors] [--content dir]...
 *   srd-rules validate  <content dir>...
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Catalog, ContentError, createCatalog } from "../content/catalog";
import { loadContentPack } from "../content/load";
import { srdPack } from "../content/srd";
import { createHandler } from "../http/index";
import { serveNode } from "../http/node-server";
import { type CharacterBuild, parseBuild } from "../models/build";
import { parseEncounter } from "../models/encounter";
import { parseState } from "../models/state";
import { mathRng, seededRng } from "../rules/rng";
import { BuilderApp } from "./builder";
import { Console } from "./console";
import { FightApp, slugOf } from "./fight";
import { PlayApp } from "./play";

const USAGE = `Usage: srd-rules <command> [options]

Commands:
  build      Interactive character builder (default)
  play       Track a built character in play: HP, slots, conditions, inventory
  fight      Run an encounter: saved characters against SRD monsters
  serve      Start the HTTP API
  validate   Check content directories (e.g. homebrew) against the schemas

Options:
  --content <dir>   Layer a content directory over the SRD (repeatable)
  --load <file>     build: resume a saved build (JSON); play: the build to play;
                    fight: a character (repeatable; its saved state is used if there is one)
  --monster <id>    fight: add an SRD monster (repeatable)
  --encounter <f>   fight: resume a saved encounter
  --ask             fight: players decide after a roll (Bardic Inspiration, Legendary Resistance)
  --state <file>    play: resume a saved state (default: a fresh one)
  --seed <n>        build/play: seed for dice rolls
  --save-dir <dir>  build/play: where to save (default: characters)
  --no-color        build/play: disable colors
  --port <n>        serve: port (default: 8000)
  --host <host>     serve: host (default: 127.0.0.1)
  --cors            serve: allow cross-origin browser requests
`;

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      content: { type: "string", multiple: true, default: [] },
      load: { type: "string", multiple: true, default: [] },
      monster: { type: "string", multiple: true, default: [] },
      encounter: { type: "string" },
      ask: { type: "boolean", default: false },
      seed: { type: "string" },
      state: { type: "string" },
      "save-dir": { type: "string", default: "characters" },
      "no-color": { type: "boolean", default: false },
      port: { type: "string", default: "8000" },
      host: { type: "string", default: "127.0.0.1" },
      cors: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command = "build", ...rest] = positionals;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const catalog = (): Catalog =>
    createCatalog(srdPack, ...(values.content ?? []).map((dir) => loadContentPack(dir)));

  switch (command) {
    case "build": {
      const first = values.load?.[0];
      const build = first ? parseBuild(JSON.parse(readFileSync(first, "utf-8"))) : undefined;
      const con = new Console({ color: values["no-color"] ? false : undefined });
      const app = new BuilderApp(con, catalog(), {
        build,
        rng: values.seed !== undefined ? seededRng(Number(values.seed)) : mathRng,
        saveDir: values["save-dir"],
      });
      await app.run();
      process.stdin.destroy();
      return 0;
    }
    case "play": {
      const first = values.load?.[0];
      if (!first) {
        process.stderr.write("play: give the build with --load <file>\n");
        return 2;
      }
      const build = parseBuild(JSON.parse(readFileSync(first, "utf-8")));
      const state = values.state
        ? parseState(JSON.parse(readFileSync(values.state, "utf-8")))
        : undefined;
      const con = new Console({ color: values["no-color"] ? false : undefined });
      const app = new PlayApp(con, catalog(), build, {
        state,
        rng: values.seed !== undefined ? seededRng(Number(values.seed)) : mathRng,
        saveDir: values["save-dir"],
      });
      await app.run();
      process.stdin.destroy();
      return 0;
    }
    case "fight": {
      const saveDir = values["save-dir"] ?? "characters";
      const builds: CharacterBuild[] = (values.load ?? []).map((file) =>
        parseBuild(JSON.parse(readFileSync(file, "utf-8"))),
      );
      // Each character resumes from its play-mode state file, when there is one.
      const states = Object.fromEntries(
        builds.flatMap((b) => {
          const path = join(saveDir, `${slugOf(b.name)}.state.json`);
          return existsSync(path)
            ? [[slugOf(b.name), parseState(JSON.parse(readFileSync(path, "utf-8")))]]
            : [];
        }),
      );
      const encounter = values.encounter
        ? parseEncounter(JSON.parse(readFileSync(values.encounter, "utf-8")))
        : undefined;
      const con = new Console({ color: values["no-color"] ? false : undefined });
      const app = new FightApp(con, catalog(), {
        builds,
        states,
        monsters: values.monster,
        encounter,
        rng: values.seed !== undefined ? seededRng(Number(values.seed)) : mathRng,
        saveDir,
        ask: values.ask,
      });
      await app.run();
      process.stdin.destroy();
      return 0;
    }
    case "serve": {
      const handler = createHandler({ catalog: catalog(), cors: values.cors });
      const port = Number(values.port);
      await serveNode(handler, { port, host: values.host });
      process.stdout.write(`Listening on http://${values.host}:${port}  (try GET /health)\n`);
      return new Promise(() => {}); // run until killed
    }
    case "validate": {
      if (!rest.length) {
        process.stderr.write("validate: give one or more content directories\n");
        return 2;
      }
      const packs = rest.map((dir) => loadContentPack(dir));
      const layered = createCatalog(srdPack, ...packs);
      for (const pack of packs) {
        const counts = Object.entries(pack)
          .filter(([k, v]) => Array.isArray(v) && k !== "name")
          .map(([k, v]) => `${(v as unknown[]).length} ${k}`);
        process.stdout.write(`✔ ${pack.name}: ${counts.join(", ") || "no entities"}\n`);
      }
      process.stdout.write(`Catalog OK (${Object.keys(layered.feats).length} feats in total)\n`);
      return 0;
    }
    default:
      process.stderr.write(`Unknown command '${command}'\n\n${USAGE}`);
      return 2;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ContentError) {
      process.stderr.write(`Content error:\n${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exitCode = 1;
  },
);
