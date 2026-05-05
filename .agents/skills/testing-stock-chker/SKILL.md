---
name: testing-stock-chker
description: Run and end-to-end test the stock-chker local web app (Python stdlib server + static index.html/app.js for managing Gemini-style activation links). Use whenever changes touch server.py, index.html, app.js, or the stock-check classifier.
---

# Testing stock-chker

stock-chker is a personal, local-only web app:
- `server.py` — Python stdlib HTTP server. Default bind `0.0.0.0:8765`, with flags `--port N`, `--local-only`, `--no-browser`.
- `index.html` + `app.js` — static UI, persists state in `localStorage` under key `stockchker:v1`.
- `/api/check?url=…` — proxy that GETs the URL with redirects and classifies live/dead/unknown.
- `/api/health` — simple liveness probe used by the header badge.

## How to run locally

```bash
cd /home/ubuntu/stock-chker  # or wherever the repo was cloned
python3 server.py --no-browser     # use --no-browser when scripting
# or just:
python3 server.py                  # auto-opens http://127.0.0.1:8765/
```

Server prints both the loopback URL and the LAN URL (e.g. `http://192.168.x.y:8765/`) on startup. To get just the LAN IP from a script:

```bash
python3 -c "import sys; sys.path.insert(0,'<repo>'); import server; print((server.discover_lan_ips() or ['none'])[0])"
```

## Devin Secrets Needed

None. The app makes outbound HTTPS to whatever URL the user pastes (typically `https://one.google.com/...`). No auth, no API keys.

## Key UI selectors / labels (for browser-driven tests)

- `#pasteBox` — textarea for raw text
- `#parsePreview` — small label that reflects extraction/add results
- `#btnAdd` ("Clean & Add") / `#btnAddClear` ("Clean, Add & Clear Box")
- `#btnCheckAll` ("Check all now") / `#btnToggleAuto` (toggles between "Start auto-check" and "Stop auto-check")
- `#btnDownloadLive` / `#btnDownloadAll` / `#btnRemoveDead` / `#btnClearAll`
- Stats card with classes `.stat .n` (count) / `.stat .l` (label)
- Filter pills `.filter` with `data-filter="all|live|dead|unknown|pending|checking"`
- Status badges: `.badge.live`, `.badge.dead`, `.badge.unknown`, `.badge.pending`, `.badge.checking`
- Header badges: `#serverStatus` (`server ok` when health is up), `#autocheckStatus`

## Behaviors worth knowing (so tests can be adversarial)

1. **URL extraction** — `app.js`:`URL_REGEX = /https?:\/\/[^\s<>"'`\\]+/gi`. Anything that isn't an http(s) URL is silently dropped. Trailing `)],.;!?>` are stripped.
2. **Dedupe** — strict string equality on `link.url`. A trailing `=` or whitespace difference defeats it; if the user complains about "duplicates not detected", check whether the strings are exactly equal first.
3. **`Download live` vs `Download all`** — both join URLs with `"\n\n\n"` and append a final `"\n"`. So between two URLs you get exactly URL, blank, blank, URL.
4. **Filename pattern** — `stock-chker-(live|all)-YYYYMMDD-HHMM.txt` (local timezone).
5. **Auto-check** — JS-side polling, default interval 120s, concurrency 4, only runs while a tab is open (this app has NO server-side polling thread).
6. **Persistence** — `localStorage` only, per-browser. Phone and PC do NOT share state.

## Classifier rules in `server.py:classify`

In order:
- HTTP `>= 500` → `unknown`.
- HTTP `404` → `dead` ("404 Not Found - link no longer exists").
- Other HTTP `>= 400` → `dead`.
- Final URL contains `/activate-plan/subscription/new/` → `live` ("Activation page still reachable").
- Final URL contains `one.google.com` AND `/about` → `dead` ("Redirected to Google One landing - already redeemed").
- Final URL contains `accounts.google.com` or `myaccount.google.com` → `live` ("Login wall (offer still claimable)").
- Anything else → `dead` ("Redirected away: …").

### Important limitation

Without being logged into the user's Google account, the proxy can't tell "already redeemed" from "still claimable" when both produce the same `accounts.google.com` login wall. So `live` here really means "URL is structurally valid and not 404'd". If someone provides a known-redeemed sample, the classifier may need to be tuned — first add a curl call to inspect the actual final URL before changing code.

## Quick smoke-tests (no UI required)

```bash
curl -s http://127.0.0.1:8765/api/health           # {"ok": true}
curl -s 'http://127.0.0.1:8765/api/check?url=https://httpbin.org/status/404' | grep -q '"status": "dead"'
curl -s 'http://127.0.0.1:8765/api/check?url=https://one.google.com/activate-plan/subscription/new/AQ...' | grep -q '"status": "live"'
```

## End-to-end browser test recipe (worked in past sessions)

1. `python3 server.py --no-browser` in a backgrounded shell.
2. Open `http://127.0.0.1:8765/` in Chrome (already running on the box; do NOT relaunch).
3. To paste multi-line text without typing it character-by-character, use the system clipboard:
   ```bash
   apt-get install -y xclip               # if missing
   xclip -selection clipboard -i /tmp/blob.txt
   ```
   Then in the browser: click `#pasteBox`, send `ctrl+v` via the `computer` tool's `key` action.
4. Click buttons by coordinates from a screenshot, NOT by id (the DOM is fine to read but the `computer` tool clicks at pixel coords).
5. Verify download files in `~/Downloads/`. Use `xxd` to check the exact byte separators (`0a 0a 0a` between URLs).
6. Do NOT use the devtools console for actions during a recording — it confuses the viewer. Click the actual buttons.

## Common gotchas

- The `computer` tool's `console` action sometimes refuses with "Chrome is not in the foreground" even when Chrome IS active. If it does, just click somewhere on the page and proceed via UI clicks instead of `console`.
- `pip install` is NOT needed — everything is stdlib. Don't add a `requirements.txt`.
- Don't run two `server.py` instances at the same time — the second one will fail with `OSError: [Errno 98] Address already in use`. Kill the first or use `--port`.
- Pre-commit hooks: there are none in this repo (no `.pre-commit-config.yaml`, no `.husky/`). No git hooks to set up.
- CI: there are no CI workflows. `git pr_checks` returns 0/0/0/0 — that's normal, not a failure.

## Known follow-ups (open work)

- Server-side shared state + true 24/7 polling thread (so phone+PC see the same list and checks run even with no tab open).
- Tunable classifier from a config file or admin endpoint.
- Push notifications when a link flips from `live` to `dead` (browser Notification API + permission prompt).
