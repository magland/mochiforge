// The spellings that name the product rather than describe the mechanism.
//
// Everything here defaults to the mochi spellings, so mochiforge itself is
// unchanged by this file existing. A sibling application built on these
// modules (dango is the first) calls setNaming() once, before anything else
// runs, and the token prefix, session cookie, state file, environment
// variables, and CLI wording all take its name instead. The values are read
// at call time, never captured at module load, which is what makes the one
// early setNaming() call sufficient.

import type { BuildInfo } from './version';

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
  /** The product's full name, as the page foot, titles, and the sign-in page say it: "Mochi Forge". */
  displayName: string;
  /**
   * The file in a repository's directory holding its private flag and
   * collaborators (see src/perms.ts): "mochi.json". A sibling whose items are
   * not bare repositories keeps the same record under a name of its own.
   */
  accessFile: string;
  /** What the jump box finds, in the singular: "repository". */
  itemNoun: string;
  /**
   * The jump box's heading over what it finds, when not mochi's
   * "Repositories". Carried to the page script by an attribute on <html>,
   * written only when set, so a vault's pages are unchanged.
   */
  jumpGroup?: string;
  /**
   * Markup added to the <head> of every page the shared layout draws, for a
   * sibling whose pages need a stylesheet of their own beside mochi's. It is
   * the sibling's own trusted markup, never anything a user wrote.
   */
  pageHead?: string;
  /** The logotype in the top bar, as SVG; unset means mochi's own (src/logo.ts). */
  wordmark?: string;
  /** The mark on the sign-in pages, as SVG; unset means mochi's own. */
  mark?: string;
  /**
   * What the page foot reports as running; unset means mochi's own package
   * and build stamp (src/version.ts). A sibling compiles mochi's modules into
   * its own dist, where mochi's package.json is not beside them, so it names
   * its own build here.
   */
  buildInfo?: () => BuildInfo;
}

export const naming: Naming = {
  product: 'mochi',
  tokenPrefix: 'mochi_',
  cookieName: 'mochi_session',
  stateFile: 'vault.json',
  rootNoun: 'vault',
  envPrefix: 'MOCHI',
  configDirName: 'mochi',
  displayName: 'Mochi Forge',
  accessFile: 'mochi.json',
  itemNoun: 'repository',
};

export function setNaming(overrides: Partial<Naming>): void {
  Object.assign(naming, overrides);
}
