/**
 * A small argument parser: `--flag`, `--key=value`, `--key value`.
 *
 * Every subcommand declares its options once; unknown options and bad
 * values end in exit 2 with a usage line, the shared "not runnable" code.
 */

export type OptionSpec =
  | { type: "boolean"; help: string }
  | { type: "string"; help: string; default?: string; choices?: readonly string[] }
  | { type: "int"; help: string; default?: number };

export type Spec = Record<string, OptionSpec>;

export type Parsed = Record<string, string | number | boolean>;

export class ArgError extends Error {}

export function parseArgs(argv: string[], spec: Spec): Parsed {
  const result: Parsed = {};
  for (const [name, option] of Object.entries(spec)) {
    if (option.type === "boolean") result[name] = false;
    else if (option.default !== undefined) result[name] = option.default;
    else result[name] = option.type === "int" ? 0 : "";
  }

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      throw new ArgError(`unexpected argument ${JSON.stringify(token)}`);
    }
    const eq = token.indexOf("=");
    const name = (eq === -1 ? token.slice(2) : token.slice(2, eq)).replace(/-/g, "_");
    const option = spec[name];
    if (!option) throw new ArgError(`unknown option ${token}`);

    if (option.type === "boolean") {
      if (eq !== -1) throw new ArgError(`option --${name} takes no value`);
      result[name] = true;
      continue;
    }
    let value: string;
    if (eq !== -1) value = token.slice(eq + 1);
    else if (i + 1 < argv.length) value = argv[++i];
    else throw new ArgError(`option --${name} needs a value`);

    if (option.type === "int") {
      if (!/^-?\d+$/.test(value)) throw new ArgError(`option --${name} needs an integer`);
      result[name] = Number(value);
    } else {
      if (option.choices && !option.choices.includes(value)) {
        throw new ArgError(
          `option --${name} must be one of ${option.choices.join(", ")} (got ${JSON.stringify(value)})`,
        );
      }
      result[name] = value;
    }
  }
  return result;
}

export function usage(command: string, description: string, spec: Spec): string {
  const lines = [`usage: warehaus ${command} [options]`, "", description, "", "options:"];
  for (const [name, option] of Object.entries(spec)) {
    const flag = "--" + name.replace(/_/g, "-");
    let extra = "";
    if (option.type === "string" && option.choices) extra = ` {${option.choices.join("|")}}`;
    else if (option.type === "string") extra = " VALUE";
    else if (option.type === "int") extra = " N";
    const left = (flag + extra).padEnd(28);
    const def =
      option.type !== "boolean" && option.default !== undefined && option.default !== ""
        ? ` (default: ${option.default})`
        : "";
    lines.push(`  ${left}${option.help}${def}`);
  }
  return lines.join("\n");
}
