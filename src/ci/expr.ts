// The GitHub Actions expression language: the `${{ ... }}` fragments in
// workflow files. One evaluator serves both sides of the CI system: the
// server evaluates job-level conditions, concurrency groups, and matrix
// substitutions, and the runner evaluates step-level conditions, env maps,
// and run bodies. Both are this module, so behavior cannot drift.
//
// The language is small: literals, `!`, comparisons, `&&`/`||`, property and
// index dereference on contexts, and a fixed set of functions. `&&` and `||`
// return operand values as in JavaScript. Comparisons follow GitHub's rules:
// equal-typed strings compare case-insensitively, mixed types are cast to
// numbers. The object-filter syntax (`*` in a dereference chain) is not
// implemented; nothing in scope uses it and it fails with a clear message.

export type ExprValue = null | boolean | number | string | ExprValue[] | { [k: string]: ExprValue };

export type ExprFunction = (...args: ExprValue[]) => ExprValue;

export interface ExprEnv {
  contexts: Record<string, ExprValue>;
  functions?: Record<string, ExprFunction>;
}

export class ExprError extends Error {}

// ---- tokenizer ----

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'str'; value: string }
  | { kind: 'ident'; value: string }
  | { kind: 'op'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c === "'") {
      // Single-quoted string; '' is an escaped quote.
      let s = '';
      i++;
      for (;;) {
        if (i >= src.length) throw new ExprError('unterminated string literal');
        if (src[i] === "'") {
          if (src[i + 1] === "'") {
            s += "'";
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          s += src[i++];
        }
      }
      tokens.push({ kind: 'str', value: s });
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=' || two === '&&' || two === '||') {
      tokens.push({ kind: 'op', value: two });
      i += 2;
      continue;
    }
    if ('!<>()[].,'.includes(c)) {
      tokens.push({ kind: 'op', value: c });
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9.]/.test(src[i + 1] ?? ''))) {
      const m = src.slice(i).match(/^-?(0x[0-9a-fA-F]+|\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+)/);
      if (!m) throw new ExprError(`invalid number at: ${src.slice(i, i + 12)}`);
      tokens.push({ kind: 'num', value: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = src.slice(i).match(/^[A-Za-z_][A-Za-z0-9_-]*/);
      tokens.push({ kind: 'ident', value: m![0] });
      i += m![0].length;
      continue;
    }
    if (c === '*') {
      throw new ExprError('the object-filter syntax (*) is not supported');
    }
    throw new ExprError(`unexpected character '${c}' in expression`);
  }
  return tokens;
}

// ---- parser (to a small AST) ----

type Node =
  | { t: 'lit'; v: ExprValue }
  | { t: 'ctx'; name: string }
  | { t: 'not'; e: Node }
  | { t: 'bin'; op: string; l: Node; r: Node }
  | { t: 'deref'; e: Node; prop: string }
  | { t: 'index'; e: Node; i: Node }
  | { t: 'call'; name: string; args: Node[] };

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  parse(): Node {
    const n = this.or();
    if (this.pos < this.tokens.length) {
      throw new ExprError(`unexpected token after expression: ${JSON.stringify(this.tokens[this.pos])}`);
    }
    return n;
  }

  private peekOp(v: string): boolean {
    const t = this.tokens[this.pos];
    return t !== undefined && t.kind === 'op' && t.value === v;
  }

  private eatOp(v: string): boolean {
    if (this.peekOp(v)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectOp(v: string): void {
    if (!this.eatOp(v)) throw new ExprError(`expected '${v}' in expression`);
  }

  private or(): Node {
    let l = this.and();
    while (this.eatOp('||')) l = { t: 'bin', op: '||', l, r: this.and() };
    return l;
  }

  private and(): Node {
    let l = this.equality();
    while (this.eatOp('&&')) l = { t: 'bin', op: '&&', l, r: this.equality() };
    return l;
  }

  private equality(): Node {
    let l = this.comparison();
    for (;;) {
      if (this.eatOp('==')) l = { t: 'bin', op: '==', l, r: this.comparison() };
      else if (this.eatOp('!=')) l = { t: 'bin', op: '!=', l, r: this.comparison() };
      else return l;
    }
  }

  private comparison(): Node {
    let l = this.unary();
    for (;;) {
      if (this.eatOp('<=')) l = { t: 'bin', op: '<=', l, r: this.unary() };
      else if (this.eatOp('>=')) l = { t: 'bin', op: '>=', l, r: this.unary() };
      else if (this.eatOp('<')) l = { t: 'bin', op: '<', l, r: this.unary() };
      else if (this.eatOp('>')) l = { t: 'bin', op: '>', l, r: this.unary() };
      else return l;
    }
  }

  private unary(): Node {
    if (this.eatOp('!')) return { t: 'not', e: this.unary() };
    return this.postfix();
  }

  private postfix(): Node {
    let n = this.primary();
    for (;;) {
      if (this.eatOp('.')) {
        const t = this.tokens[this.pos];
        if (!t || t.kind !== 'ident') throw new ExprError("expected a property name after '.'");
        this.pos++;
        n = { t: 'deref', e: n, prop: t.value };
      } else if (this.eatOp('[')) {
        const i = this.or();
        this.expectOp(']');
        n = { t: 'index', e: n, i };
      } else {
        return n;
      }
    }
  }

  private primary(): Node {
    const t = this.tokens[this.pos];
    if (!t) throw new ExprError('unexpected end of expression');
    if (t.kind === 'num') {
      this.pos++;
      return { t: 'lit', v: t.value };
    }
    if (t.kind === 'str') {
      this.pos++;
      return { t: 'lit', v: t.value };
    }
    if (t.kind === 'op' && t.value === '(') {
      this.pos++;
      const n = this.or();
      this.expectOp(')');
      return n;
    }
    if (t.kind === 'ident') {
      this.pos++;
      const lower = t.value.toLowerCase();
      if (lower === 'null') return { t: 'lit', v: null };
      if (lower === 'true') return { t: 'lit', v: true };
      if (lower === 'false') return { t: 'lit', v: false };
      if (this.eatOp('(')) {
        const args: Node[] = [];
        if (!this.peekOp(')')) {
          do {
            args.push(this.or());
          } while (this.eatOp(','));
        }
        this.expectOp(')');
        return { t: 'call', name: lower, args };
      }
      return { t: 'ctx', name: t.value };
    }
    throw new ExprError(`unexpected token in expression: ${JSON.stringify(t)}`);
  }
}

// ---- evaluation ----

export function truthy(v: ExprValue): boolean {
  if (v === null || v === false) return false;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  if (typeof v === 'string') return v !== '';
  return true; // arrays and objects
}

function toNumber(v: ExprValue): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return 0;
    return Number(s);
  }
  return NaN;
}

function compareEqual(l: ExprValue, r: ExprValue): boolean {
  if (typeof l === 'string' && typeof r === 'string') return l.toLowerCase() === r.toLowerCase();
  if (typeof l === typeof r && (l === null) === (r === null)) {
    if (typeof l === 'number') {
      return !Number.isNaN(l) && !Number.isNaN(r as number) && l === r;
    }
    if (typeof l === 'boolean' || l === null) return l === r;
    // Arrays and objects: equal only when the same instance, per GitHub.
    if (typeof l === 'object') return l === r;
  }
  const ln = toNumber(l);
  const rn = toNumber(r);
  return !Number.isNaN(ln) && !Number.isNaN(rn) && ln === rn;
}

function compareOrder(op: string, l: ExprValue, r: ExprValue): boolean {
  if (typeof l === 'string' && typeof r === 'string') {
    const a = l.toLowerCase();
    const b = r.toLowerCase();
    if (op === '<') return a < b;
    if (op === '<=') return a <= b;
    if (op === '>') return a > b;
    return a >= b;
  }
  const a = toNumber(l);
  const b = toNumber(r);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (op === '<') return a < b;
  if (op === '<=') return a <= b;
  if (op === '>') return a > b;
  return a >= b;
}

// Property access is case-insensitive, preferring an exact match.
function getProp(obj: ExprValue, prop: string): ExprValue {
  if (obj === null || typeof obj !== 'object') return null;
  if (Array.isArray(obj)) return null;
  if (Object.prototype.hasOwnProperty.call(obj, prop)) return obj[prop];
  const lower = prop.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k.toLowerCase() === lower) return obj[k];
  }
  return null;
}

export function stringify(v: ExprValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function formatFn(args: ExprValue[]): ExprValue {
  if (args.length === 0 || typeof args[0] !== 'string') throw new ExprError('format() needs a format string');
  const fmt = args[0];
  let out = '';
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i];
    if (c === '{') {
      if (fmt[i + 1] === '{') {
        out += '{';
        i += 2;
        continue;
      }
      const m = fmt.slice(i).match(/^\{(\d+)\}/);
      if (!m) throw new ExprError('malformed placeholder in format()');
      const idx = parseInt(m[1], 10) + 1;
      if (idx >= args.length) throw new ExprError(`format() placeholder {${m[1]}} has no argument`);
      out += stringify(args[idx]);
      i += m[0].length;
    } else if (c === '}') {
      if (fmt[i + 1] === '}') {
        out += '}';
        i += 2;
      } else {
        throw new ExprError("unescaped '}' in format()");
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

function containsFn(hay: ExprValue, needle: ExprValue): ExprValue {
  if (Array.isArray(hay)) return hay.some((x) => compareEqual(x, needle));
  return stringify(hay).toLowerCase().includes(stringify(needle).toLowerCase());
}

const BUILTINS: Record<string, ExprFunction> = {
  contains: (a, b) => containsFn(a, b),
  startswith: (a, b) => stringify(a).toLowerCase().startsWith(stringify(b).toLowerCase()),
  endswith: (a, b) => stringify(a).toLowerCase().endsWith(stringify(b).toLowerCase()),
  format: (...args) => formatFn(args),
  join: (a, sep) => {
    const s = sep === undefined ? ',' : stringify(sep);
    if (Array.isArray(a)) return a.map(stringify).join(s);
    return stringify(a);
  },
  tojson: (a) => JSON.stringify(a === undefined ? null : a, null, 2),
  fromjson: (a) => {
    try {
      return JSON.parse(stringify(a)) as ExprValue;
    } catch {
      throw new ExprError(`fromJSON(): invalid JSON: ${stringify(a).slice(0, 80)}`);
    }
  },
  hashfiles: () => {
    throw new ExprError('hashFiles() is not supported yet');
  },
};

function evalNode(n: Node, env: ExprEnv): ExprValue {
  switch (n.t) {
    case 'lit':
      return n.v;
    case 'ctx': {
      const v = getProp(env.contexts as ExprValue, n.name);
      if (v === null && !Object.keys(env.contexts).some((k) => k.toLowerCase() === n.name.toLowerCase())) {
        throw new ExprError(`unknown context or value: ${n.name}`);
      }
      return v;
    }
    case 'not':
      return !truthy(evalNode(n.e, env));
    case 'bin': {
      if (n.op === '&&') {
        const l = evalNode(n.l, env);
        return truthy(l) ? evalNode(n.r, env) : l;
      }
      if (n.op === '||') {
        const l = evalNode(n.l, env);
        return truthy(l) ? l : evalNode(n.r, env);
      }
      const l = evalNode(n.l, env);
      const r = evalNode(n.r, env);
      if (n.op === '==') return compareEqual(l, r);
      if (n.op === '!=') return !compareEqual(l, r);
      return compareOrder(n.op, l, r);
    }
    case 'deref':
      return getProp(evalNode(n.e, env), n.prop);
    case 'index': {
      const obj = evalNode(n.e, env);
      const idx = evalNode(n.i, env);
      if (Array.isArray(obj)) {
        const i = toNumber(idx);
        if (!Number.isInteger(i) || i < 0 || i >= obj.length) return null;
        return obj[i];
      }
      return getProp(obj, stringify(idx));
    }
    case 'call': {
      const fn = env.functions?.[n.name] ?? BUILTINS[n.name];
      if (!fn) throw new ExprError(`unknown function: ${n.name}`);
      return fn(...n.args.map((a) => evalNode(a, env)));
    }
  }
}

export function evaluate(expression: string, env: ExprEnv): ExprValue {
  return evalNode(new Parser(tokenize(expression)).parse(), env);
}

// ---- ${{ }} interpolation over strings ----

// Find the ${{ ... }} spans in a string, respecting single-quoted string
// literals inside the expression (which may contain '}}').
function findSpans(s: string): { start: number; end: number; expr: string }[] {
  const spans: { start: number; end: number; expr: string }[] = [];
  let i = 0;
  while (i < s.length) {
    const start = s.indexOf('${{', i);
    if (start === -1) break;
    let j = start + 3;
    let inStr = false;
    let end = -1;
    while (j < s.length) {
      const c = s[j];
      if (inStr) {
        if (c === "'") {
          if (s[j + 1] === "'") j++;
          else inStr = false;
        }
      } else if (c === "'") {
        inStr = true;
      } else if (c === '}' && s[j + 1] === '}') {
        end = j;
        break;
      }
      j++;
    }
    if (end === -1) throw new ExprError('unterminated ${{ in string');
    spans.push({ start, end: end + 2, expr: s.slice(start + 3, end).trim() });
    i = end + 2;
  }
  return spans;
}

// Replace every ${{ expr }} in a string with the stringified result.
export function render(s: string, env: ExprEnv): string {
  const spans = findSpans(s);
  if (spans.length === 0) return s;
  let out = '';
  let pos = 0;
  for (const sp of spans) {
    out += s.slice(pos, sp.start);
    out += stringify(evaluate(sp.expr, env));
    pos = sp.end;
  }
  return out + s.slice(pos);
}

// Render every string leaf of a template value (e.g. an env map).
export function renderDeep(v: unknown, env: ExprEnv): ExprValue {
  if (typeof v === 'string') return render(v, env);
  if (Array.isArray(v)) return v.map((x) => renderDeep(x, env));
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, ExprValue> = {};
    for (const [k, val] of Object.entries(v)) out[k] = renderDeep(val, env);
    return out;
  }
  return v === undefined ? null : (v as ExprValue);
}

// An `if:` condition: bare expressions are wrapped implicitly; a condition
// that is exactly one ${{ }} evaluates to its value; a mixed string renders
// first and the resulting text is judged (GitHub's much-lamented behavior,
// reproduced here so workflows behave identically).
export function evalCondition(cond: string, env: ExprEnv): boolean {
  const trimmed = cond.trim();
  if (trimmed === '') return true;
  if (!trimmed.includes('${{')) return truthy(evaluate(trimmed, env));
  const spans = findSpans(trimmed);
  if (spans.length === 1 && spans[0].start === 0 && spans[0].end === trimmed.length) {
    return truthy(evaluate(spans[0].expr, env));
  }
  const rendered = render(trimmed, env).trim().toLowerCase();
  return rendered !== '' && rendered !== 'false' && rendered !== '0' && rendered !== 'null';
}

// Whether a condition references a status function that overrides the
// default success() gate (always(), failure(), cancelled()).
export function mentionsStatusOverride(cond: string): boolean {
  return /\b(always|failure|cancelled)\s*\(/.test(cond);
}

// An `if:` on a step or a job, judged with the status of what came before it.
// GitHub prepends an implicit `success() &&` unless the condition itself
// names a status function, so once something has failed a plain
// `if: github.ref == 'refs/heads/main'` skips however the comparison comes
// out, while `if: always()` and `if: failure()` are judged on their own
// terms. An absent condition is the bare gate.
export function evalGatedCondition(cond: string | undefined, succeeded: boolean, env: ExprEnv): boolean {
  if (cond === undefined) return succeeded;
  if (!succeeded && !mentionsStatusOverride(cond)) return false;
  return evalCondition(cond, env);
}
