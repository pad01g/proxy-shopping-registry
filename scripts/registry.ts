// The trust registry of the ps-main proxy-shopping network (spec §2 of pad01g/proxy-shopping-go docs/spec.md).
//   node scripts/registry.ts validate               check every file; no key needed (pull requests)
//   node scripts/registry.ts build <out dir>        validate, then sign with COORDINATOR_MNEMONIC / OPERATOR_MNEMONIC
//   node scripts/registry.ts verify <out dir>       check a built site: signatures, signers, versions, content
//   node scripts/registry.ts publish <out dir>      send <out dir>/events.json to the ps-main relays
//
// What is signed (all with network ps-main, v = created_at = the commit time of HEAD, so every merge is newer):
//   - kind 30500 by the coordinator (coordinator.json) to the registry operator (operator.json)
//   - kind 30500 by the coordinator to every operators/<name>.json, and a revoked one for every revoked operator;
//     a delegation carries one ["list_url", url] tag per list_url of the operator's file (spec §2.2, §2.6)
//   - kind 30501 by the registry operator: every shoppers/<name>.json × each escrow it names that is in escrows/,
//     one entry per cash region of the shopper
// The keys are NIP-06 keys (m/44'/1237'/0'/0/0) of BIP39 mnemonics held only in repository secrets.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';
import { finalizeEvent, getPublicKey, verifyEvent, type NostrEvent } from 'nostr-tools/pure';

export const ROOT = process.env.REGISTRY_ROOT ?? new URL('..', import.meta.url).pathname;
export const NETWORK = 'ps-main';
export const RELAYS = ['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net'];
export const CHAIN = { btc: { network: 'signet', esplora: ['https://mempool.space/signet/api'] } };
/** Payment methods offered on ps-main. usdc-evm needs chain.evm in the list, which ps-main does not have yet. */
export const PAYMENTS = ['btc-signet'];
export const SITE = (process.env.SITE_URL ?? 'https://pad01g.github.io/proxy-shopping-registry').replace(/\/$/, '');
export const REPO = 'https://github.com/pad01g/proxy-shopping-registry';
export const KIND = { delegation: 30500, list: 30501 } as const;

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PK = /^[0-9a-f]{64}$/;
// the region check of the clients (proxy-shopping-web core, trust/schema.ts), spec §2.5
const REGION = /^[A-Z]{2}(-[A-Z0-9]{1,10}){0,4}$/;
const ROLE_DIRS = ['coordinators', 'operators', 'shoppers', 'escrows', 'revoked'] as const;

type Base = { name: string; pk: string; contact: string; description: string };
export type Coordinator = Base & { url?: string; bundle?: string };
export type Operator = Base & { regions: string[]; list_url?: string[] };
export type Shopper = Base & { regions: string[]; payments: string[]; escrows: string[] };
export type Escrow = Base & { sla_days: number };
export type Revoked = Base & { role: 'operator' | 'shopper' | 'escrow'; reason: string };
export type ListEntry = {
  region: string;
  shopper: string;
  escrow: string;
  shops: string[];
  payments: string[];
  tags: string[];
  escrow_sla_days: number;
};
export type Registry = {
  coordinator: string;
  operator: string;
  operatorName: string;
  /** list_url of operator.json: where the registry operator's own bundle is, when it says so */
  operatorListUrl?: string[];
  coordinators: Map<string, Coordinator>;
  operators: Map<string, Operator>;
  shoppers: Map<string, Shopper>;
  escrows: Map<string, Escrow>;
  revoked: Map<string, Revoked>;
};

export class Problems {
  errors: string[] = [];
  warnings: string[] = [];
  add(file: string, msg: string): void {
    this.errors.push(`${file}: ${msg}`);
  }
  warn(file: string, msg: string): void {
    this.warnings.push(`${file}: ${msg}`);
  }
}

// ---- keys

/** The NIP-06 secret key (m/44'/1237'/0'/0/0) of a BIP39 mnemonic without passphrase. */
export function nostrKey(mnemonic: string): Uint8Array {
  const words = mnemonic.trim().toLowerCase().split(/\s+/).join(' ');
  if (!validateMnemonic(words, wordlist)) throw new Error('not a valid BIP39 mnemonic (English word list)');
  const key = HDKey.fromMasterSeed(mnemonicToSeedSync(words)).derive("m/44'/1237'/0'/0/0").privateKey;
  if (!key) throw new Error('could not derive the Nostr key');
  return key;
}

// ---- files

function readJson(file: string, problems: Problems): unknown {
  try {
    return JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  } catch (e) {
    problems.add(file, existsSync(join(ROOT, file)) ? `not valid JSON (${(e as Error).message})` : 'is missing');
    return undefined;
  }
}

function entries(dir: string, problems: Problems): [string, Record<string, unknown>][] {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir))
    .filter((f) => f !== '.gitkeep' && f !== 'README.md')
    .sort()
    .flatMap((f): [string, Record<string, unknown>][] => {
      const file = `${dir}/${f}`;
      const name = f.replace(/\.json$/, '');
      if (!f.endsWith('.json') || !NAME.test(name)) {
        problems.add(file, 'file names are <name>.json, <name> being 1-40 characters of a-z, 0-9 and - (not starting with -)');
        return [];
      }
      const v = readJson(file, problems);
      if (v === undefined) return [];
      if (typeof v !== 'object' || v === null || Array.isArray(v)) {
        problems.add(file, 'must be a JSON object');
        return [];
      }
      return [[name, v as Record<string, unknown>]];
    });
}

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
/** 64 lowercase hex characters that are the x coordinate of a secp256k1 point (BIP-340), as clients require. */
export function isPublicKey(v: unknown): v is string {
  if (typeof v !== 'string' || !PK.test(v)) return false;
  try {
    schnorr.utils.lift_x(BigInt(`0x${v}`));
    return true;
  } catch {
    return false;
  }
}
const httpsUrl = (v: unknown): v is string => typeof v === 'string' && v.length <= 256 && /^https:\/\/[^\s"<>]+$/.test(v);

export const LIST_URL_MAX = 4;
export const LIST_URL_LEN = 512;

/**
 * list_url (spec §2.2): one https URL or a list of 1-4, where the operator hosts its signed bundle (§2.6). Normalized
 * to a list. Absolute https only, with a host, without credentials or fragment, at most 512 characters, no duplicates.
 */
export function listUrls(file: string, v: unknown, problems: Problems): string[] | undefined {
  const urls = typeof v === 'string' ? [v] : v;
  const what = `list_url must be an https URL or a list of 1-${LIST_URL_MAX} https URLs where you host your signed bundle`;
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > LIST_URL_MAX) {
    problems.add(file, `${what}, got ${JSON.stringify(v)}`);
    return undefined;
  }
  let ok = true;
  const seen = new Set<string>();
  for (const u of urls) {
    const bad = (why: string) => {
      problems.add(file, `list_url: ${JSON.stringify(typeof u === 'string' && u.length > 80 ? `${u.slice(0, 80)}…` : u)} ${why}`);
      ok = false;
    };
    if (typeof u !== 'string') {
      bad('is not a string');
      continue;
    }
    if (u.length > LIST_URL_LEN) {
      bad(`is longer than ${LIST_URL_LEN} characters`);
      continue;
    }
    if (/[\s\x00-\x1f\x7f"<>\\]/.test(u)) {
      bad('contains spaces, control characters or one of " < > \\');
      continue;
    }
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      bad('is not an absolute URL');
      continue;
    }
    if (url.protocol !== 'https:' || !u.toLowerCase().startsWith('https://')) bad('is not https (clients fetch bundles over HTTPS only)');
    else if (!url.hostname || !/^https:\/\/[^/?#]/i.test(u)) bad('has no host');
    else if (url.username || url.password) bad('must not contain credentials');
    else if (u.includes('#')) bad('must not have a fragment (#...)');
    else if (seen.has(url.href)) bad('is listed twice');
    else seen.add(url.href);
  }
  return ok ? (urls as string[]) : undefined;
}

function known(file: string, o: Record<string, unknown>, fields: string[], problems: Problems): void {
  for (const k of Object.keys(o)) if (!fields.includes(k)) problems.add(file, `unknown field "${k}" (allowed: ${fields.join(', ')})`);
}

function base(file: string, name: string, o: Record<string, unknown>, problems: Problems, what: string): Base | undefined {
  let ok = true;
  if (typeof o.pk !== 'string' || !PK.test(o.pk)) {
    problems.add(file, `pk must be the ${what}'s Nostr public key: 64 lowercase hex characters (x-only, not npub), got ${JSON.stringify(o.pk)}`);
    ok = false;
  } else if (!isPublicKey(o.pk)) {
    problems.add(file, `pk ${o.pk} is not a public key: it is not the x coordinate of a secp256k1 point (copy it from psctl keys or the web app)`);
    ok = false;
  }
  if (!text(o.contact, 200)) {
    problems.add(file, 'contact is required (e.g. "github:<user>" or "nostr:npub1..."), at most 200 characters');
    ok = false;
  }
  if (!text(o.description, 300)) {
    problems.add(file, 'description is required (who you are, what you do, how to check you), at most 300 characters');
    ok = false;
  }
  return ok ? { name, pk: o.pk as string, contact: o.contact as string, description: o.description as string } : undefined;
}

function regions(file: string, v: unknown, problems: Problems, field = 'regions'): string[] | undefined {
  if (!Array.isArray(v) || v.length === 0 || v.length > 64) {
    problems.add(file, `${field} must be a list of 1-64 region codes (spec §2.5), e.g. ["JP-13"]`);
    return undefined;
  }
  let ok = true;
  for (const r of v) {
    if (typeof r !== 'string' || !REGION.test(r)) {
      problems.add(file, `${field}: ${JSON.stringify(r)} is not a region code: ISO 3166-1 alpha-2 country ("JP"), ISO 3166-2 ("JP-13") or a municipality ("JP-13-13104")`);
      ok = false;
    }
  }
  if (new Set(v).size !== v.length) {
    problems.add(file, `${field} lists a region twice`);
    ok = false;
  }
  return ok ? (v as string[]) : undefined;
}

export function load(problems: Problems): Registry {
  const keys = new Map<string, string>();
  const unique = (file: string, pk: string): void => {
    const other = keys.get(pk);
    if (other) problems.add(file, `public key already used by ${other}`);
    else keys.set(pk, file);
  };
  const root = (file: string, withListUrl = false): { pk: string; name?: string; list_url?: string[] } => {
    const v = readJson(file, problems) as Record<string, unknown> | undefined;
    if (!v) return { pk: '' };
    if (!isPublicKey(v.pk)) problems.add(file, 'needs pk: a Nostr public key, 64 lowercase hex characters');
    const list_url = !withListUrl || v.list_url === undefined ? undefined : listUrls(file, v.list_url, problems);
    return { pk: typeof v.pk === 'string' ? v.pk : '', name: typeof v.name === 'string' ? v.name : undefined, ...(list_url ? { list_url } : {}) };
  };
  const coordinator = root('coordinator.json').pk;
  const op = root('operator.json', true);
  const operator = op.pk;
  if (coordinator && coordinator === operator) problems.add('operator.json', 'the registry operator needs its own key, not the coordinator key');
  if (coordinator) unique('coordinator.json', coordinator);
  if (operator && coordinator !== operator) unique('operator.json', operator);

  // entries outside the role directories would be ignored silently; say so
  for (const f of readdirSync(ROOT)) {
    if (f.endsWith('.json') && !['coordinator.json', 'operator.json', 'package.json', 'package-lock.json'].includes(f)) {
      problems.add(f, `unknown file: entries belong in ${ROLE_DIRS.join('/, ')}/`);
    }
  }

  // coordinators/: a directory only; its keys are a namespace of their own (the registry coordinator lists itself)
  const coordinators = new Map<string, Coordinator>();
  const coordKeys = new Map<string, string>();
  for (const [name, o] of entries('coordinators', problems)) {
    const file = `coordinators/${name}.json`;
    known(file, o, ['pk', 'contact', 'description', 'url', 'bundle'], problems);
    const b = base(file, name, o, problems, 'coordinator');
    if (o.url !== undefined && !httpsUrl(o.url)) problems.add(file, 'url must be an https URL (your registry or home page)');
    if (o.bundle !== undefined && !httpsUrl(o.bundle)) problems.add(file, 'bundle must be an https URL of your signed events.json');
    if (!b) continue;
    if (coordKeys.has(b.pk)) problems.add(file, `public key already listed by ${coordKeys.get(b.pk)}`);
    coordKeys.set(b.pk, file);
    coordinators.set(name, { ...b, ...(httpsUrl(o.url) ? { url: o.url } : {}), ...(httpsUrl(o.bundle) ? { bundle: o.bundle } : {}) });
  }

  const operators = new Map<string, Operator>();
  for (const [name, o] of entries('operators', problems)) {
    const file = `operators/${name}.json`;
    known(file, o, ['pk', 'contact', 'description', 'regions', 'list_url'], problems);
    const b = base(file, name, o, problems, 'operator');
    const r = regions(file, o.regions, problems);
    const urls = o.list_url === undefined ? [] : listUrls(file, o.list_url, problems);
    if (!b || !r || !urls) continue;
    if (b.pk === operator) {
      problems.add(file, 'this is the registry operator of operator.json, which is delegated already');
      continue;
    }
    unique(file, b.pk);
    operators.set(name, { ...b, regions: r, ...(urls.length ? { list_url: urls } : {}) });
  }

  const escrows = new Map<string, Escrow>();
  for (const [name, o] of entries('escrows', problems)) {
    const file = `escrows/${name}.json`;
    known(file, o, ['pk', 'contact', 'description', 'sla_days'], problems);
    const b = base(file, name, o, problems, 'escrow');
    const sla = o.sla_days;
    const slaOk = typeof sla === 'number' && Number.isInteger(sla) && sla >= 1 && sla <= 365;
    if (!slaOk) problems.add(file, `sla_days must be an integer 1-365: the most days you take from a dispute to your ruling (it must come before T1, spec §2.3), got ${JSON.stringify(sla)}`);
    if (!b || !slaOk) continue;
    unique(file, b.pk);
    escrows.set(name, { ...b, sla_days: sla });
  }

  const shoppers = new Map<string, Shopper>();
  const shopperEscrows = new Map<string, unknown>();
  for (const [name, o] of entries('shoppers', problems)) {
    const file = `shoppers/${name}.json`;
    known(file, o, ['pk', 'contact', 'description', 'regions', 'payments', 'escrows'], problems);
    const b = base(file, name, o, problems, 'shopper');
    const r = regions(file, o.regions, problems);
    let pays: string[] | undefined;
    if (!Array.isArray(o.payments) || o.payments.length === 0) problems.add(file, `payments must be a non-empty list of: ${PAYMENTS.join(', ')}`);
    else {
      pays = [];
      for (const p of o.payments) {
        if (p === 'usdc-evm') problems.add(file, 'payments: usdc-evm is not offered on ps-main yet (the list has no chain.evm); use btc-signet');
        else if (typeof p !== 'string' || !PAYMENTS.includes(p)) problems.add(file, `payments: unknown payment ${JSON.stringify(p)} (ps-main offers ${PAYMENTS.join(', ')})`);
        else if (pays.includes(p)) problems.add(file, `payments lists ${p} twice`);
        else pays.push(p);
      }
      if (pays.length !== o.payments.length) pays = undefined;
    }
    let names: string[] | undefined;
    if (!Array.isArray(o.escrows) || o.escrows.length === 0 || o.escrows.length > 32) problems.add(file, 'escrows must be a list of 1-32 escrow names (the <name> of escrows/<name>.json) you work with');
    else if (!o.escrows.every((e) => typeof e === 'string' && NAME.test(e))) problems.add(file, 'escrows: every item is the <name> of an escrows/<name>.json');
    else if (new Set(o.escrows).size !== o.escrows.length) problems.add(file, 'escrows lists an escrow twice');
    else names = o.escrows as string[];
    shopperEscrows.set(name, names);
    if (!b || !r || !pays || !names) continue;
    unique(file, b.pk);
    shoppers.set(name, { ...b, regions: r, payments: pays, escrows: names });
  }

  const revoked = new Map<string, Revoked>();
  const byRole = { operator: operators, shopper: shoppers, escrow: escrows } as const;
  for (const [name, o] of entries('revoked', problems)) {
    const file = `revoked/${name}.json`;
    const role = o.role;
    if (role !== 'operator' && role !== 'shopper' && role !== 'escrow') {
      problems.add(file, `role must be "operator", "shopper" or "escrow" (the directory the file came from), got ${JSON.stringify(role)}`);
      continue;
    }
    // a moved operator file may keep its list_url; a revoked delegation carries none
    const extra = { operator: ['regions', 'list_url'], shopper: ['regions', 'payments', 'escrows'], escrow: ['sla_days'] }[role];
    known(file, o, ['role', 'reason', 'pk', 'contact', 'description', ...extra], problems);
    const b = base(file, name, o, problems, role);
    if (!text(o.reason, 300)) problems.add(file, 'reason is required (why the entry was revoked), at most 300 characters');
    if (!b || !text(o.reason, 300)) continue;
    if (byRole[role].has(name)) problems.add(file, `the same name is still in ${role}s/${name}.json; move the file, do not copy it`);
    unique(file, b.pk);
    revoked.set(name, { ...b, role, reason: o.reason });
  }

  for (const [name, names] of shopperEscrows) {
    if (!Array.isArray(names)) continue;
    for (const e of names as string[]) {
      if (escrows.has(e)) continue;
      const r = revoked.get(e);
      if (r?.role === 'escrow') problems.warn(`shoppers/${name}.json`, `escrow ${e} is revoked; no entries with it`);
      else problems.warn(`shoppers/${name}.json`, `there is no escrows/${e}.json (yet); no entries with it until it is added`);
    }
  }
  return { coordinator, operator, operatorName: op.name ?? 'proxy-shopping-registry', ...(op.list_url ? { operatorListUrl: op.list_url } : {}), coordinators, operators, shoppers, escrows, revoked };
}

// ---- events

/** The entries of the registry operator's list: every shopper × each named escrow that exists, per cash region. */
export function listEntries(reg: Registry): ListEntry[] {
  const out: ListEntry[] = [];
  for (const s of reg.shoppers.values()) {
    for (const name of s.escrows) {
      const e = reg.escrows.get(name);
      if (!e) continue;
      for (const region of s.regions) {
        out.push({ region, shopper: s.pk, escrow: e.pk, shops: ['*'], payments: s.payments, tags: [], escrow_sla_days: e.sla_days });
      }
    }
  }
  return out;
}

export function listContent(reg: Registry): Record<string, unknown> {
  const entries = listEntries(reg);
  return {
    network: NETWORK,
    name: reg.operatorName,
    regions: [...new Set(entries.map((e) => e.region))].sort(),
    relays: RELAYS.map((url) => ({ url })),
    chain: CHAIN,
    entries,
    report_to: reg.operator,
  };
}

type Template = { kind: number; created_at: number; tags: string[][]; content: string };

/** The unsigned events of the registry, in the order they are published (delegations before the list). */
export function templates(reg: Registry, version: number): { signer: 'coordinator' | 'operator'; t: Template }[] {
  const delegation = (operator: string, revoked: boolean, note: string, listUrl: string[] = []): Template => ({
    kind: KIND.delegation,
    created_at: version,
    tags: [
      ['d', operator],
      ['v', String(version)],
      ['network', NETWORK],
      ['p', operator],
      ['revoked', String(revoked)],
      ...(revoked ? [] : listUrl.map((u) => ['list_url', u])),
    ],
    content: JSON.stringify({ note }),
  });
  const out: { signer: 'coordinator' | 'operator'; t: Template }[] = [
    { signer: 'coordinator', t: delegation(reg.operator, false, `registry operator (${REPO})`, reg.operatorListUrl) },
  ];
  for (const o of reg.operators.values()) out.push({ signer: 'coordinator', t: delegation(o.pk, false, o.name, o.list_url) });
  for (const r of reg.revoked.values()) {
    if (r.role === 'operator') out.push({ signer: 'coordinator', t: delegation(r.pk, true, `${r.name}: ${r.reason}`) });
  }
  out.push({
    signer: 'operator',
    t: { kind: KIND.list, created_at: version, tags: [['d', NETWORK], ['v', String(version)], ['network', NETWORK]], content: JSON.stringify(listContent(reg)) },
  });
  return out;
}

export function buildEvents(reg: Registry, keys: { coordinator: Uint8Array; operator: Uint8Array }, version: number): NostrEvent[] {
  if (!Number.isSafeInteger(version) || version <= 0) throw new Error(`bad version ${version}`);
  if (getPublicKey(keys.coordinator) !== reg.coordinator) throw new Error('COORDINATOR_MNEMONIC does not belong to the pk in coordinator.json');
  if (getPublicKey(keys.operator) !== reg.operator) throw new Error('OPERATOR_MNEMONIC does not belong to the pk in operator.json');
  return templates(reg, version).map(({ signer, t }) => finalizeEvent(t, keys[signer]));
}

/** Problems of a built events.json against the registry files (the publish job runs it before anything goes out). */
export function verifyEvents(reg: Registry, events: NostrEvent[], version: number): string[] {
  const out: string[] = [];
  const want = templates(reg, version);
  if (events.length !== want.length) out.push(`expected ${want.length} events, got ${events.length}`);
  events.forEach((e, i) => {
    const w = want[i];
    if (!verifyEvent({ ...e })) out.push(`event ${i} (kind ${e.kind}): signature or id does not verify`);
    if (!w) return;
    const signer = w.signer === 'coordinator' ? reg.coordinator : reg.operator;
    if (e.pubkey !== signer) out.push(`event ${i} (kind ${e.kind}): signed by ${e.pubkey}, expected the ${w.signer} ${signer}`);
    if (e.kind !== w.t.kind || e.created_at !== w.t.created_at || JSON.stringify(e.tags) !== JSON.stringify(w.t.tags) || e.content !== w.t.content) {
      out.push(`event ${i} (kind ${e.kind}): content or tags differ from the registry files`);
    }
  });
  return out;
}

export function commitTime(): number {
  try {
    return Number(execFileSync('git', ['-C', ROOT, 'log', '-1', '--format=%ct'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

// ---- site

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function registryJson(reg: Registry, version: number): Record<string, unknown> {
  const strip = <T extends { name: string }>(m: Map<string, T>) => Object.fromEntries([...m].map(([n, { name: _, ...rest }]) => [n, rest]));
  return {
    network: NETWORK,
    version,
    coordinator: reg.coordinator,
    operator: { pk: reg.operator, name: reg.operatorName, ...(reg.operatorListUrl ? { list_url: reg.operatorListUrl } : {}) },
    relays: RELAYS,
    chain: CHAIN,
    events: `${SITE}/events.json`,
    coordinators: strip(reg.coordinators),
    operators: strip(reg.operators),
    shoppers: strip(reg.shoppers),
    escrows: strip(reg.escrows),
    revoked: strip(reg.revoked),
    entries: listEntries(reg),
  };
}

export function coordinatorsJson(reg: Registry): Record<string, unknown> {
  return {
    network: NETWORK,
    source: REPO,
    coordinators: [...reg.coordinators.values()].map((c) => ({
      name: c.name,
      pk: c.pk,
      contact: c.contact,
      description: c.description,
      ...(c.url ? { url: c.url } : {}),
      ...(c.bundle ? { bundle: c.bundle } : {}),
    })),
  };
}

function indexHtml(reg: Registry, version: number): string {
  const table = (head: string[], rows: string[][]): string =>
    `<table><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr>${
      rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('\n') || `<tr><td colspan="${head.length}">none yet / まだありません</td></tr>`
    }</table>`;
  const key = (pk: string) => `<code>${esc(pk)}</code>`;
  const who = (x: Base) => [esc(x.name), key(x.pk), esc(x.contact), esc(x.description)];
  const date = new Date(version * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ps-main trust registry</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:16px;color:#1c2129;background:#fbfbfa}table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow-x:auto}td,th{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top}code{font-size:12px;word-break:break-all}.ja{color:#555}@media(prefers-color-scheme:dark){body{background:#14171c;color:#e3e6ec}td,th{border-color:#333}a{color:#86a8ff}.ja{color:#aab}}</style></head><body>
<h1>ps-main trust registry <span class="ja">/ ps-main 信頼の登録簿</span></h1>
<p>The coordinator of this registry delegates to operators, and its operator signs the list of trusted shopper × escrow combinations
of the <b>${NETWORK}</b> proxy-shopping network. A merged pull request is the approval.<br>
<span class="ja">この登録簿のコーディネータがオペレータに委任し、登録簿のオペレータが ${NETWORK} 網の信頼できる shopper × escrow の組み合わせ一覧に署名する。pull request のマージが承認になる。</span></p>
<p>Coordinator <span class="ja">コーディネータ</span>: ${key(reg.coordinator)}<br>Registry operator <span class="ja">登録簿のオペレータ</span>: ${key(reg.operator)}<br>
Version <span class="ja">版</span>: ${version} (${date})</p>
<p><a href="events.json">events.json</a> (signed events / 署名済みイベント) · <a href="registry.json">registry.json</a> · <a href="coordinators.json">coordinators.json</a> · <a href="llms.txt">llms.txt</a> · <a href="${REPO}#readme">how to join / 参加の方法</a></p>
<h2>Use it <span class="ja">/ 使い方</span></h2>
<p>Web app: Settings → trusted coordinators: add <code>${esc(reg.coordinator)}</code>; trust bundles: <code>${SITE}/events.json</code>.<br>
Go node: <code>trust: {coordinators: ["${esc(reg.coordinator)}"], bundle_urls: ["${SITE}/events.json"]}</code>, relays ${RELAYS.map((r) => `<code>${r}</code>`).join(', ')}.<br>
<span class="ja">Web アプリは設定の「信頼する coordinator」に鍵を、「trust bundle」に events.json の URL を足す。Go ノードは上の trust の設定を使う。</span></p>
<h2>Shoppers <span class="ja">/ shopper</span></h2>
${table(['name', 'key', 'contact', 'description', 'regions', 'payments', 'escrows'], [...reg.shoppers.values()].map((s) => [...who(s), esc(s.regions.join(' ')), esc(s.payments.join(' ')), esc(s.escrows.join(' '))]))}
<h2>Escrows <span class="ja">/ escrow</span></h2>
${table(['name', 'key', 'contact', 'description', 'SLA days'], [...reg.escrows.values()].map((e) => [...who(e), String(e.sla_days)]))}
<h2>Combinations in the list <span class="ja">/ 一覧の組み合わせ</span></h2>
${table(['region', 'shopper', 'escrow', 'payments', 'SLA days'], listEntries(reg).map((e) => [esc(e.region), key(e.shopper), key(e.escrow), esc(e.payments.join(' ')), String(e.escrow_sla_days)]))}
<h2>Delegated operators <span class="ja">/ 委任したオペレータ</span></h2>
<p>Besides the registry operator. They sign their own lists. <span class="ja">登録簿のオペレータのほか。各自が自分の一覧に署名する。</span></p>
${table(['name', 'key', 'contact', 'description', 'regions'], [...reg.operators.values()].map((o) => [...who(o), esc(o.regions.join(' '))]))}
<h2>Revoked <span class="ja">/ 失効</span></h2>
${table(['name', 'role', 'key', 'contact', 'reason'], [...reg.revoked.values()].map((r) => [esc(r.name), esc(r.role), key(r.pk), esc(r.contact), esc(r.reason)]))}
<h2>Coordinator directory <span class="ja">/ コーディネータの目録</span></h2>
<p>Coordinators you may choose. Only the ones you add to your settings are trusted. <span class="ja">選べるコーディネータ。設定に足したものだけが信頼される。</span></p>
${table(['name', 'key', 'contact', 'description', 'url'], [...reg.coordinators.values()].map((c) => [...who(c), c.url ? `<a href="${esc(c.url)}">${esc(c.url)}</a>` : '']))}
</body></html>
`;
}

function llmsTxt(reg: Registry, version: number): string {
  const head = existsSync(join(ROOT, 'llms.txt')) ? readFileSync(join(ROOT, 'llms.txt'), 'utf8').trimEnd() : '# proxy-shopping-registry';
  const line = (x: Base, more: string) => `- ${x.name}: \`${x.pk}\` (${x.contact}) ${more}`.trimEnd();
  return `${head}

## Current registry (version ${version})

Shoppers:
${[...reg.shoppers.values()].map((s) => line(s, `regions ${s.regions.join(' ')}, payments ${s.payments.join(' ')}, escrows ${s.escrows.join(' ')}`)).join('\n') || '- none yet'}

Escrows:
${[...reg.escrows.values()].map((e) => line(e, `SLA ${e.sla_days} days`)).join('\n') || '- none yet'}

Delegated operators (besides the registry operator \`${reg.operator}\`):
${[...reg.operators.values()].map((o) => line(o, `regions ${o.regions.join(' ')}${o.list_url ? `, list_url ${o.list_url.join(' ')}` : ''}`)).join('\n') || '- none yet'}

Coordinator directory:
${[...reg.coordinators.values()].map((c) => line(c, c.url ?? '')).join('\n') || '- none yet'}
`;
}

export function writeSite(out: string, reg: Registry, events: NostrEvent[], version: number): void {
  mkdirSync(out, { recursive: true });
  const json = (f: string, v: unknown) => writeFileSync(join(out, f), JSON.stringify(v, null, 2) + '\n');
  json('events.json', { network: NETWORK, version, coordinator: reg.coordinator, operator: reg.operator, relays: RELAYS, events });
  json('registry.json', registryJson(reg, version));
  json('coordinators.json', coordinatorsJson(reg));
  writeFileSync(join(out, 'index.html'), indexHtml(reg, version));
  writeFileSync(join(out, 'llms.txt'), llmsTxt(reg, version));
  writeFileSync(join(out, '.nojekyll'), '');
  if (existsSync(join(ROOT, 'README.md'))) copyFileSync(join(ROOT, 'README.md'), join(out, 'README.md'));
}

// ---- relays

/** Send the events to each relay; returns per-relay results. */
export async function publish(events: NostrEvent[], relays = RELAYS, timeoutMs = 15_000): Promise<{ relay: string; ok: number; errors: string[] }[]> {
  const { Relay } = await import('nostr-tools/relay');
  return Promise.all(
    relays.map(async (url) => {
      const res = { relay: url, ok: 0, errors: [] as string[] };
      let relay: InstanceType<typeof Relay> | undefined;
      try {
        relay = await withTimeout(Relay.connect(url), timeoutMs, 'connect');
        for (const e of events) {
          try {
            await withTimeout(relay.publish(e), timeoutMs, 'publish');
            res.ok++;
          } catch (err) {
            res.errors.push(`kind ${e.kind} ${e.id.slice(0, 12)}: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        res.errors.push((err as Error).message);
      } finally {
        try {
          relay?.close();
        } catch {
          /* already closed */
        }
      }
      return res;
    }),
  );
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: timed out after ${ms} ms`)), ms);
    p.then((v) => (clearTimeout(t), resolve(v)), (e) => (clearTimeout(t), reject(e)));
  });
}

// ---- command line

function loadOrExit(): Registry {
  const problems = new Problems();
  const reg = load(problems);
  for (const w of problems.warnings) console.log(`warning: ${w}`);
  if (problems.errors.length) {
    console.error(problems.errors.map((p) => `- ${p}`).join('\n'));
    console.error(`\n${problems.errors.length} problem(s)`);
    process.exit(1);
  }
  console.log(
    `ok: ${reg.shoppers.size} shopper(s), ${reg.escrows.size} escrow(s), ${listEntries(reg).length} list entr${listEntries(reg).length === 1 ? 'y' : 'ies'}, ` +
      `${reg.operators.size} operator(s), ${reg.revoked.size} revoked, ${reg.coordinators.size} coordinator(s) in the directory`,
  );
  return reg;
}

function readEvents(out: string): { version: number; events: NostrEvent[] } {
  const j = JSON.parse(readFileSync(join(out, 'events.json'), 'utf8')) as { version: number; events: NostrEvent[] };
  return { version: j.version, events: j.events };
}

async function main(): Promise<void> {
  const [cmd, out] = process.argv.slice(2);
  const usage = 'usage: node scripts/registry.ts validate | build <out dir> | verify <out dir> | publish <out dir>';
  if (cmd === 'validate') return void loadOrExit();
  if (!out || !['build', 'verify', 'publish'].includes(cmd ?? '')) {
    console.error(usage);
    process.exit(2);
  }
  if (cmd === 'build') {
    const reg = loadOrExit();
    const mc = process.env.COORDINATOR_MNEMONIC;
    const mo = process.env.OPERATOR_MNEMONIC;
    if (!mc || !mo) throw new Error('COORDINATOR_MNEMONIC and OPERATOR_MNEMONIC must be set');
    const version = commitTime();
    const events = buildEvents(reg, { coordinator: nostrKey(mc), operator: nostrKey(mo) }, version);
    writeSite(out, reg, events, version);
    console.log(`wrote ${out}/ (${events.length} events, version ${version})`);
    return;
  }
  if (cmd === 'verify') {
    const reg = loadOrExit();
    const { version, events } = readEvents(out);
    const problems = verifyEvents(reg, events, version);
    if (problems.length) {
      console.error(problems.map((p) => `- ${p}`).join('\n'));
      process.exit(1);
    }
    console.log(`verified ${events.length} events of version ${version}`);
    // the web client's own parsers (proxy-shopping-web core), when a checkout is available
    const { loadCoreTrust } = await import('./compat.ts');
    const { core, reason } = await loadCoreTrust();
    if (!core) {
      console.log(`::notice::${reason}`);
      if (process.env.REQUIRE_COMPAT === '1') process.exit(1);
      return;
    }
    const bad = events.filter((e) => (e.kind === KIND.delegation ? !core.parseDelegation(e) : !core.parseOperatorList(e)));
    const eff = core.effectiveCombinations({ coordinators: [reg.coordinator], network: NETWORK, events });
    const want = listEntries(reg).length;
    if (bad.length || eff.entries.length !== want) {
      console.error(`the TS core refuses ${bad.length} event(s) and finds ${eff.entries.length} of ${want} entries`);
      process.exit(1);
    }
    console.log(`the TS core accepts every event and finds all ${want} entries`);
    return;
  }
  const { events } = readEvents(out);
  const results = await publish(events);
  for (const r of results) {
    console.log(`${r.relay}: ${r.ok}/${events.length} accepted${r.errors.length ? `; ${r.errors.join('; ')}` : ''}`);
  }
  if (!results.some((r) => r.ok === events.length)) {
    console.error('no relay accepted every event');
    process.exit(1);
  }
  process.exit(0); // relays may keep sockets open
}

if (process.argv[1]?.endsWith('registry.ts')) {
  main().catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
