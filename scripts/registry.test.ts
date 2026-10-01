// node --no-warnings --test scripts/*.test.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { generateSecretKey, getPublicKey, verifyEvent, type NostrEvent } from 'nostr-tools/pure';
import { loadCoreTrust } from './compat.ts';
import { nostrKey, RELAYS } from './registry.ts';

const script = new URL('./registry.ts', import.meta.url).pathname;
const repoRoot = new URL('..', import.meta.url).pathname;

// NIP-06 test vectors
const COORD = {
  mnemonic: 'leader monkey parrot ring guide accident before fence cannon height naive bean',
  pk: '17162c921dc4d2518f9a101db33695df1afb56ab82f5ff3e5da6eec3ca5cd917',
};
const OPER = {
  mnemonic: 'what bleak badge arrange retreat wolf trade produce cricket blur garlic valid proud rude strong choose busy staff weather area salt hollow arm fade',
  pk: 'd41b22899549e1f3d335a31002cfd382174006e166d3e658e3a5eecdb6463573',
};
const KEYS = { COORDINATOR_MNEMONIC: COORD.mnemonic, OPERATOR_MNEMONIC: OPER.mnemonic };
const pk = () => getPublicKey(generateSecretKey());

function write(dir: string, files: Record<string, unknown>): void {
  for (const [f, v] of Object.entries(files)) {
    mkdirSync(join(dir, f, '..'), { recursive: true });
    writeFileSync(join(dir, f), typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  }
}
function registry(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'registry-'));
  write(dir, { 'coordinator.json': { pk: COORD.pk }, 'operator.json': { pk: OPER.pk, name: 'test registry' }, ...files });
  return dir;
}
const git = (dir: string, args: string[], time?: number) =>
  execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...(time ? { GIT_COMMITTER_DATE: `${time} +0000`, GIT_AUTHOR_DATE: `${time} +0000` } : {}) },
  });
function commit(dir: string, time: number): void {
  if (!git(dir, ['rev-parse', '--is-inside-work-tree']).includes('true')) throw new Error('not a repo');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'x', '--allow-empty'], time);
}
function initRepo(dir: string, time: number): void {
  git(dir, ['init', '-q']);
  commit(dir, time);
}
function run(dir: string, args: string[], env: Record<string, string> = {}): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(process.execPath, ['--no-warnings', script, ...args], { env: { ...process.env, REGISTRY_ROOT: dir, ...env }, encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e) {
    const x = e as { stdout: string; stderr: string };
    return { ok: false, out: x.stdout + x.stderr };
  }
}
function build(dir: string): { version: number; events: NostrEvent[] } {
  const r = run(dir, ['build', join(dir, 'site')], KEYS);
  assert.ok(r.ok, r.out);
  return JSON.parse(readFileSync(join(dir, 'site/events.json'), 'utf8'));
}
const tag = (e: NostrEvent, n: string) => e.tags.find((t) => t[0] === n)?.[1];

const shopper = (escrows: string[], extra: Record<string, unknown> = {}) => ({
  pk: pk(), contact: 'github:alice', description: 'buys in Tokyo shops that take cash only', regions: ['JP-13', 'JP-14'], payments: ['btc-signet'], escrows, ...extra,
});
const escrow = (sla = 14) => ({ pk: pk(), contact: 'github:erin', description: 'rules disputes within two weeks', sla_days: sla });

test('keys are the NIP-06 keys of the mnemonics', () => {
  assert.equal(getPublicKey(nostrKey(COORD.mnemonic)), COORD.pk);
  assert.equal(getPublicKey(nostrKey(`  ${OPER.mnemonic.toUpperCase().replace(/ /g, '  ')}\n`)), OPER.pk, 'whitespace and case of a pasted secret do not matter');
  assert.throws(() => nostrKey('leader monkey parrot'), /not a valid BIP39 mnemonic/);
});

test('a registry builds signed delegations and the operator list', () => {
  const op = pk();
  const gone = pk();
  const e1 = escrow(14);
  const e2 = escrow(7);
  const s = shopper(['erin', 'frank', 'nobody']);
  const dir = registry({
    'coordinators/self.json': { pk: COORD.pk, contact: 'github:me', description: 'this registry', url: 'https://example.org' },
    'operators/osaka.json': { pk: op, contact: 'github:olga', description: 'lists Osaka shoppers', regions: ['JP-27'] },
    'revoked/old.json': { role: 'operator', pk: gone, contact: 'github:old', description: 'former operator', regions: ['JP'], reason: 'stopped' },
    'shoppers/alice.json': s,
    'escrows/erin.json': e1,
    'escrows/frank.json': e2,
  });
  initRepo(dir, 1_800_000_000);
  const { version, events } = build(dir);
  assert.equal(version, 1_800_000_000);
  const summary = events.map((e) => `${e.kind}:${e.pubkey === COORD.pk ? 'coord' : e.pubkey === OPER.pk ? 'oper' : '?'}:${tag(e, 'd') === op ? 'osaka' : tag(e, 'd') === gone ? 'old' : tag(e, 'd') === OPER.pk ? 'registry' : tag(e, 'd')}:${tag(e, 'revoked') ?? ''}`);
  assert.deepEqual(summary, ['30500:coord:registry:false', '30500:coord:osaka:false', '30500:coord:old:true', '30501:oper:ps-main:']);
  for (const e of events) {
    assert.ok(verifyEvent({ ...e }), 'signature');
    assert.equal(tag(e, 'v'), String(version));
    assert.equal(e.created_at, version, 'created_at = v, so that relays that replace by created_at keep the newest');
    assert.equal(tag(e, 'network'), 'ps-main');
  }
  for (const e of events.slice(0, 3)) assert.equal(tag(e, 'p'), tag(e, 'd'));
  const list = JSON.parse(events[3]!.content);
  assert.equal(list.network, 'ps-main');
  assert.equal(list.name, 'test registry');
  assert.deepEqual(list.regions, ['JP-13', 'JP-14']);
  assert.deepEqual(list.relays, RELAYS.map((url) => ({ url })));
  assert.deepEqual(list.chain, { btc: { network: 'signet', esplora: ['https://mempool.space/signet/api'] } });
  assert.equal(list.report_to, OPER.pk);
  assert.equal(list.chain.evm, undefined);
  assert.deepEqual(
    list.entries.map((x: { region: string; escrow: string; escrow_sla_days: number }) => `${x.region}:${x.escrow === e1.pk ? 'erin' : 'frank'}:${x.escrow_sla_days}`),
    ['JP-13:erin:14', 'JP-14:erin:14', 'JP-13:frank:7', 'JP-14:frank:7'],
  );
  assert.deepEqual(list.entries[0], { region: 'JP-13', shopper: s.pk, escrow: e1.pk, shops: ['*'], payments: ['btc-signet'], tags: [], escrow_sla_days: 14 });

  // the readable files
  const reg = JSON.parse(readFileSync(join(dir, 'site/registry.json'), 'utf8'));
  assert.equal(reg.entries.length, 4);
  assert.equal(reg.shoppers.alice.pk, s.pk);
  const coords = JSON.parse(readFileSync(join(dir, 'site/coordinators.json'), 'utf8'));
  assert.deepEqual(coords.coordinators, [{ name: 'self', pk: COORD.pk, contact: 'github:me', description: 'this registry', url: 'https://example.org' }]);
  const html = readFileSync(join(dir, 'site/index.html'), 'utf8');
  assert.match(html, /<html lang="en">/);
  assert.match(html, /一覧の組み合わせ/);
  assert.match(readFileSync(join(dir, 'site/llms.txt'), 'utf8'), /alice: `[0-9a-f]{64}`/);

  // verify accepts it, and refuses a tampered copy
  assert.ok(run(dir, ['verify', join(dir, 'site')]).ok);
  const tampered = JSON.parse(readFileSync(join(dir, 'site/events.json'), 'utf8'));
  tampered.events[3].content = tampered.events[3].content.replace('"JP-13"', '"JP-27"');
  write(dir, { 'site/events.json': tampered });
  const bad = run(dir, ['verify', join(dir, 'site')]);
  assert.ok(!bad.ok);
  assert.match(bad.out, /does not verify/);
});

test('events are deterministic for the same files and commit', () => {
  const dir = registry({ 'shoppers/alice.json': shopper(['erin']), 'escrows/erin.json': escrow() });
  initRepo(dir, 1_800_000_100);
  const a = build(dir).events.map((e) => e.id);
  const b = build(dir).events.map((e) => e.id);
  assert.deepEqual(a, b);
});

test('versions are the commit time of HEAD, so every merge is newer', () => {
  const dir = registry({ 'shoppers/alice.json': shopper(['erin']), 'escrows/erin.json': escrow() });
  initRepo(dir, 1_800_000_000);
  const first = build(dir);
  write(dir, { 'escrows/erin.json': escrow(21) });
  commit(dir, 1_800_000_600);
  const second = build(dir);
  assert.equal(second.version, 1_800_000_600);
  assert.ok(second.version > first.version);
  for (const e of second.events) assert.equal(tag(e, 'v'), '1800000600');
});

test('revoking an operator signs a newer revoked delegation; revoking a shopper or escrow drops its entries', async (t) => {
  const op = pk();
  const s = shopper(['erin', 'frank']);
  const dir = registry({
    'operators/osaka.json': { pk: op, contact: 'github:olga', description: 'lists Osaka shoppers', regions: ['JP-27'] },
    'shoppers/alice.json': s,
    'escrows/erin.json': escrow(),
    'escrows/frank.json': escrow(),
  });
  initRepo(dir, 1_800_000_000);
  const before = build(dir);
  // the pull request: move the files, add the role and a reason
  const move = (from: string, role: string) => {
    const v = JSON.parse(readFileSync(join(dir, from), 'utf8'));
    rmSync(join(dir, from));
    write(dir, { [`revoked/${from.split('/')[1]}`]: { role, ...v, reason: 'lost the key' } });
  };
  move('operators/osaka.json', 'operator');
  move('escrows/frank.json', 'escrow');
  commit(dir, 1_800_000_900);
  const r = run(dir, ['validate']);
  assert.ok(r.ok, r.out);
  assert.match(r.out, /escrow frank is revoked/);
  const after = build(dir);
  const del = (evs: NostrEvent[]) => evs.find((e) => e.kind === 30500 && tag(e, 'd') === op)!;
  assert.equal(tag(del(before.events), 'revoked'), 'false');
  assert.equal(tag(del(after.events), 'revoked'), 'true');
  assert.ok(Number(tag(del(after.events), 'v')) > Number(tag(del(before.events), 'v')));
  const list = JSON.parse(after.events.find((e) => e.kind === 30501)!.content);
  assert.equal(list.entries.length, 2, 'only the entries with erin remain');

  const { core, reason } = await loadCoreTrust();
  if (!core) return t.skip(reason);
  // a client that holds the old and the new events sees the revocation
  const eff = core.effectiveCombinations({ coordinators: [COORD.pk], network: 'ps-main', events: [...before.events, ...after.events] });
  assert.equal(eff.delegations.find((d) => d.operator === op)?.revoked, true);
  assert.equal(eff.entries.length, 2);

  // and moving the shopper away empties the list
  move('shoppers/alice.json', 'shopper');
  commit(dir, 1_800_001_000);
  const last = build(dir);
  assert.equal(JSON.parse(last.events.at(-1)!.content).entries.length, 0);
});

test('pull request mistakes are reported precisely', () => {
  const shared = pk();
  const dir = registry({
    'shoppers/Bad_Name.json': shopper(['erin']),
    'shoppers/nokey.json': shopper(['erin'], { pk: 'npub1abc' }),
    'shoppers/upper.json': shopper(['erin'], { pk: pk().toUpperCase() }),
    'shoppers/offcurve.json': shopper(['erin'], { pk: '0'.repeat(63) + '5' }),
    'shoppers/nocontact.json': shopper(['erin'], { contact: '' }),
    'shoppers/nodesc.json': shopper(['erin'], { description: undefined }),
    'shoppers/region.json': shopper(['erin'], { regions: ['jp-13'] }),
    'shoppers/usdc.json': shopper(['erin'], { payments: ['btc-signet', 'usdc-evm'] }),
    'shoppers/pay.json': shopper(['erin'], { payments: ['paypal'] }),
    'shoppers/noescrow.json': shopper([]),
    'shoppers/extra.json': shopper(['erin'], { fee: 5 }),
    'shoppers/dup1.json': shopper(['erin'], { pk: shared }),
    'shoppers/dup2.json': shopper(['erin'], { pk: shared }),
    'escrows/erin.json': escrow(0),
    'operators/me.json': { pk: OPER.pk, contact: 'x', description: 'x', regions: ['JP'] },
    'operators/noregion.json': { pk: pk(), contact: 'x', description: 'x' },
    'revoked/norole.json': { pk: pk(), contact: 'x', description: 'x', reason: 'x' },
    'revoked/noreason.json': { role: 'escrow', pk: pk(), contact: 'x', description: 'x', sla_days: 3 },
    'escrows/twice.json': escrow(),
    'revoked/twice.json': { role: 'escrow', ...escrow(), reason: 'x' },
    'coordinators/c.json': { pk: pk(), contact: 'x', description: 'x', url: 'http://insecure.example' },
    'escrows/broken.json': '{"pk": ',
    'stray.json': {},
  });
  const r = run(dir, ['validate']);
  assert.ok(!r.ok);
  const expect: [string, string][] = [
    ['shoppers/Bad_Name.json', 'file names are <name>.json'],
    ['shoppers/nokey.json', 'pk must be the shopper\'s Nostr public key: 64 lowercase hex'],
    ['shoppers/upper.json', 'pk must be'],
    ['shoppers/offcurve.json', 'is not the x coordinate of a secp256k1 point'],
    ['shoppers/nocontact.json', 'contact is required'],
    ['shoppers/nodesc.json', 'description is required'],
    ['shoppers/region.json', '"jp-13" is not a region code'],
    ['shoppers/usdc.json', 'usdc-evm is not offered on ps-main yet'],
    ['shoppers/pay.json', 'unknown payment "paypal"'],
    ['shoppers/noescrow.json', 'escrows must be a list of 1-32'],
    ['shoppers/extra.json', 'unknown field "fee"'],
    ['shoppers/dup2.json', 'public key already used by shoppers/dup1.json'],
    ['escrows/erin.json', 'sla_days must be an integer 1-365'],
    ['operators/me.json', 'this is the registry operator of operator.json'],
    ['operators/noregion.json', 'regions must be a list'],
    ['revoked/norole.json', 'role must be "operator", "shopper" or "escrow"'],
    ['revoked/noreason.json', 'reason is required'],
    ['revoked/twice.json', 'the same name is still in escrows/twice.json'],
    ['coordinators/c.json', 'url must be an https URL'],
    ['escrows/broken.json', 'not valid JSON'],
    ['stray.json', 'unknown file'],
  ];
  for (const [file, msg] of expect) {
    assert.ok(r.out.split('\n').some((l) => l.includes(`${file}: `) && l.includes(msg)), `${file}: ${msg}\n--- got:\n${r.out}`);
  }
});

test('a missing or foreign key is refused', () => {
  const dir = registry({});
  const none = run(dir, ['build', join(dir, 'site')]);
  assert.ok(!none.ok);
  assert.match(none.out, /COORDINATOR_MNEMONIC and OPERATOR_MNEMONIC must be set/);
  const swapped = run(dir, ['build', join(dir, 'site')], { COORDINATOR_MNEMONIC: OPER.mnemonic, OPERATOR_MNEMONIC: COORD.mnemonic });
  assert.ok(!swapped.ok);
  assert.match(swapped.out, /COORDINATOR_MNEMONIC does not belong to the pk in coordinator.json/);
  assert.doesNotMatch(swapped.out, /leader|bleak/, 'no mnemonic in the output');
});

test('the files of this repository are valid', () => {
  const r = run(repoRoot, ['validate']);
  assert.ok(r.ok, r.out);
});

test('COMPATIBILITY: the TS core (proxy-shopping-web) accepts the built events', async (t) => {
  const { core, reason } = await loadCoreTrust();
  if (!core) {
    console.log(`::notice::${reason}`);
    return t.skip(reason);
  }
  const op = pk();
  const s = shopper(['erin']);
  const e = escrow(10);
  const dir = registry({
    'operators/osaka.json': { pk: op, contact: 'github:olga', description: 'lists Osaka shoppers', regions: ['JP-27'] },
    'revoked/old.json': { role: 'operator', pk: pk(), contact: 'github:old', description: 'former operator', regions: ['JP'], reason: 'stopped' },
    'shoppers/alice.json': s,
    'escrows/erin.json': e,
  });
  initRepo(dir, 1_800_000_000);
  const { events } = build(dir);
  const dels = events.filter((x) => x.kind === 30500).map((x) => core.parseDelegation(x));
  assert.ok(dels.every(Boolean), 'every delegation parses');
  assert.deepEqual(dels.map((d) => [d!.coordinator, d!.network, d!.revoked, d!.version]), [
    [COORD.pk, 'ps-main', false, 1_800_000_000],
    [COORD.pk, 'ps-main', false, 1_800_000_000],
    [COORD.pk, 'ps-main', true, 1_800_000_000],
  ]);
  const list = core.parseOperatorList(events.at(-1));
  assert.ok(list, 'the list parses');
  assert.equal(list.operator, OPER.pk);
  assert.equal(list.content.entries.length, 2, 'no entry is dropped by the schema');
  const eff = core.effectiveCombinations({ coordinators: [COORD.pk], network: 'ps-main', events });
  assert.deepEqual(
    eff.entries.map((x) => [x.region, x.shopper, x.escrow, x.payments, x.shops, x.escrow_sla_days, x.provenance]),
    ['JP-13', 'JP-14'].map((region) => [region, s.pk, e.pk, ['btc-signet'], ['*'], 10, { coordinator: COORD.pk, operator: OPER.pk, listVersion: 1_800_000_000 }]),
  );
  assert.equal(core.effectiveCombinations({ coordinators: [pk()], network: 'ps-main', events }).entries.length, 0, 'nothing without trusting the coordinator');
});

test('list_url of an operator becomes list_url tags of its delegation (spec §2.2), not of a revoked one', () => {
  const one = pk();
  const two = pk();
  const none = pk();
  const gone = pk();
  const dir = registry({
    'operator.json': { pk: OPER.pk, name: 'test registry', list_url: 'https://registry.example/bundle.json' },
    'operators/one.json': { pk: one, contact: 'x', description: 'x', regions: ['JP-27'], list_url: 'https://osaka.example/ps/bundle.json' },
    'operators/two.json': { pk: two, contact: 'x', description: 'x', regions: ['JP-13'], list_url: ['https://a.example/b.json', 'https://mirror.example/b.json?v=1'] },
    'operators/none.json': { pk: none, contact: 'x', description: 'x', regions: ['JP'] },
    'revoked/gone.json': { role: 'operator', pk: gone, contact: 'x', description: 'x', regions: ['JP'], list_url: 'https://gone.example/b.json', reason: 'stopped' },
  });
  initRepo(dir, 1_800_000_000);
  const { events } = build(dir);
  const del = (op: string) => events.find((e) => e.kind === 30500 && tag(e, 'd') === op)!;
  const base = (op: string, revoked: boolean) => [['d', op], ['v', '1800000000'], ['network', 'ps-main'], ['p', op], ['revoked', String(revoked)]];
  assert.deepEqual(del(one).tags, [...base(one, false), ['list_url', 'https://osaka.example/ps/bundle.json']], 'a string is one tag, after the others');
  assert.deepEqual(del(two).tags, [...base(two, false), ['list_url', 'https://a.example/b.json'], ['list_url', 'https://mirror.example/b.json?v=1']]);
  assert.deepEqual(del(none).tags, base(none, false), 'no field, no tag');
  assert.deepEqual(del(gone).tags, base(gone, true), 'a revoked delegation has no list_url');
  assert.deepEqual(del(OPER.pk).tags, [...base(OPER.pk, false), ['list_url', 'https://registry.example/bundle.json']], 'operator.json may have one too');
  const reg = JSON.parse(readFileSync(join(dir, 'site/registry.json'), 'utf8'));
  assert.deepEqual(reg.operators.one.list_url, ['https://osaka.example/ps/bundle.json'], 'normalized to a list');
  assert.equal(reg.operators.none.list_url, undefined);

  // verify compares the tags with the files
  assert.ok(run(dir, ['verify', join(dir, 'site')]).ok);
  write(dir, { 'operators/one.json': { pk: one, contact: 'x', description: 'x', regions: ['JP-27'], list_url: 'https://evil.example/b.json' } });
  const bad = run(dir, ['verify', join(dir, 'site')]);
  assert.ok(!bad.ok);
  assert.match(bad.out, /content or tags differ from the registry files/);
});

test('bad list_url values are reported', () => {
  const op = (list_url: unknown) => ({ pk: pk(), contact: 'x', description: 'x', regions: ['JP'], list_url });
  const dir = registry({
    'operators/http.json': op('http://insecure.example/b.json'),
    'operators/relative.json': op('/bundle.json'),
    'operators/garbage.json': op('https://exa mple/b.json'),
    'operators/nohost.json': op('https:///b.json'),
    'operators/creds.json': op('https://user:pw@example.org/b.json'),
    'operators/fragment.json': op('https://example.org/b.json#x'),
    'operators/long.json': op(`https://example.org/${'a'.repeat(600)}`),
    'operators/dup.json': op(['https://example.org/b.json', 'https://EXAMPLE.org/b.json']),
    'operators/many.json': op(['https://a.example/', 'https://b.example/', 'https://c.example/', 'https://d.example/', 'https://e.example/']),
    'operators/empty.json': op([]),
    'operators/number.json': op(42),
    'operators/inner.json': op(['https://a.example/', 7]),
  });
  const r = run(dir, ['validate']);
  assert.ok(!r.ok);
  const expect: [string, string][] = [
    ['operators/http.json', 'is not https'],
    ['operators/relative.json', 'is not an absolute URL'],
    ['operators/garbage.json', 'contains spaces'],
    ['operators/nohost.json', 'has no host'],
    ['operators/creds.json', 'must not contain credentials'],
    ['operators/fragment.json', 'must not have a fragment'],
    ['operators/long.json', 'is longer than 512 characters'],
    ['operators/dup.json', 'is listed twice'],
    ['operators/many.json', 'list_url must be an https URL or a list of 1-4'],
    ['operators/empty.json', 'list_url must be an https URL or a list of 1-4'],
    ['operators/number.json', 'list_url must be an https URL or a list of 1-4'],
    ['operators/inner.json', 'is not a string'],
  ];
  for (const [file, msg] of expect) {
    assert.ok(r.out.split('\n').some((l) => l.includes(`${file}: `) && l.includes(msg)), `${file}: ${msg}\n--- got:\n${r.out}`);
  }
});
