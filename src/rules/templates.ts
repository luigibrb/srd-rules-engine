/**
 * Stat blocks that scale (summoned creatures: "AC 11 + the spell's level", "Bonus equals your
 * spell attack modifier"): a template is a stat block whose values can be expressions over
 * variables (`spell_level`, `pb`, `spell_attack`, `spell_dc`, `ability_mod`, and the choices made
 * when summoning, like `form`). `instantiateTemplate` turns it into a plain stat block.
 *
 * - A string `"=<expression>"` becomes its value: `"=11 + spell_level"`, `"=floor(spell_level / 2)"`.
 * - `{<expression>}` inside a string is replaced by its value: `"{form}"`, `"{spell_level}d8"`.
 * - An object with `only: "<condition>"` is kept only when the condition holds (`"form == 'spider'"`,
 *   `"spell_level >= 4"`), and `only` is dropped; `{ only, value }` becomes its `value`.
 *
 * Expressions: numbers, `'strings'`, variables, `+ - * /`, comparisons (`== != < <= > >=`),
 * `and`, `or`, `not`, parentheses, `floor`, `ceil`, `min`, `max`, and `if(condition, a, b)`.
 */

export type TemplateValue = number | string | boolean;
export type TemplateVars = Readonly<Record<string, TemplateValue>>;

export class TemplateError extends Error {
  override name = "TemplateError";
}

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
  floor: Math.floor,
  ceil: Math.ceil,
  min: Math.min,
  max: Math.max,
};

type Token = { kind: "num" | "str" | "id" | "op"; text: string };

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|'([^']*)'|([A-Za-z_][A-Za-z0-9_]*)|(==|!=|<=|>=|[-+*/()<>,]))/y;
  let at = 0;
  while (at < expr.length) {
    if (/^\s*$/.test(expr.slice(at))) break;
    re.lastIndex = at;
    const m = re.exec(expr);
    if (!m) throw new TemplateError(`can't read '${expr.slice(at)}' in '${expr}'`);
    at = re.lastIndex;
    if (m[1] !== undefined) tokens.push({ kind: "num", text: m[1] });
    else if (m[2] !== undefined) tokens.push({ kind: "str", text: m[2] });
    else if (m[3] !== undefined) tokens.push({ kind: "id", text: m[3] });
    else tokens.push({ kind: "op", text: m[4] as string });
  }
  return tokens;
}

/** The value of an expression with these variables. */
export function evaluateExpression(expr: string, vars: TemplateVars): TemplateValue {
  const tokens = tokenize(expr);
  let i = 0;
  const peek = () => tokens[i];
  const take = (text?: string): Token => {
    const t = tokens[i];
    if (!t || (text !== undefined && t.text !== text)) {
      throw new TemplateError(`expected ${text ?? "a value"} in '${expr}'`);
    }
    i++;
    return t;
  };
  const num = (v: TemplateValue): number => {
    if (typeof v !== "number") throw new TemplateError(`'${v}' isn't a number in '${expr}'`);
    return v;
  };
  const or = (): TemplateValue => {
    let v = and();
    while (peek()?.text === "or") {
      take();
      const r = and();
      v = Boolean(v) || Boolean(r);
    }
    return v;
  };
  const and = (): TemplateValue => {
    let v = comparison();
    while (peek()?.text === "and") {
      take();
      const r = comparison();
      v = Boolean(v) && Boolean(r);
    }
    return v;
  };
  const comparison = (): TemplateValue => {
    const left = additive();
    const op = peek()?.text;
    if (!op || !["==", "!=", "<", "<=", ">", ">="].includes(op)) return left;
    take();
    const right = additive();
    switch (op) {
      case "==":
        return left === right;
      case "!=":
        return left !== right;
      case "<":
        return num(left) < num(right);
      case "<=":
        return num(left) <= num(right);
      case ">":
        return num(left) > num(right);
      default:
        return num(left) >= num(right);
    }
  };
  const additive = (): TemplateValue => {
    let v = multiplicative();
    while (peek()?.text === "+" || peek()?.text === "-") {
      const op = take().text;
      const r = multiplicative();
      v = op === "+" ? num(v) + num(r) : num(v) - num(r);
    }
    return v;
  };
  const multiplicative = (): TemplateValue => {
    let v = unary();
    while (peek()?.text === "*" || peek()?.text === "/") {
      const op = take().text;
      const r = unary();
      v = op === "*" ? num(v) * num(r) : num(v) / num(r);
    }
    return v;
  };
  const unary = (): TemplateValue => {
    if (peek()?.text === "-") {
      take();
      return -num(unary());
    }
    if (peek()?.text === "not") {
      take();
      return !unary();
    }
    return primary();
  };
  const primary = (): TemplateValue => {
    const t = take();
    if (t.kind === "num") return Number(t.text);
    if (t.kind === "str") return t.text;
    if (t.text === "(") {
      const v = or();
      take(")");
      return v;
    }
    if (t.kind === "id") {
      if (t.text === "if" && peek()?.text === "(") {
        take("(");
        const condition = or();
        take(",");
        const a = or();
        take(",");
        const b = or();
        take(")");
        return condition ? a : b;
      }
      const fn = FUNCTIONS[t.text];
      if (fn && peek()?.text === "(") {
        take("(");
        const args = [num(or())];
        while (peek()?.text === ",") {
          take();
          args.push(num(or()));
        }
        take(")");
        return fn(...args);
      }
      if (t.text === "true" || t.text === "false") return t.text === "true";
      const v = vars[t.text];
      if (v === undefined) throw new TemplateError(`unknown variable '${t.text}' in '${expr}'`);
      return v;
    }
    throw new TemplateError(`unexpected '${t.text}' in '${expr}'`);
  };
  const value = or();
  if (i < tokens.length) throw new TemplateError(`unexpected '${tokens[i]?.text}' in '${expr}'`);
  return value;
}

const DROP = Symbol("drop");

/** A template with its expressions evaluated and the parts that don't apply dropped. */
export function instantiateTemplate(template: unknown, vars: TemplateVars): unknown {
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      if (node.startsWith("=")) return evaluateExpression(node.slice(1), vars);
      return node.replace(/\{([^{}]+)\}/g, (_, e: string) => String(evaluateExpression(e, vars)));
    }
    if (Array.isArray(node)) return node.map(walk).filter((x) => x !== DROP);
    if (node && typeof node === "object") {
      const obj = node as Record<string, unknown>;
      if ("only" in obj) {
        if (typeof obj.only !== "string") throw new TemplateError("`only` must be a condition");
        if (!evaluateExpression(obj.only, vars)) return DROP;
        const keys = Object.keys(obj).filter((k) => k !== "only");
        if (keys.length === 1 && keys[0] === "value") return walk(obj.value);
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "only") continue;
        const w = walk(v);
        if (w !== DROP) out[k] = w;
      }
      return out;
    }
    return node;
  };
  const result = walk(template);
  if (result === DROP) throw new TemplateError("the whole template was dropped by its `only`");
  return result;
}
