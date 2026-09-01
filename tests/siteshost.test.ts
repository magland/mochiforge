import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  derivedSiteHost,
  isReservedSiteLabel,
  isSiteLabelSafe,
  isUnderSitesHost,
  normalizeHostname,
  parseSiteHost,
  sanitizedSiteLabel,
  siteHostLabel,
} from '../src/siteshost';

// The grammar alone: no vault is involved, which is the point of keeping these
// functions pure. What an alias resolves to is tested in sitesettings.test.ts.

const HOST = 'v-sites.example.org';

test('a derived hostname joins the repository name and the collection alias', () => {
  assert.equal(derivedSiteHost(HOST, 'alice', 'webapp'), `webapp--alice.${HOST}`);
  assert.equal(derivedSiteHost(HOST, 'alice', 'webapp.git'), `webapp--alice.${HOST}`, 'the .git suffix is not a name');
  assert.equal(derivedSiteHost('', 'alice', 'webapp'), null);
  assert.equal(derivedSiteHost(HOST, 'alice', 'My_App'), null, 'a name no label may carry is refused, not mangled');
  assert.equal(derivedSiteHost(HOST, 'Alice', 'webapp'), null, 'the alias is held to the same rule');
  assert.equal(derivedSiteHost(HOST, 'a'.repeat(40), 'b'.repeat(40)), null, 'over the 63-character DNS limit');
});

test('the parse gives back the alias and the repository, and refuses everything else', () => {
  assert.deepEqual(parseSiteHost(HOST, `webapp--alice.${HOST}`), { collectionAlias: 'alice', repo: 'webapp' });
  assert.deepEqual(parseSiteHost(HOST, `WEBAPP--ALICE.${HOST}.`), { collectionAlias: 'alice', repo: 'webapp' });
  assert.equal(parseSiteHost(HOST, `webapp.${HOST}`), null, 'a single label is a claimed label, not a derived name');
  assert.equal(parseSiteHost(HOST, `a--b--c.${HOST}`), null, 'the separator appears once or not at all');
  assert.equal(parseSiteHost(HOST, `deep.webapp--alice.${HOST}`), null);
  assert.equal(parseSiteHost(HOST, 'webapp--alice.elsewhere.example.org'), null);
  assert.equal(parseSiteHost('', `webapp--alice.${HOST}`), null);
});

test('the label under the sites host is read without deciding what it means', () => {
  assert.equal(siteHostLabel(HOST, `docs.${HOST}`), 'docs');
  assert.equal(siteHostLabel(HOST, `webapp--alice.${HOST}`), 'webapp--alice');
  assert.equal(siteHostLabel(HOST, HOST), null, 'the bare host names no site');
  assert.equal(siteHostLabel(HOST, `a.b.${HOST}`), null, 'no wildcard certificate covers it');
  assert.ok(isUnderSitesHost(HOST, HOST) && isUnderSitesHost(HOST, `a.b.${HOST}`));
  assert.ok(!isUnderSitesHost(HOST, 'example.org'));
  assert.equal(normalizeHostname('  Webapp--Alice.Example.ORG. '), 'webapp--alice.example.org');
});

test('a name is rewritten to a label by collapsing what a label may not hold', () => {
  assert.equal(sanitizedSiteLabel('simulated_instruments'), 'simulated-instruments');
  assert.equal(sanitizedSiteLabel('Sim.Instruments'), 'sim-instruments');
  assert.equal(sanitizedSiteLabel('_leading_and_trailing_'), 'leading-and-trailing');
  assert.equal(sanitizedSiteLabel('a__b'), 'a-b', 'a run collapses, so no doubled hyphen ever comes out');
  assert.equal(sanitizedSiteLabel('___'), '', 'nothing usable is left');
  assert.equal(sanitizedSiteLabel('a'.repeat(64)), '', 'over the DNS limit');
  // The rewrite is not injective, which is why its callers check for collisions.
  assert.equal(sanitizedSiteLabel('a_b'), sanitizedSiteLabel('a.b'));
  // Whatever comes out is a label the grammar accepts.
  for (const name of ['simulated_instruments', 'Sim.Instruments', 'a__b']) {
    assert.ok(isSiteLabelSafe(sanitizedSiteLabel(name)));
  }
});

test('the reserved labels are the exact names, and cannot contain a doubled hyphen', () => {
  assert.ok(isReservedSiteLabel('www') && isReservedSiteLabel('api'));
  assert.ok(!isReservedSiteLabel('www2') && !isReservedSiteLabel('WWW'));
  assert.ok(!isReservedSiteLabel('xn--p1ai'), 'a punycode-looking label is already refused as a claim');
});
