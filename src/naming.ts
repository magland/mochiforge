// The spellings that name the product rather than describe the mechanism.
//
// Everything here defaults to the mochi spellings, so mochiforge itself is
// unchanged by this file existing. A sibling application built on these
// modules (dango is the first) calls setNaming() once, before anything else
// runs, and the token prefix, session cookie, state file, environment
// variables, and CLI wording all take its name instead. The values are read
// at call time, never captured at module load, which is what makes the one
// early setNaming() call sufficient.

export interface Naming {
  /** The command and product name, as used in messages: "mochi login ...". */
  product: string;
  /** What minted tokens start with: "mochi_". */
  tokenPrefix: string;
  /** The session cookie's bare name; the https variant is `__Host-` + this. */
  cookieName: string;
  /** The identity file in the root directory: "vault.json". */
  stateFile: string;
  /** What the root directory is called in messages: "vault". */
  rootNoun: string;
  /** The environment variable prefix: MOCHI gives MOCHI_HOST and MOCHI_TOKEN. */
  envPrefix: string;
  /** The directory under ~/.config that login.json is kept in. */
  configDirName: string;
}

export const naming: Naming = {
  product: 'mochi',
  tokenPrefix: 'mochi_',
  cookieName: 'mochi_session',
  stateFile: 'vault.json',
  rootNoun: 'vault',
  envPrefix: 'MOCHI',
  configDirName: 'mochi',
};

export function setNaming(overrides: Partial<Naming>): void {
  Object.assign(naming, overrides);
}
