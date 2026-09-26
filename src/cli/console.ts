/** Minimal terminal I/O with optional ANSI styling, injectable for tests. */

import { createInterface } from "node:readline";

/** The user asked to leave the builder. */
export class QuitBuilder extends Error {}

/** The user asked to abandon the current step and return to the step menu. */
export class BackToMenu extends Error {}

/** Input ended (Ctrl-D, closed pipe, or a test script ran out of answers). */
export class EndOfInput extends Error {}

const STYLES = {
  bold: "1",
  dim: "2",
  red: "31",
  green: "32",
  yellow: "33",
  blue: "34",
  cyan: "36",
} as const;
export type Style = keyof typeof STYLES;

export type InputFn = (prompt: string) => Promise<string>;
export type OutputFn = (text: string) => void;

export interface ConsoleOptions {
  input?: InputFn;
  output?: OutputFn;
  /** Default: on when stdout is a terminal and `NO_COLOR` is not set. */
  color?: boolean;
}

export class Console {
  readonly color: boolean;
  private readonly input: InputFn;
  private readonly output: OutputFn;

  constructor({ input, output, color }: ConsoleOptions = {}) {
    this.input = input ?? terminalInput();
    this.output = output ?? ((text) => process.stdout.write(`${text}\n`));
    this.color = color ?? (Boolean(process.stdout.isTTY) && !("NO_COLOR" in process.env));
  }

  style(text: string, ...styles: Style[]): string {
    if (!this.color || !styles.length) return text;
    return `\x1b[${styles.map((s) => STYLES[s]).join(";")}m${text}\x1b[0m`;
  }

  say(text = ""): void {
    this.output(text);
  }

  title(text: string): void {
    this.say();
    this.say(this.style(`── ${text} ${"─".repeat(Math.max(0, 60 - text.length))}`, "bold", "cyan"));
  }

  error(text: string): void {
    this.say(this.style(`  ✘ ${text}`, "red"));
  }

  warn(text: string): void {
    this.say(this.style(`  ! ${text}`, "yellow"));
  }

  info(text: string): void {
    this.say(this.style(`  ${text}`, "dim"));
  }

  /** Read a line. `quit` and `back` work at every prompt. */
  async ask(prompt: string): Promise<string> {
    let raw: string;
    try {
      raw = (await this.input(this.style(`${prompt} `, "bold"))).trim();
    } catch (error) {
      if (error instanceof EndOfInput) throw new QuitBuilder();
      throw error;
    }
    const lowered = raw.toLowerCase();
    if (["q", "quit", "exit"].includes(lowered)) throw new QuitBuilder();
    if (["b", "back", "menu"].includes(lowered)) throw new BackToMenu();
    return raw;
  }

  async confirm(prompt: string, defaultValue = true): Promise<boolean> {
    const hint = defaultValue ? "[Y/n]" : "[y/N]";
    for (;;) {
      const answer = (await this.ask(`${prompt} ${hint}`)).toLowerCase();
      if (!answer) return defaultValue;
      if (answer === "y" || answer === "yes") return true;
      if (answer === "n" || answer === "no") return false;
    }
  }
}

/**
 * Line input from stdin. Lines are queued as they arrive, so piped input (where many lines
 * arrive before the first prompt) works as well as an interactive terminal.
 */
export function terminalInput(): InputFn {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  const lines: string[] = [];
  let waiting: { resolve: (line: string) => void; reject: (e: Error) => void } | null = null;
  let closed = false;
  rl.on("line", (line) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      w.resolve(line);
    } else {
      lines.push(line);
    }
  });
  rl.on("close", () => {
    closed = true;
    waiting?.reject(new EndOfInput());
    waiting = null;
  });
  return (prompt) => {
    rl.setPrompt(prompt);
    rl.prompt();
    const queued = lines.shift();
    if (queued !== undefined) {
      if (!process.stdin.isTTY) process.stdout.write(`${queued}\n`);
      return Promise.resolve(queued);
    }
    if (closed) return Promise.reject(new EndOfInput());
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
    });
  };
}

/** Input from a fixed list of answers, for tests and scripted sessions. */
export function scriptedInput(answers: Iterable<string>, echo?: OutputFn): InputFn {
  const it = answers[Symbol.iterator]();
  return async (prompt) => {
    echo?.(prompt);
    const { value, done } = it.next();
    if (done) throw new EndOfInput();
    return value;
  };
}
