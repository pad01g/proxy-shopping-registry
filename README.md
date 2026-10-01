# proxy-shopping-registry

The trust registry of the public **`ps-main`** network of [proxy-shopping](https://github.com/pad01g/proxy-shopping-go)
(a P2P network where somebody buys for you, paid in crypto, in shops that take only cash or local payments).
[日本語](#日本語)

Documentation in 14 languages: https://pad01g.github.io/proxy-shopping-docs/

A merged pull request is the approval. After every merge, CI signs the events with the keys of the registry
and publishes them to the ps-main relays and to GitHub Pages:

| | |
|---|---|
| Coordinator (the root you trust) | `7a0a27bb7092dc59b5bfe195d9f0e0cf81c69373b0d702a41490ed45cfccbe39` |
| Registry operator (signs the list) | `c1846b34ad9b13d28a602575ed6f762099b7300e0e1e819c585ae49b8c8c3118` |
| Signed events (trust bundle) | https://pad01g.github.io/proxy-shopping-registry/events.json |
| Readable registry | https://pad01g.github.io/proxy-shopping-registry/ ([registry.json](https://pad01g.github.io/proxy-shopping-registry/registry.json)) |
| Coordinator directory | https://pad01g.github.io/proxy-shopping-registry/coordinators.json |
| For agents | https://pad01g.github.io/proxy-shopping-registry/llms.txt |
| Relays | `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net` |
| Chain | BTC signet, Esplora `https://mempool.space/signet/api` (USDC is not offered on ps-main yet) |

What is signed (protocol: [spec §2](https://github.com/pad01g/proxy-shopping-go/blob/main/docs/spec.md)):

- kind **30500** delegations by the coordinator: to the registry operator, to every `operators/<name>.json` (with a
  `["list_url", "https://…"]` tag per `list_url` of the file), and a revoked one for every operator in `revoked/`;
- one kind **30501** list for `ps-main` by the registry operator: every `shoppers/<name>.json` × each escrow it
  names that is in `escrows/`, one entry per cash region of the shopper, with the ps-main relays and chain.

Shoppers and escrows publish their own profiles (kind 30502 / 30503) from their nodes; the registry only vouches for
the combinations.

## Use this coordinator

Trusting a coordinator means: you see the shoppers and escrows that it (through its operators) lists. Nothing else
is trusted; you can add several coordinators (the first one wins on conflicts) and remove one at any time.

**Web app** (proxy-shopping-web): Settings → *Trusted coordinators*: add
`7a0a27bb7092dc59b5bfe195d9f0e0cf81c69373b0d702a41490ed45cfccbe39`; *Trust bundles*: add
`https://pad01g.github.io/proxy-shopping-registry/events.json`. Deployments can ship this in `config.json`
(see `apps/web/public/config.ps-main.json`):

```json
{
  "network": "ps-main",
  "relays": ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"],
  "coordinators": ["7a0a27bb7092dc59b5bfe195d9f0e0cf81c69373b0d702a41490ed45cfccbe39"],
  "trust_bundles": ["https://pad01g.github.io/proxy-shopping-registry/events.json"],
  "coordinator_directory": "https://pad01g.github.io/proxy-shopping-registry/coordinators.json",
  "esplora": "https://mempool.space/signet/api"
}
```

With `coordinator_directory`, Settings lists the coordinators of this directory, and you can add one with a click.

**Go node** (`psnode`, proxy-shopping-go; example: `lab/examples/ps-main-shopper.yaml`):

```yaml
network: ps-main
nostr:
  relays: ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.primal.net"]
trust:
  coordinators: ["7a0a27bb7092dc59b5bfe195d9f0e0cf81c69373b0d702a41490ed45cfccbe39"]
  # optional: fetched at start and every 10 minutes, verified like relay events
  bundle_urls: ["https://pad01g.github.io/proxy-shopping-registry/events.json"]
chain:
  btc: {network: signet, esplora: "https://mempool.space/signet/api"}
```

**MCP server** (`io.github.pad01g/proxy-shopping`, proxy-shopping-web `packages/mcp`): its default network
`ps-main` already uses this registry (coordinator, `coordinators.json` directory and `events.json` bundle):

```sh
claude mcp add proxy-shopping -- docker run -i --rm -v proxy-shopping-mcp:/data ghcr.io/pad01g/proxy-shopping-mcp:0.1.2
```

`PS_COORDINATORS` replaces the trusted coordinators (comma separated pubkeys); `PS_CONFIG_URL` / `PS_CONFIG_FILE`
point it at another network configuration. The tool `registry_entry` writes the file for your pull request here.

Without the bundle URL, clients fetch the same events from the relays; the bundle only helps when relays have
dropped them.

**Pull requests are welcome.** Listing yourself here is optional: the network is permissionless, so you can also run
your own coordinator and operator keys (or fork this registry for your community) and publish your own lists — see
https://pad01g.github.io/proxy-shopping-docs/en/quickstart/ (section 3).

## Roles

| Role | What it means | How to get it |
|---|---|---|
| **Shopper** | Your node quotes and buys for users in your cash regions. You appear in the list, paired with the escrows you name | pull request adding `shoppers/<name>.json` |
| **Escrow** | You rule disputes of the orders that paid you the upfront fee, within your SLA | pull request adding `escrows/<name>.json` |
| **Operator** | The coordinator delegates to your key; you sign your own ps-main list (kind 30501) of shopper × escrow combinations | pull request adding `operators/<name>.json`, then sign and publish your list yourself |
| **Coordinator** | The root of trust. Every user chooses coordinators; nobody can make you one | run your own registry (fork this repository, make your own keys); pull request adding `coordinators/<name>.json` to be listed in the directory that the web app and the MCP server offer |

Rules for every entry: `pk` is your Nostr public key as 64 lowercase hex characters (x-only, not `npub`), and you
must control its private key; `contact` (e.g. `github:<user>`) and `description` are required; file names are
`<name>.json` with a-z, 0-9 and `-`. A key may appear in one entry only. The maintainer merges what they are willing
to vouch for. `Validate` tells you exactly what is wrong with a file.

### Your public key

- Go node: `psctl keys --mnemonic-file <your mnemonic file>` prints `nostr_pubkey` (use that, not `npub`).
- Web app: Settings → *Key* shows your public key (also in the header).

The key is the NIP-06 key (`m/44'/1237'/0'/0/0`) of your BIP39 mnemonic. Use the mnemonic of the node that will do
the work: a shopper's entry must carry the key of the shopper node.

### Shopper

1. Run a shopper node on `ps-main` (see the Go example above) with the payments and cash regions you offer.
2. Agree with one or more escrows (they must be, or become, `escrows/<name>.json`).
3. Add `shoppers/<name>.json`:
   ```json
   {
     "pk": "<nostr_pubkey>",
     "contact": "github:<you>",
     "description": "Who you are and what you buy, e.g. cash-only shops in Tokyo and Kanagawa",
     "regions": ["JP-13", "JP-14"],
     "payments": ["btc-signet"],
     "escrows": ["<escrow name>"]
   }
   ```
   `regions` are your cash regions (spec §2.5: `JP`, `JP-13`, `JP-13-13104`); `payments` is `btc-signet` for now.
   Escrows that are not (yet) in `escrows/` are skipped with a warning.

### Escrow

1. Run an escrow node (or the web app's escrow page) on `ps-main`.
2. Add `escrows/<name>.json`:
   ```json
   {
     "pk": "<nostr_pubkey>",
     "contact": "github:<you>",
     "description": "Who you are and how you rule disputes",
     "sla_days": 14
   }
   ```
   `sla_days` (1–365) is the most days you take from a dispute to your ruling; it is in every list entry with you.

### Operator

1. Make a mnemonic for your operator key, keep it offline, and get its public key (`psctl keys`).
2. Add `operators/<name>.json` with `pk`, `contact`, `description` (whose shoppers and escrows you list and how
   you check them) and `regions` (where you list).
3. After the merge the coordinator's delegation to you is published. Sign your list with a larger version every time
   (for example the current Unix time) and publish it to the ps-main relays:
   ```sh
   psctl list --mnemonic-file operator.mnemonic --file list.json --version "$(date +%s)" \
     --publish wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net
   ```
   `list.json` is the list content of spec §2.3 with `"network": "ps-main"` (entries with `tags: []`, `shops: ["*"]`).
4. Optional, recommended: host your signed bundle at an https URL and name it in `list_url` of your file:
   ```json
   {
     "pk": "<nostr_pubkey>",
     "contact": "github:<you>",
     "description": "Whose shoppers and escrows you list and how you check them",
     "regions": ["JP-27"],
     "list_url": "https://example.org/ps-main/bundle.json"
   }
   ```
   The bundle (spec §2.6) is `{"events": […]}` with your kind 30501 list and the latest 30502 / 30503 / 10050
   profiles of the shoppers and escrows you list, exactly as they signed them; `psctl list … --bundle-out <file>`
   (proxy-shopping-go) writes it. Rebuild and re-upload it whenever you sign a new list version. The coordinator's
   delegation to you then carries one `["list_url", <url>]` tag per URL, so the URL is signed as part of the
   delegation. Clients fetch the bundle over HTTPS (redirects only to the same origin, at most 2 MiB) and verify
   every event, so the registry no longer needs relays for your list; publishing to relays remains optional.
   `list_url` is one URL or a list of up to 4 (mirrors): absolute `https://`, no credentials, no `#fragment`, at most
   512 characters each, no duplicates. Changing it is a pull request like any other change to your file.

### Coordinator (being listed in the directory)

Fork this repository, put your own `coordinator.json` / `operator.json` and your mnemonics as repository secrets
`COORDINATOR_MNEMONIC` / `OPERATOR_MNEMONIC`, and publish your own `events.json`. Then open a pull request here
adding `coordinators/<name>.json` with `pk`, `contact`, `description`, and optionally `url` (your page) and `bundle`
(the https URL of your `events.json`). Being listed means users can find and choose you; this registry does not
trust your lists.

### Revocation

A pull request that moves `operators/<name>.json`, `shoppers/<name>.json` or `escrows/<name>.json` to
`revoked/<name>.json` and adds `"role"` (`operator`, `shopper` or `escrow`) and `"reason"`. For an operator, the next
build contains a revoked delegation with a newer version, so clients that still hold its old list stop using it.
A revoked shopper or escrow is left out of the next list version. Deleting an entry also removes it from the next
list; `revoked/` keeps the record and the key out of new entries.

## For the maintainer

- The keys are only in the repository secrets `COORDINATOR_MNEMONIC` and `OPERATOR_MNEMONIC` (BIP39; NIP-06 keys)
  and in an offline backup. They never appear in the repository or in logs. Only `Publish` (push to `main`) reads
  them; nothing that runs on pull requests does.
- Pull requests from others may only touch `coordinators/`, `operators/`, `shoppers/`, `escrows/` and `revoked/`
  `<name>.json` (checked by `Validate`). Changes to `scripts/`, `package*.json` or `.github/` run with the keys after
  a merge: review them yourself. Dependencies are pinned by `package-lock.json` and installed without scripts.
- Versions are the commit time of `main` (`v` = `created_at`), so every merge produces newer versions; public
  relays that replace addressable events by `created_at` keep the newest too. Do not merge commits with a committer
  date older than the last published one.
- `Publish` checks the events with the web client's parsers (checkout of `pad01g/proxy-shopping-web`) and the Go
  node's trust store (checkout of `pad01g/proxy-shopping-go`) when those repositories can be checked out, and skips
  each check with a notice otherwise. Relay failures only fail the job when no relay accepts every event.
- Test locally (Node 24): `npm ci && node --test scripts/*.test.ts && node scripts/registry.ts validate`
  (with `../proxy-shopping-web` next to this repository, or `PS_WEB_DIR`, for the compatibility test).

---

## 日本語

proxy-shopping（現金や地域の決済しか使えない店での買い物を、暗号通貨で代行してもらう P2P 網）の公開網
**`ps-main`** の信頼の登録簿。**pull request がマージされたことが承認になる。** マージのたびに CI が登録簿の鍵で
イベントに署名し、ps-main のリレーと GitHub Pages に公開する。

- コーディネータ: `7a0a27bb7092dc59b5bfe195d9f0e0cf81c69373b0d702a41490ed45cfccbe39`
- 登録簿のオペレータ（一覧に署名する）: `c1846b34ad9b13d28a602575ed6f762099b7300e0e1e819c585ae49b8c8c3118`
- 署名済みイベント（trust bundle）: https://pad01g.github.io/proxy-shopping-registry/events.json
- 読める形: https://pad01g.github.io/proxy-shopping-registry/ 、コーディネータの目録: `coordinators.json`
- リレー: `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`。チェーン: BTC signet（Esplora
  `https://mempool.space/signet/api`）。USDC は ps-main ではまだ扱わない。

署名するもの（仕様 §2）: コーディネータから登録簿のオペレータと `operators/` の各オペレータへの委任書
（kind 30500、`revoked/` のオペレータには失効の委任書）と、登録簿のオペレータの ps-main の一覧（kind 30501）。
一覧は `shoppers/` の各 shopper × その shopper が挙げた `escrows/` にある各 escrow を、shopper の現金の地域ごとに並べたもの。
プロフィール（30502 / 30503）は shopper・escrow が自分のノードから出す。

### このコーディネータを使う

- **Web アプリ**: 設定の「信頼する coordinator」に上の鍵を、「trust bundle」に events.json の URL を足す。配布側は
  `config.json` に `coordinators`, `trust_bundles`, `coordinator_directory`（coordinators.json の URL）を書ける
  （`apps/web/public/config.ps-main.json`）。目録があると、設定画面に候補のコーディネータが出て、ボタンで足せる。
- **Go ノード**: `trust.coordinators` に鍵、`trust.bundle_urls` に events.json の URL（起動時と 10 分ごとに取得し、
  リレーのイベントと同じく検証して取り込む）。例は `lab/examples/ps-main-shopper.yaml`。
- **MCP サーバー**（`io.github.pad01g/proxy-shopping`）: 既定の網 `ps-main` がこの登録簿（coordinator、`coordinators.json` の目録、`events.json`）をそのまま使う。信頼する coordinator を替えるときは `PS_COORDINATORS`。道具 `registry_entry` がここへの pull request 用のファイルを作る。

### 役割

| 役割 | 意味 | なり方 |
|---|---|---|
| shopper | 現金の地域で見積と代理購入をする。挙げた escrow と組にして一覧に載る | `shoppers/<name>.json` を足す PR |
| escrow | 前払い手数料を受けた注文の紛争を SLA の日数以内に裁定する | `escrows/<name>.json` を足す PR |
| オペレータ | コーディネータから委任を受け、自分で ps-main の一覧（kind 30501）に署名する | `operators/<name>.json` を足す PR。マージ後に自分で一覧に署名して出す |
| コーディネータ | 信頼の根。各利用者が自分で選ぶので、誰かに「してもらう」ものではない | このリポジトリを fork して自分の鍵で登録簿を運営する。ここの目録に載るなら `coordinators/<name>.json` の PR |

どの登録も `pk`（Nostr の公開鍵、小文字 hex 64 文字。npub ではない。秘密鍵を自分で持っていること）、`contact`
（例 `github:<user>`）、`description` が必須。ファイル名は `<name>.json`（a-z, 0-9, `-`）。同じ鍵は 1 か所だけ。
公開鍵は Go ノードなら `psctl keys --mnemonic-file <ニーモニックのファイル>` の `nostr_pubkey`、Web アプリなら設定の
「鍵」の欄に出る。書き方（JSON の例）は上の英語の節をそのまま使える。

- shopper: `regions`（現金の地域、`JP-13` など）、`payments`（今は `btc-signet`）、`escrows`（組む escrow の名前）。
- escrow: `sla_days`（1–365、紛争の申立から裁定までの日数の上限）。
- オペレータ: `regions`。マージ後に `psctl list --mnemonic-file … --file list.json --version "$(date +%s)" --publish wss://…` で一覧に署名してリレーに出す。
  任意（推奨）で `list_url`: 署名済みの束（仕様 §2.6）を置いた https の URL（1 つの文字列か、最大 4 つのリスト）。
  束は `{"events": […]}` で、自分の 30501 の一覧と、一覧に載せた shopper・escrow の最新の 30502 / 30503 / 10050 の
  プロフィール（本人の署名のまま）を入れたもの。`psctl list … --bundle-out <ファイル>`（proxy-shopping-go）が作る。
  一覧の版を出すたびに作り直して置き直す。コーディネータの委任書に URL ごとに `["list_url", <url>]` のタグが付く
  （URL も委任として署名される）。クライアントは束を HTTPS で取り寄せて 1 件ずつ検証するので、登録簿はその一覧の
  ためにリレーを必要としない（リレーへの公開は任意で続けてよい）。URL は絶対の `https://`、認証情報と `#` なし、
  512 文字以内、重複なし。

**失効**は `operators/`・`shoppers/`・`escrows/` の `<name>.json` を `revoked/<name>.json` に移し、`"role"` と
`"reason"` を足す PR。オペレータなら次の版で新しい版の失効の委任書が出るので、古い一覧を持っているクライアントも
それを使わなくなる。shopper・escrow は次の一覧から外れる。

**管理者向け**: 鍵はリポジトリの secret（`COORDINATOR_MNEMONIC`, `OPERATOR_MNEMONIC`）とオフラインの控えにだけある。
PR で動くものは鍵を読まない。他人の PR が触れてよいのは登録のファイルだけ（`Validate` が確かめる）。`scripts/`・
`.github/`・`package*.json` の変更はマージ後に鍵と一緒に動くので自分で読むこと。版は `main` のコミット時刻。
