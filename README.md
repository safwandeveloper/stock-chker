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

On startup the server prints something like:

```
============================================================
 stock-chker is running
============================================================
 On this PC:    http://127.0.0.1:8765/
 On your phone: http://192.168.1.42:8765/
   (phone must be on the same WiFi as this PC)
============================================================
```

Your default browser opens the PC URL automatically. To use it on your **phone**, just type the printed `http://192.168.x.y:8765/` URL into your phone's browser (same WiFi network). The PC must stay on — it's the one running the server.

> **Per-device list:** the link list is stored in each browser's `localStorage`, so the phone and the PC each have their own copy. (Server-side shared state + true 24/7 server-side polling can be added in a follow-up — open an issue if you want it.)

To stop the server, press `Ctrl+C` in the terminal.

### CLI options

| Flag           | Effect                                                         |
| -------------- | -------------------------------------------------------------- |
| `--port N`     | Listen on port `N` instead of `8765`.                          |
| `--local-only` | Bind to `127.0.0.1` only — phones on your WiFi can't reach it. |
| `--no-browser` | Don't auto-open a browser tab on startup.                      |

### Why a local server (instead of just opening `index.html`)?

Browsers block plain `file://` pages from making cross-origin requests to `one.google.com` (CORS). The tiny Python server proxies those checks for you, fully on your own machine — nothing leaves your computer except the requests you'd be making anyway by clicking the links yourself.

### Security note

By default the server binds to `0.0.0.0` so your phone (and any other device on the same WiFi) can reach it. **Anyone on your local WiFi can open the URL too** — it's a personal tool meant for trusted home networks. If you're on untrusted WiFi (cafe, airport) and don't want others to see your link list, run with `--local-only`.

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
