# stock-chker

Tiny **personal**, **local-only** web app for managing and 24/7 checking Gemini-style activation links.

> Runs entirely on your own PC — no domain, no hosting, no third-party server, no `pip install`. Pure Python stdlib + a single `index.html`.

## Features

- **Paste box** — drop in any blob of text (usernames, timestamps, anything). Only `http(s)://` links are kept; lines like `gemini 18m 0.6$, [May 5, 2026 at 10:53 AM]` are auto-stripped.
- **Duplicate check** — already-in-list URLs are skipped on add.
- **24/7 stock check** — while the page is open, every link is polled in the background. Each link shows:
  - 🟢 **live** — Google One activation page is still reachable (offer claimable).
  - 🔴 **dead** — redirected away / 404 / explicit "redeemed" path (offer gone).
  - 🟡 **unknown** — network/timeout, will retry next cycle.
- **One-click .txt export** — download all live links (or all links) as a clean text file with 2 blank lines between each URL.
- **Persistence** — your list is saved in `localStorage`, so reloading the tab keeps everything.
- **Filters** — show only live / dead / unknown / pending.

## Run it

You need Python 3.8+ (already installed on most systems).

```bash
git clone https://github.com/safwandeveloper/stock-chker.git
cd stock-chker
python3 server.py
```

Your default browser will open at <http://localhost:8765>. If it doesn't, open that URL manually.

To stop the server, press `Ctrl+C` in the terminal.

### Why a local server (instead of just opening `index.html`)?

Browsers block plain `file://` pages from making cross-origin requests to `one.google.com` (CORS). The tiny Python server proxies those checks for you, fully on your own machine — nothing leaves your computer except the requests you'd be making anyway by clicking the links yourself.

## Folder layout

| File         | Purpose                                                                |
| ------------ | ---------------------------------------------------------------------- |
| `server.py`  | Local-only HTTP server: serves `index.html` + `/api/check?url=…`.      |
| `index.html` | UI — paste box, link list, filters, controls.                          |
| `app.js`     | All client logic (parser, dedupe, checker, downloader, persistence).   |
| `README.md`  | This file.                                                             |

No build step. No dependencies. No tracking.

## Stock-check logic

`/api/check?url=…` performs a `GET` with redirect-following and a real-browser `User-Agent`. It then classifies:

| Final URL contains                                  | Status   |
| --------------------------------------------------- | -------- |
| `/activate-plan/subscription/new/`                  | `live`   |
| `accounts.google.com` / `myaccount.google.com`      | `live`   |
| `one.google.com` + `/about` (landing)               | `dead`   |
| HTTP 404                                            | `dead`   |
| Other 4xx                                           | `dead`   |
| 5xx / timeout / network error                       | `unknown` |

If your real activation links produce different patterns (e.g. an "already redeemed" page on a different host), tell me and I'll tune `classify()` in `server.py`.

## Privacy

This app makes outbound HTTPS requests **only** to the URLs you paste in. No analytics, no telemetry. The server only listens on `127.0.0.1` (loopback), so other machines on your network cannot reach it.
