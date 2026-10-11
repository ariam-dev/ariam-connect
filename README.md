# ariam connect

Firefox extension for desktop and Firefox for Android that hands downloads to one [ariam](https://github.com/ariam-dev/ariam) instance and shows its queue and per-site limits.

## Install

1. Install **ariam connect** from [AMO](https://addons.mozilla.org/).
2. Optional: to capture in private windows too, allow it there. Downloads from private windows then go to the instance like any other, with their cookies and referer.
   - Desktop: `about:addons` → ariam connect → **Run in Private Windows** → **Allow**.
   - Android: **Add-ons** → ariam connect → **Allow in private browsing**.

## Setup

Popup → gear → **Setup**:

| Field | Value |
|---|---|
| Instance URL | The instance's origin, no path: `https://<host>[:<port>]`, or `http://localhost[:<port>]` / `http://127.0.0.1[:<port>]` |
| RPC secret | The instance's `rpc-secret` |
| Passphrase, Passphrase again | One to three words separated by single spaces |

**Save** turns ariam connect off, stores the URL and the sealed secret, then calls `aria2.getVersion` on the instance. On success the form shows `Saved. ariam connect is off. aria2 <version> answered.`

To change the instance URL or RPC secret, run **Setup** again. The same page has:

- **Change passphrase:** current passphrase, then the new one twice → **Change**. A wrong current passphrase leaves it unchanged.
- **Reset:** erases the instance URL and the sealed secret and turns ariam connect off. If you forget the passphrase, use **Reset**, then **Setup**.

`storage.local` holds only `instanceUrl` and `vault`: the RPC secret under AES-GCM-256, keyed by PBKDF2-SHA256 (random salt; parameters in [`src/lib/vault.js`](./src/lib/vault.js)) from the passphrase. Turning on decrypts the secret into the background page's memory only; off drops it from memory once any hand-off already in flight finishes; the profile holds it only sealed.

## Use

Open the popup from the toolbar button (Android: Firefox's menu → ariam connect).

| State | Toolbar icon | Popup |
|---|---|---|
| Not set up | Grey ring | `Set up ariam connect in settings.` and the gear |
| Off | Grey ring | Passphrase field, **Turn on**, the gear |
| On | Orange disc | **Off**, the gear, and ariam's queue view |

- **Turn on:** passphrase → **Turn on**. A wrong passphrase shows `Wrong passphrase.` and leaves it off.
- **Turn off:** **Off**, or restart Firefox.
- **Queue view:** the [status page](https://github.com/ariam-dev/ariam#status-page)'s view and controls. Cancel asks first: **Cancel download** or **Keep** (Esc keeps). The popup reaches the instance only through the background page, which forwards only the status page's allowed methods.
- **Right-click** (desktop, while on): an `http:` / `https:` link → **Download with ariam**. It sends the link, the page's (or frame's) origin as `Referer:` (none when an `https:` page links to an `http:` URL) and as ariam's [site hint](#capture), and the cookies Firefox holds for the link in the tab's cookie store when the [hand-off rule](#capture) allows them. With first-party isolation on, it sends no cookies. A failed send shows a notification.

## Capture

While on, a response is a download when all of these hold:

- the request is a `GET` page or frame load (`main_frame` / `sub_frame`) to an `http:` / `https:` URL outside the instance's origin, and the response status is `200`;
- `Content-Disposition` is `attachment`, or `Content-Type` is `binary/octet-stream`, or `Content-Type` is `application/*` and not a type Firefox displays: any `+json` / `+xml` type, or one in `DISPLAYABLE_TYPES` in [`src/lib/detect.js`](./src/lib/detect.js).

**Hand-off.** Firefox holds the response and the extension calls `aria2.addUri` with the URL, a `header` option, and a `site-hint` option. `Referer:` is as Firefox sent it on the request, and absent when it sent none. `site-hint` is the origin of the page that started the download (`<scheme>://<host>[:port]/`; absent when that is not an `http:` / `https:` page), sent to any instance; stock aria2 ignores it. `Cookie:` follows the instance check (`ariam.getSiteSummary`) made at turn-on:

- instance confirmed as ariam → the hand-off carries `Cookie:`;
- instance is not ariam (stock aria2: method not found) → it carries no cookies;
- check inconclusive (unreachable, timeout, `Unauthorized`, HTTP error) → nothing is sent, Firefox downloads normally with a notification of the error, and the next hand-off checks again.

No filename or directory is sent; ariam names the file and derives the site ([site rule](https://github.com/ariam-dev/ariam#per-site-concurrency)).

- ariam accepts → Firefox cancels its download. A tab opened only for the download closes.
- ariam rejects it, is unreachable, or doesn't answer within 10 s → Firefox downloads normally and a notification shows `ariam connect: <error>`. After a timeout it adds `ariam may have queued it too`.

RPC goes to `<instance URL>/jsonrpc` with `token:<secret>`; a redirect fails the call.

**Not captured** (Firefox downloads normally):

- downloads with no network response (`blob:`, `data:`);
- requests sent before ariam connect turned on;
- requests carrying `Authorization` (HTTP authentication);
- a PDF without `attachment`: right-click sends those on desktop.

**Limitations:**

- Firefox's own download checks (Safe Browsing, blocking insecure downloads from secure pages, blocking downloads from sandboxed frames) run after the hand-off, so they don't apply to downloads sent to ariam;
- a tab showing a local (`file:`) or other non-web document can close after a capture started from it, since it isn't seen as holding a page;
- right-click sends the page's origin as `Referer:` even where the page's referrer policy withholds it (the menus API doesn't expose that policy);
- right-click inside a third-party frame sends no partitioned cookies (Firefox's cookie partitioning);
- right-click on a link that redirects to another origin (`http` → `https` included) sends that origin no cookies ([ariam sends cookies only to the origin it was given](https://github.com/ariam-dev/ariam#changes-from-aria2)), so a server that needs them returns its sign-in page, saved as the file. Click the link instead when it is a download capture takes (capture hands off the final URL); a right-click-only download (a PDF without `attachment`) behind such a redirect goes through Firefox.

**Not supported:** single-use download URLs. ariam's request fails, and Firefox's download is already cancelled. Turn ariam connect off and download in Firefox.

## Development

From this folder: `npm ci --ignore-scripts`.

| Script | Does |
|---|---|
| `npm run vendor` | Refreshes `src/vendor/queue-view.js` and `style.css` from ariam's [`www/`](https://github.com/ariam-dev/ariam/tree/main/www) at commit `ARIAM_COMMIT`: `ARIAM_COMMIT=<commit> npm run vendor`. The vendored files are committed copies; change them in ariam. |
| `npm run lint` | `web-ext lint` on `src/` |
| `npm run start` | Desktop Firefox with the extension loaded, in a temporary profile |
| `npm run start:android` | Firefox for Android (`org.mozilla.firefox`) on the device `ADB_DEVICE` over `adb` |
| `npm test` | Unit tests in [`test/`](./test/) (`node --test`) |
| `npm run build` | Unsigned package in `web-ext-artifacts/` |
| `npm run sign` | [Release](#release) |

**Android prerequisites:** USB debugging on the phone, Firefox → Settings → **Remote debugging via USB** on, `adb` on the workstation. Then:

```
adb devices
ADB_DEVICE=<serial> npm run start:android
```

**Page check.** Extension pages have no inline script or `eval`, and server strings reach the DOM only through `textContent` or attribute setters. This should print nothing: `rg -n '\son[a-z]+\s*=|eval\(|new Function|innerHTML|insertAdjacentHTML|outerHTML|document\.write' src`

## Release

1. Bump `version` in [`src/manifest.json`](./src/manifest.json). AMO never accepts a version string twice.
2. `npm run sign`. It needs the AMO API credentials `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` from a git-ignored `.env` file. It submits `src/` to AMO as a listed version with [`amo-metadata.json`](./amo-metadata.json).
3. Once AMO approves the version, installed copies update automatically. The update applies once ariam connect is off and no hand-off or settings change is in flight: at once if it already is, otherwise after **Off** or at the next Firefox restart.

If the AMO listing shows no icon, upload [`ariam-128.png`](./ariam-128.png) on the listing.

## Files

- [`src/manifest.json`](./src/manifest.json) — Manifest V2: id, Firefox minimums, data collection, permissions.
- [`src/background.html`](./src/background.html), [`src/background.js`](./src/background.js) — on/off state, credential handlers, capture, right-click entry, popup relay.
- [`src/popup.html`](./src/popup.html), [`src/popup.js`](./src/popup.js), [`src/popup.css`](./src/popup.css) — the popup and its queue-view transport.
- [`src/options.html`](./src/options.html), [`src/options.js`](./src/options.js), [`src/options.css`](./src/options.css) — settings.
- [`src/lib/vault.js`](./src/lib/vault.js) — the RPC secret sealed under the passphrase.
- [`src/lib/rpc.js`](./src/lib/rpc.js) — JSON-RPC client and instance URL check.
- [`src/lib/detect.js`](./src/lib/detect.js) — download detection.
- [`src/lib/hand-off.js`](./src/lib/hand-off.js) — `aria2.addUri` hand-off, the instance check that decides whether cookies go with it, and the page-origin and right-click `Referer:` / site-hint helpers.
- [`src/lib/update-gate.js`](./src/lib/update-gate.js) — holds an AMO update until ariam connect is off and idle.
- [`src/lib/relay.js`](./src/lib/relay.js) — the methods the popup may call.
- [`src/lib/fresh-tabs.js`](./src/lib/fresh-tabs.js) — tabs opened only for a download.
- [`src/icons/`](./src/icons/) — `on.svg`, `off.svg`, and `ariam.svg` (add-on icon).
- [`src/vendor/`](./src/vendor/) — `queue-view.js` and `style.css`, copied unmodified from ariam's status page.
- [`test/`](./test/) — unit tests for `src/lib/`.
- [`amo-metadata.json`](./amo-metadata.json) — AMO listing and version metadata for `npm run sign`.
- [`ariam-128.png`](./ariam-128.png) — AMO listing icon, rendered from `ariam.svg`; not in the package.
- [`package.json`](./package.json), [`package-lock.json`](./package-lock.json) — scripts and the `web-ext` dev dependency.
- [`LICENSE`](./LICENSE) — MIT; [`src/LICENSE`](./src/LICENSE) is the same text, so the package carries it.
