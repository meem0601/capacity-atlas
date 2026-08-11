# Capacity Atlas

[日本語](README.md) | **English**

**All your AI capacity in one dashboard.**

Capacity Atlas is a local-first, open-source dashboard for monitoring remaining capacity, reset times, and authentication status across multiple OpenAI Codex, Claude, and Grok accounts.

It does not switch accounts automatically, proxy prompts, or relay model traffic.

![Capacity Atlas dashboard](docs/assets/dashboard.png)

## Download

No preinstalled Node.js runtime or provider CLI is required.

- [Download for macOS Apple Silicon](https://github.com/meem0601/capacity-atlas/releases/latest/download/Capacity-Atlas-Connector-macOS-arm64.zip)
- [Download for Windows x64](https://github.com/meem0601/capacity-atlas/releases/latest/download/Capacity-Atlas-Connector-Windows-x64.zip)
- [View all releases](https://github.com/meem0601/capacity-atlas/releases)

Launch the Connector, click **Add account**, and complete OAuth in your browser.

### First launch on macOS Apple Silicon

1. Extract the ZIP and move `Capacity Atlas Connector.app` to Applications.
2. The current release is not yet Apple-notarized. If macOS blocks a normal double-click, **Control-click the app, choose Open, then choose Open again**.
3. If the browser does not open automatically, launch the Connector app again. Do not type the loopback URL manually: the launcher supplies a temporary local capability in the launch URL.

This package supports Apple Silicon Macs. Before bypassing the warning, compare the downloaded ZIP's SHA-256 with the value published in the GitHub Release.

### First launch on Windows x64

1. Extract the entire ZIP and keep every file in the same folder.
2. Double-click `Start Capacity Atlas.cmd`.
3. The current release is not yet code-signed. If SmartScreen appears, choose **More info → Run anyway** only after verifying the GitHub Release source, filename, and SHA-256.
4. If the browser does not open automatically, run `Start Capacity Atlas.cmd` again.

SHA-256 verification in PowerShell:

```powershell
Get-FileHash .\Capacity-Atlas-Connector-Windows-x64.zip -Algorithm SHA256
```

## Highlights

- Dashboard-first interface with no marketing landing screen
- Multiple accounts across OpenAI Codex, Claude, and Grok
- Remaining capacity, reset time, plan, and authentication state
- Automatic merging of duplicate connections for the same account
- Safe removal of Capacity Atlas-managed profiles only
- No fabricated account cards on a new machine
- Local Connector with a hosted static UI
- Provider credentials remain on the local machine
- OAuth waits expire after 15 minutes, and closing the setup dialog cancels the local child process

## Privacy and security

The hosted page is a static UI. The local Connector reads credentials from provider-owned stores and requests quota information directly from provider endpoints.

Capacity Atlas does **not** send access tokens, refresh tokens, cookies, or raw quota responses to the hosted UI or to a Capacity Atlas backend.

The Connector listens on `127.0.0.1:4174` and allows only the exact hosted Capacity Atlas origin or its own exact origin. Every API except health requires a per-launch capability token. The launcher passes that token in a URL fragment; the UI immediately removes it from browser history and keeps it only in tab-scoped session storage. Runtime metadata is stored locally with mode `0600` on POSIX systems and under the user-profile ACL on Windows, then removed when the Connector stops. Do not expose the Connector to a LAN or the public internet.

Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## Supported platforms

| Platform | Connector release | Source development |
| --- | --- | --- |
| macOS Apple Silicon | Yes | Yes |
| Windows x64 | Yes | Yes |
| Linux | Not yet packaged | Yes |

## Supported providers

| Provider | Authentication | Quota source |
| --- | --- | --- |
| OpenAI Codex | Browser OAuth | OpenAI usage endpoint |
| Claude | Browser OAuth through the official Claude helper | Claude usage endpoint |
| Grok | Browser OAuth through the official Grok helper | xAI billing endpoint |

Provider quota endpoints are not guaranteed stable third-party APIs. Provider-side changes may temporarily break collection.

## Run from source

Requirements: Node.js 20 or newer.

```bash
git clone https://github.com/meem0601/capacity-atlas.git
cd capacity-atlas
npm ci
npm run check
npm test
npm run build
npm start
```

`npm start` opens the local dashboard with a temporary capability automatically. The capability is never printed to standard output; the UI removes it from the URL immediately and keeps it only for that browser tab.

## Build release packages

Official Codex archives are downloaded from GitHub Releases and verified against pinned SHA-256 checksums before packaging. Provider executables are not committed to this repository.

```bash
npm run prepare:codex
npm run build:release
```

Output is written to `release/`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Bug reports and pull requests are welcome. Never include real credentials, local state, or account data in an issue or fixture.

## License

[MIT License](LICENSE). Third-party notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Capacity Atlas is an independent project and is not affiliated with, endorsed by, or sponsored by OpenAI, Anthropic, or xAI. Their names and marks belong to their respective owners.
