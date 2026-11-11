# SurfCore · One character across four channels

[中文 README](README.md)

SurfCore runs in DeepSeek Harness (DSH). On macOS, the active character can use WeChat direct messages, QQ, Bilibili and the desktop pet. Each channel uses the same SurfCore character and follows its own memory sharing rules.

## macOS setup

1. Install DSH Desktop and open it once.
2. Clone the fork's `feat/macos-wechat` branch, install dependencies with Node.js 22.13 or newer, and run `QQ_BRIDGE_SKIP_DSH_INSTALL=1 node scripts/setup-dsh.mjs desktop`.
3. Restart DSH and open **Settings → SurfCore**. The overview shows the active character and links to each channel's settings.

The [macOS quick start](README.md#macos-快速开始) covers all four channels. QQ on macOS uses LLBot's OneBot 11 HTTP and forward WebSocket endpoints. QQ on Windows uses SnowLuma. See the [Windows installation guide](docs/guides/INSTALL.md) and [QQ on macOS](docs/cases/2026-11-11-macos-qq.md).

## Architecture

WeChat, Bilibili and the desktop pet run through the SurfCore plugin. QQ messages go through an external OneBot 11 gateway and SurfCore’s QQ bridge into DSH sessions.

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client.
- **DSH side**: adapted for DSH 0.1.2+ and **re-verified on 0.2.0-rc.2** — session Cookie minted from the persistent local signing key, `/api/<namespace>/<method>` slash RPC, and `/api/remote.mux` + `session/follow` event stream (the pending queue is read from `value.projections[<id>].values.inbox`, with the unary `session/projections` RPC as the primary path). The per-session model is pinned by the bridge via `session.selectModel` from `config.json`'s `dsh.model` (default `deepseek-flash` = DeepSeek-V41-Flash, multimodal).
- **Agent tools**: three bundled MCP servers expose a restricted QQ toolset (`qq_status`, `qq_list_groups`, `qq_get_group_history`, `qq_send_group_message`, `qq_reply`, etc.), a read-only host probe (`snowluma_status` only), and a read-only `web_search` / `web_fetch` pair with SSRF protection.
  ⚠️ **`start_snowluma` / `stop_snowluma` (and `snowluma.allowProcessControl`) were removed in v0.1.5**: SnowLuma EULA §5.4 requires prior written permission to deploy its proprietary native components through automated scripts. This program only probes, never deploys — installing, starting and scanning SnowLuma is always up to you. See [LICENSE](LICENSE) and [RULES.md](RULES.md).
- **Console**: a local web console at `http://127.0.0.1:3100`, organised into ten task-based pages (Overview, Sessions & Approvals, Persona, Social v2, Social v1, Slang, Usage & Cost, Access & Security, Operations, Tool Reference) with cross-page feature search and a **light / dark theme** (one-click toggle in the header; follows the OS preference until you choose), for mode switching, role management, whitelist/admin settings, slang management, memory, stickers and more. The Persona page manages roles (view/edit/rename/duplicate/delete the prompt of each persona), shows and edits both prompt layers separately — the **simulation prompt** built into the preset (tool/behaviour protocol; synced to DSH, restart required) and the **persona prompt** (`roles/*.md`; applied immediately) — and sets the **DSH reasoning effort** (`max` by default, `high`/`low` selectable). The **Usage & Cost** page shows real-time token consumption and its price in CNY, broken down per group/friend and per conversation turn (see [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)).

## Features

- Bridges QQ group/private messages to DSH agent sessions.
- Social simulation mode ("simulated group friend") with idle/active/probing/exiting states.
- Space-based message splitting for more natural multi-message replies.
- Whitelist/blacklist access control, fail-closed by default.
- Sensitive text audit prevents paths/credentials from being sent to QQ.
- MCP tools for reading group history/members, sending messages, replying with quotes, and (in `reserved2`) full simulated-group-friend tooling.
- Slang/network-expression learning with human confirmation.
- Lightweight memory system for active topics, pending thoughts and member impressions.
- **Memory cards (the character's long-term memory)**: two cards sharing one document family — the **decayed card** (`memory-card.*`) is the only one loaded into prompts (owner + emotional memories stay vivid, unimportant ones fade one level per day), while the **full archive** (`memory-card-full.*`) keeps every memory permanently vivid and is never injected; it exists for on-demand search/recall via the settings page or `/api/memory-card/full`. Capacity alerts at 80/90/100% with one-click compression apply to the decayed card only; the full archive has a soft cap and is never auto-deleted. Rules and configuration: [docs/guides/MEMORY_CARD.md](docs/guides/MEMORY_CARD.md).
- **Character personas (multi-character)**: each character is a directory bundle (`~/.dsh/surfcore/characters/<id>/`) with its persona card, decayed/full memory cards, Bilibili behavior ledgers, and snapshots. The settings page can create/load/save/restore/delete characters; loading another character snapshots the old one, stops and restarts the QQ bridge and Bilibili scheduler with fresh sessions, and switches the current pointer with an epoch. Twelve autosave slots (before-switch + 180/90/60/30/15/10/7/5/3/2/1 days); today's actions under the old character never count toward the new one and are never replayed. See [docs/guides/CHARACTER_PERSONA.md](docs/guides/CHARACTER_PERSONA.md).
- Sticker library integration with AI-friendly sticker usage.
- **SurfCore plugin** runs the channel settings, WeChat text messaging, Bilibili scheduler, desktop pet API and shared character memory.
- **Fish-school protection**: QQ groups suppress autonomous participation when the recent window is dominated by other fish bots; Bilibili comments skip new top-level comments when too many fish are present, gather into a fish thread instead, and like fish comments within a low daily cap. Both sides are configurable and can be disabled independently.

## Requirements

- Node.js >= 22.13
- Running DeepSeek Harness Web (default `http://127.0.0.1:3080`)
- A QQ gateway with OneBot 11 HTTP and forward WebSocket enabled, when using QQ

## QQ bridge setup

```bash
npm install        # postinstall automatically patches the @snowluma/sdk ESM packaging bug
```

Copy `config.example.json` to `config.json`, then edit:

```bash
cp config.example.json config.json
```

Key settings:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | DSH Web API URL, default `http://127.0.0.1:3080` |
| `dsh.authToken` | DSH launch token (a process-launch credential). **Normally leave this empty**: with no token the bridge mints the session cookie offline from the persistent signing key in `~/.dsh/.credentials.yaml`, which depends on no per-process state (since DSH 0.1.7 the launch token lives only in memory — the one in the old logs belongs to a previous process and only yields a 401). A value here is honoured first if you set one |
| `dsh.authHeader` / `dsh.authPrefix` | Legacy fields kept for compatibility; the current path uses Cookie auth and does not send this header |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.accessToken` | OneBot access token, leave empty if not configured |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`); do not point this at the WebSocket port or you will get HTTP 426 |
| `ownerQQ` | Administrator QQ (highest privilege) |
| `allow.private` / `allow.groups` | Whitelist of QQ/group IDs |
| `deny.users` | Person blacklist (QQ IDs): messages from these users are ignored in **every** group and in private chat (not stored, not fed to the agent, no wake-up, pokes ignored). Beats `allow.*` and `allowAllWhenEmpty` |
| `deny.private` / `deny.groups` | Conversation blacklist (QQ/group IDs), takes precedence over the whitelist |
| `consolePort` | Local console port, default `3100` |

Start:

```bash
npm start
```

Or double-click `start.bat` on Windows (guard mode with auto-restart).

## DSH Setup on Another Device

The bridge and console can run without extra DSH setup, but the two DSH chat presets (`qq-chat` and `qq-chat-v2`) and the MCP servers must be installed into DSH once per machine:

```bash
node scripts/setup-dsh.mjs
```

This installs:

- the two `@deepseek-ai/dsh-agent-preset` rows (`qq-chat`, `qq-chat-v2`) plus the shared `qq-tool-restrict` safety guard, all inside the `surfcore` bundle
- MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`
- only `surfcore` in the profile `package.json` (`bundles` + `link:` dependency)
- Default DSH mode set to `reserved2` (second-generation simulation), with a local `state/mode.json` fallback

Then restart DSH. See [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) for details.

## Security Notes

- `config.json` and `state/` are **never committed**; the repository only ships `config.example.json`. Both are ACL-hardened to the owner / SYSTEM / Administrators (`npm run harden-acl`).
- MCP send tools enforce whitelist checks and reject CQ-code injection.
- Local paths, credentials, tokens and other sensitive patterns are filtered by the audit layer.
- Simulation sessions get **no local execution tools at all**: the preset's `qq-tool-restrict` row hides them from the tool schema at registration time and a runtime allowlist rejects anything outside the QQ MCP namespaces (`npm run scan:tool-names` re-checks that list against the installed DSH).
- The console uses a generated token when none is configured.

## Repository Layout

```
surfcore/
  config.example.json   # sanitized config template (real config.json is not in repo)
  docs/
    README.md           # documentation index (one line per doc + "still current?" notes)
    FOLDER_MAP.md       # folder layout and scripts/ naming conventions
    guides/             # user/operator facing + code-level docs: ARCHITECTURE, MODULE-*, SUBSYSTEM-*, DATA-AND-CONFIG, BOUNDARIES, DSH_SETUP, ...
    design/             # design & planning docs
    research/           # investigation notes
    audits/             # review / optimisation reports
    legacy/             # archived docs that were superseded
  dsh/agent-presets/    # qq-chat / qq-chat-v2 DSH agent preset templates
  plugins/surfcore  # DSH bundle: generates the qq-chat / qq-chat-v2 preset patch rows + the shared tool guard
  plugins/surfcore       # merged DSH plugin: SurfCore settings window + QQ/Bilibili memory/alignment
  src/                  # bridge core and MCP servers
  public/
    console.html        # local web console
  roles/                # persona cards
  assets/               # images (the intro video ships as a release asset, not in the repo)
  scripts/              # tests and helper scripts
  state/                # runtime data (not in repo)
```

## Testing

`npm run test:audit` runs isolated regression tests without production credentials, DSH, or QQ messages. For what is covered and what is still red, see [docs/RISK_REGISTER.md](docs/RISK_REGISTER.md) and [docs/PITFALLS.md](docs/PITFALLS.md) (Chinese).

After upgrading, legacy QQ session mappings without permission metadata are recreated once. Mode or preset changes also retire the old mapping and recreate the session on the next message; DSH history is retained.

```bash
npm run self-test       # DSH-side link test, no QQ/SnowLuma required
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-slang
npm run test-stickers
```

## Compliance

SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ. This project is for learning and technical research only; please follow the relevant terms and the QQ User Agreement.
