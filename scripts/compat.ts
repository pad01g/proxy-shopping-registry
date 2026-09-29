// Load the trust parsers of the web client (pad01g/proxy-shopping-web, packages/core/src/trust) straight from
// their TypeScript sources, so that the tests check the built events with the code users actually run.
//
// The core imports its siblings as "./x.js" (compiled layout) and nostr-tools as a bare specifier. The hooks
// below map "./x.js" to "./x.ts" when only the .ts exists, and resolve bare specifiers from this repository
// when the checkout has no node_modules (CI checks out the sources only).
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

/** Where the proxy-shopping-web checkout is: PS_WEB_DIR, else ../proxy-shopping-web next to this repository. */
export const WEB_DIR = resolve(process.env.PS_WEB_DIR ?? fileURLToPath(new URL('../../proxy-shopping-web', import.meta.url)));
export const CORE_TRUST = join(WEB_DIR, 'packages/core/src/trust');

export type CoreTrust = {
  parseDelegation: (e: unknown) => { coordinator: string; operator: string; version: number; network: string; revoked: boolean; note?: string } | undefined;
  parseOperatorList: (e: unknown) => { operator: string; version: number; network: string; content: { entries: unknown[]; relays: { url: string }[]; chain?: unknown; regions: string[]; report_to?: string } } | undefined;
  effectiveCombinations: (p: { coordinators: string[]; network: string; events: unknown[] }) => {
    entries: { region: string; shopper: string; escrow: string; payments: string[]; shops: string[]; escrow_sla_days: number; provenance: { coordinator: string; operator: string; listVersion: number } }[];
    delegations: { operator: string; revoked: boolean }[];
  };
};

let hooked = false;

/** The core trust module, or undefined (with the reason) when no checkout of proxy-shopping-web is available. */
export async function loadCoreTrust(): Promise<{ core?: CoreTrust; reason?: string }> {
  if (!existsSync(join(CORE_TRUST, 'events.ts'))) {
    return { reason: `no proxy-shopping-web checkout at ${WEB_DIR} (set PS_WEB_DIR); compatibility with the TS core was NOT checked` };
  }
  if (!hooked) {
    hooked = true;
    const webPrefix = pathToFileURL(WEB_DIR).href + '/';
    const here = import.meta.url;
    registerHooks({
      resolve(specifier, context, next) {
        const parent = context.parentURL ?? '';
        if (!parent.startsWith(webPrefix)) return next(specifier, context);
        if (specifier.startsWith('.') && specifier.endsWith('.js')) {
          const js = new URL(specifier, parent);
          const ts = new URL(specifier.replace(/\.js$/, '.ts'), parent);
          if (!existsSync(fileURLToPath(js)) && existsSync(fileURLToPath(ts))) return next(ts.href, context);
        }
        if (!specifier.startsWith('.') && !specifier.startsWith('node:') && !specifier.startsWith('file:')) {
          try {
            return next(specifier, context);
          } catch {
            return next(specifier, { ...context, parentURL: here });
          }
        }
        return next(specifier, context);
      },
    });
  }
  const events = await import(pathToFileURL(join(CORE_TRUST, 'events.ts')).href);
  const effective = await import(pathToFileURL(join(CORE_TRUST, 'effective.ts')).href);
  return { core: { parseDelegation: events.parseDelegation, parseOperatorList: events.parseOperatorList, effectiveCombinations: effective.effectiveCombinations } };
}
