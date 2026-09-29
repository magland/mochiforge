import { CliError, EXIT_USAGE, setJsonErrors } from './exit';

// One argument parser for the whole CLI, in place of a hand-rolled option loop
// per command family. It is not a dependency because the requirement is
// modest: a registry of commands, option specifications with a type so that
// parsing and validation are declared once, and help generated from the
// registry rather than written out by hand.
//
// Generated help is the point rather than a nicety. A single dump of every
// command is unreadable at seventy commands, and the reader is frequently a
// program with a context window: `mochi --help` lists groups, `mochi
// issue --help` lists that group, and `mochi issue create --help` lists one
// command's options. `mochi commands --json` dumps the whole registry for a
// caller that would rather not read prose at all.

export type OptionType = 'string' | 'boolean' | 'int' | 'string[]' | 'string?';

export interface OptionSpec {
  /** Long name, without the leading dashes. */
  name: string;
  type: OptionType;
  summary: string;
  /** Placeholder shown in help for a value-taking option, e.g. "<glob>". */
  value?: string;
  /** Single-letter alias, without the dash. */
  short?: string;
  /** Accepted but left out of help: a removed option kept only to explain itself. */
  hidden?: boolean;
}

export interface ArgSpec {
  name: string;
  required?: boolean;
  /** Takes every remaining positional argument. */
  variadic?: boolean;
}

export interface Invocation {
  /** Positional arguments, in order. */
  args: string[];
  /** Everything after the command path, unparsed. Only useful to a raw command. */
  argv: string[];
  /** Print this command's help and exit 0. */
  help(): never;
  str(name: string): string | null;
  int(name: string): number | null;
  bool(name: string): boolean;
  list(name: string): string[];
  /** A 'string?' option: true when given bare, the value when given one. */
  optional(name: string): string | boolean;
}

export interface Command {
  /** e.g. ['issue', 'create']. A one-element path is a top-level command. */
  path: string[];
  summary: string;
  /** Longer help, shown by `mochi <command> --help`. */
  description?: string;
  options?: OptionSpec[];
  args?: ArgSpec[];
  /**
   * The command parses its own arguments and reads inv.argv. For the commands
   * whose existing hand-rolled parsing is not worth disturbing; they are still
   * dispatched here and still appear in help.
   */
  raw?: boolean;
  run(inv: Invocation): void | Promise<void>;
}

export interface Group {
  name: string;
  summary: string;
}

export interface Cli {
  /** The program name, as it appears in help. */
  name: string;
  groups: Group[];
  commands: Command[];
  /** Printed at the end of the top-level help. */
  footer?: string;
}

function usageError(message: string): never {
  throw new CliError(message, EXIT_USAGE);
}

// ---- suggestions ----

function editDistance(a: string, b: string): number {
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  const cur = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j];
  }
  return prev[b.length];
}

/** The closest of `among` to `word`, when something is within two edits of it. */
function nearest(word: string, among: string[]): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const c of among) {
    const d = editDistance(word, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

// ---- option lookup ----

function findOption(cmd: Command, name: string): OptionSpec | null {
  return (cmd.options ?? []).find((o) => o.name === name) ?? null;
}

function findShort(cmd: Command, letter: string): OptionSpec | null {
  return (cmd.options ?? []).find((o) => o.short === letter) ?? null;
}

// A field list is how a 'string?' option's value is recognised when it is not
// attached with '='. Requiring a comma is what keeps `repo list --json mycoll`
// from swallowing the collection: a single field must be written
// `--json=title`, which the option's help says.
function looksLikeFieldList(token: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*(,[A-Za-z][A-Za-z0-9_]*)+$/.test(token);
}

// ---- parsing ----

type Value = string | boolean | number | string[];

function parseOptions(cmd: Command, argv: string[]): { values: Map<string, Value>; args: string[] } {
  const values = new Map<string, Value>();
  const args: string[] = [];
  const names = (cmd.options ?? []).filter((o) => !o.hidden).map((o) => o.name);

  const take = (spec: OptionSpec, inline: string | undefined, argv: string[], i: number): number => {
    let value: string;
    if (inline !== undefined) value = inline;
    else if (i + 1 < argv.length) value = argv[++i];
    else usageError(`--${spec.name} needs a value${spec.value ? `: --${spec.name} ${spec.value}` : ''}`);
    if (spec.type === 'string[]') {
      const list = (values.get(spec.name) as string[] | undefined) ?? [];
      list.push(value);
      values.set(spec.name, list);
    } else if (spec.type === 'int') {
      const n = Number(value);
      if (!Number.isInteger(n)) usageError(`--${spec.name} takes a whole number, not '${value}'`);
      values.set(spec.name, n);
    } else {
      values.set(spec.name, value);
    }
    return i;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      const inline = eq === -1 ? undefined : a.slice(eq + 1);
      const spec = findOption(cmd, name);
      if (!spec) {
        const near = nearest(name, names);
        usageError(
          `unknown option --${name} for '${cmd.path.join(' ')}'` +
            (near ? `; did you mean --${near}?` : `. Run 'mochi ${cmd.path.join(' ')} --help'.`)
        );
      }
      if (spec.type === 'boolean') {
        if (inline !== undefined) usageError(`--${name} takes no value`);
        values.set(name, true);
      } else if (spec.type === 'string?') {
        if (inline !== undefined) values.set(name, inline);
        else if (i + 1 < argv.length && !argv[i + 1].startsWith('-') && looksLikeFieldList(argv[i + 1])) {
          values.set(name, argv[++i]);
        } else values.set(name, true);
      } else {
        i = take(spec, inline, argv, i);
      }
      continue;
    }
    // A lone '-' is a positional: several options take it to mean stdin.
    if (a.startsWith('-') && a.length > 1) {
      const spec = findShort(cmd, a.slice(1));
      if (!spec) usageError(`unknown option ${a} for '${cmd.path.join(' ')}'. Run 'mochi ${cmd.path.join(' ')} --help'.`);
      if (spec.type === 'boolean') values.set(spec.name, true);
      else i = take(spec, undefined, argv, i);
      continue;
    }
    args.push(a);
  }
  return { values, args };
}

function checkArgs(cmd: Command, args: string[]): void {
  const specs = cmd.args ?? [];
  const required = specs.filter((s) => s.required).length;
  if (args.length < required) {
    usageError(`'mochi ${cmd.path.join(' ')}' needs ${usageLine(cmd)}`);
  }
  const variadic = specs.some((s) => s.variadic);
  if (!variadic && args.length > specs.length) {
    usageError(`unexpected argument '${args[specs.length]}' to 'mochi ${cmd.path.join(' ')}'`);
  }
}

function invocationFor(cli: Cli, cmd: Command, argv: string[]): Invocation {
  const { values, args } = cmd.raw ? { values: new Map<string, Value>(), args: [] } : parseOptions(cmd, argv);
  if (!cmd.raw) checkArgs(cmd, args);
  if (values.has('json')) setJsonErrors(true);
  return {
    args,
    argv,
    help: () => {
      process.stdout.write(commandHelp(cli, cmd));
      process.exit(0);
    },
    str: (name) => {
      const v = values.get(name);
      return typeof v === 'string' ? v : null;
    },
    int: (name) => {
      const v = values.get(name);
      return typeof v === 'number' ? v : null;
    },
    bool: (name) => values.get(name) === true,
    list: (name) => {
      const v = values.get(name);
      return Array.isArray(v) ? v : [];
    },
    optional: (name) => {
      const v = values.get(name);
      if (typeof v === 'string') return v;
      return v === true;
    },
  };
}

// ---- help ----

function usageLine(cmd: Command): string {
  return (cmd.args ?? [])
    .map((a) => (a.required ? `<${a.name}>` : `[<${a.name}>]`) + (a.variadic ? '...' : ''))
    .join(' ');
}

function optionLine(o: OptionSpec): string {
  const short = o.short ? `-${o.short}, ` : '';
  const value = o.type === 'boolean' ? '' : ` ${o.value ?? '<value>'}`;
  const repeat = o.type === 'string[]' ? '...' : '';
  return `${short}--${o.name}${value}${repeat}`;
}

function pad(rows: [string, string][], indent = '  '): string {
  const width = rows.reduce((w, [left]) => Math.max(w, left.length), 0);
  return rows.map(([left, right]) => `${indent}${left.padEnd(width)}  ${right}\n`).join('');
}

export function commandHelp(cli: Cli, cmd: Command): string {
  const args = usageLine(cmd);
  let out = `Usage: ${cli.name} ${cmd.path.join(' ')}${args ? ' ' + args : ''}${cmd.options?.length ? ' [options]' : ''}\n`;
  out += `\n${cmd.summary}\n`;
  if (cmd.description) out += `\n${cmd.description.trim()}\n`;
  const shown = (cmd.options ?? []).filter((o) => !o.hidden);
  if (shown.length) {
    out += '\nOptions:\n';
    out += pad(shown.map((o) => [optionLine(o), o.summary] as [string, string]));
  }
  return out;
}

export function groupHelp(cli: Cli, group: string): string {
  const commands = cli.commands.filter((c) => c.path.length > 1 && c.path[0] === group);
  const summary = cli.groups.find((g) => g.name === group)?.summary ?? '';
  let out = `Usage: ${cli.name} ${group} <command>\n`;
  if (summary) out += `\n${summary}\n`;
  out += '\nCommands:\n';
  out += pad(commands.map((c) => [c.path.slice(1).join(' '), c.summary] as [string, string]));
  out += `\nRun '${cli.name} ${group} <command> --help' for one command's options.\n`;
  return out;
}

export function rootHelp(cli: Cli): string {
  let out = `Usage: ${cli.name} <command> [options]\n`;
  const groups = cli.groups.filter((g) => cli.commands.some((c) => c.path.length > 1 && c.path[0] === g.name));
  const singles = cli.commands.filter((c) => c.path.length === 1);
  if (singles.length) {
    out += '\nCommands:\n';
    out += pad(singles.map((c) => [c.path[0], c.summary] as [string, string]));
  }
  if (groups.length) {
    out += '\nCommand groups:\n';
    out += pad(groups.map((g) => [g.name, g.summary] as [string, string]));
  }
  out += `\nRun '${cli.name} <group> --help' for a group's commands, or '${cli.name} <command> --help'\n`;
  out += `for one command's options. '${cli.name} commands --json' dumps the whole command set.\n`;
  if (cli.footer) out += `\n${cli.footer.trim()}\n`;
  return out;
}

/** The registry as data, for a caller that would rather not read help text. */
export function registryJson(cli: Cli): unknown {
  return {
    name: cli.name,
    commands: cli.commands.map((c) => ({
      path: c.path,
      summary: c.summary,
      args: (c.args ?? []).map((a) => ({ name: a.name, required: !!a.required, variadic: !!a.variadic })),
      options: (c.options ?? [])
        .filter((o) => !o.hidden)
        .map((o) => ({ name: o.name, type: o.type, summary: o.summary, short: o.short ?? null })),
      raw: !!c.raw,
    })),
  };
}

// ---- dispatch ----

const HELP_FLAGS = new Set(['-h', '--help', 'help']);

function wantsHelp(argv: string[]): boolean {
  for (const a of argv) {
    if (a === '--') return false;
    if (a === '-h' || a === '--help') return true;
  }
  return false;
}

/**
 * Resolve argv against the registry and run what it names. Every failure is a
 * CliError, so the caller decides how to report it; nothing here writes to
 * stderr or exits, apart from the help paths.
 */
export async function dispatch(cli: Cli, argv: string[]): Promise<void> {
  if (argv.length === 0 || (argv.length === 1 && HELP_FLAGS.has(argv[0]))) {
    process.stdout.write(rootHelp(cli));
    return;
  }

  // The longest matching path wins, so a two-word command is found before the
  // one-word command that shares its first word could shadow it.
  let found: Command | null = null;
  let depth = 0;
  for (const cmd of cli.commands) {
    if (cmd.path.length > argv.length) continue;
    if (cmd.path.every((seg, i) => argv[i] === seg) && cmd.path.length > depth) {
      found = cmd;
      depth = cmd.path.length;
    }
  }

  if (!found) {
    const head = argv[0];
    if (cli.groups.some((g) => g.name === head) || cli.commands.some((c) => c.path[0] === head)) {
      // A known group with an unknown or missing subcommand. Listed by their
      // whole path below the group, since a group may nest ('deploy fly show'),
      // and deduplicated: several such commands share one second word.
      const under = cli.commands.filter((c) => c.path[0] === head && c.path.length > 1);
      const subs = [...new Set(under.map((c) => c.path.slice(1).join(' ')))];
      const sub = argv[1];
      if (sub === undefined || HELP_FLAGS.has(sub)) {
        process.stdout.write(groupHelp(cli, head));
        if (sub === undefined) throw new CliError(`'mochi ${head}' needs a command: ${subs.join(', ')}`, EXIT_USAGE);
        return;
      }
      // A group may nest twice ('user token list'), so a second word that names
      // one of those is a group in its own right rather than a misspelling.
      const deeper = under.filter((c) => c.path.length > 2 && c.path[1] === sub);
      if (deeper.length) {
        const thirds = [...new Set(deeper.map((c) => c.path[2]))];
        const third = argv[2];
        if (third === undefined || HELP_FLAGS.has(third)) {
          throw new CliError(`'mochi ${head} ${sub}' needs a command: ${thirds.join(', ')}`, EXIT_USAGE);
        }
        const near = nearest(third, thirds);
        throw new CliError(
          `unknown command 'mochi ${head} ${sub} ${third}'` +
            (near ? `; did you mean '${head} ${sub} ${near}'?` : `. One of: ${thirds.join(', ')}`),
          EXIT_USAGE
        );
      }
      // What was typed is one word, so it is compared against single words.
      const near = nearest(sub, [...new Set(under.map((c) => c.path[1]))]);
      throw new CliError(
        `unknown command 'mochi ${head} ${sub}'` + (near ? `; did you mean '${head} ${near}'?` : `. One of: ${subs.join(', ')}`),
        EXIT_USAGE
      );
    }
    const tops = [...new Set([...cli.groups.map((g) => g.name), ...cli.commands.map((c) => c.path[0])])];
    const near = nearest(head, tops);
    throw new CliError(
      `unknown command '${head}'` + (near ? `; did you mean '${near}'?` : ". Run 'mochi --help'."),
      EXIT_USAGE
    );
  }

  const rest = argv.slice(depth);
  if (wantsHelp(rest)) {
    process.stdout.write(commandHelp(cli, found));
    return;
  }
  await found.run(invocationFor(cli, found, rest));
}
