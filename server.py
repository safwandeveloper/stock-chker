"""Local-only stock checker server (Python stdlib, no pip install).

Run:
    python3 server.py
Then open http://localhost:8765 in your browser.
"""
from __future__ import annotations

import json
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

PORT = 8765
HOST = "127.0.0.1"
TIMEOUT = 20  # seconds for the upstream check
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)
ACTIVATE_PATH_MARKER = "/activate-plan/subscription/new/"
ROOT = Path(__file__).resolve().parent


def classify(final_url: str, status_code: int) -> tuple[str, str]:
    """Return (status, message) for a given final URL + HTTP status code.

    status is one of: "live", "dead", "unknown".
    """
    if status_code >= 500:
        return "unknown", f"Server error {status_code} (try again)"
    if status_code == 404:
        return "dead", "404 Not Found - link no longer exists"
    if status_code >= 400:
        return "dead", f"HTTP {status_code}"

    lowered = final_url.lower()
    if ACTIVATE_PATH_MARKER in lowered:
        return "live", "Activation page still reachable"
    if "one.google.com" in lowered and "/about" in lowered:
        return "dead", "Redirected to Google One landing - already redeemed"
    if "myaccount.google.com" in lowered or "accounts.google.com" in lowered:
        return "live", "Login wall (offer still claimable)"
    return "dead", f"Redirected away: {final_url}"


def check_url(url: str) -> dict:
    """Open the given URL, follow redirects, return a JSON-friendly result."""
    if not url.lower().startswith(("http://", "https://")):
        return {
            "status": "dead",
            "message": "Not a valid http(s) URL",
            "final_url": url,
            "status_code": 0,
        }

    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": (
                "text/html,application/xhtml+xml,application/xml;q=0.9,"
                "image/avif,image/webp,*/*;q=0.8"
            ),
            "Accept-Language": "en-US,en;q=0.9",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            final_url = resp.geturl()
            status_code = resp.status
            try:
                resp.read(1024)  # discard body, just in case
            except Exception:
                pass
            status, msg = classify(final_url, status_code)
            return {
                "status": status,
                "message": msg,
                "final_url": final_url,
                "status_code": status_code,
            }
    except urllib.error.HTTPError as e:
        final_url = getattr(e, "url", url) or url
        status, msg = classify(final_url, e.code)
        return {
            "status": status,
            "message": msg,
            "final_url": final_url,
            "status_code": e.code,
        }
    except urllib.error.URLError as e:
        return {
            "status": "unknown",
            "message": f"Network error: {e.reason}",
            "final_url": url,
            "status_code": 0,
        }
    except socket.timeout:
        return {
            "status": "unknown",
            "message": "Timed out",
            "final_url": url,
            "status_code": 0,
        }
    except Exception as e:  # pragma: no cover - defensive
        return {
            "status": "unknown",
            "message": f"Unexpected error: {e}",
            "final_url": url,
            "status_code": 0,
        }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format, *args):
        # Quieter logs - one line per request without pyramid of escape codes.
        sys.stderr.write(
            "[%s] %s\n" % (self.log_date_time_string(), format % args)
        )

    def _send_json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802 (stdlib API)
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/check":
            params = urllib.parse.parse_qs(parsed.query)
            target = (params.get("url") or [""])[0]
            if not target:
                self._send_json(400, {"error": "missing 'url' query parameter"})
                return
            result = check_url(target)
            self._send_json(200, result)
            return
        if parsed.path == "/api/health":
            self._send_json(200, {"ok": True})
            return
        if parsed.path in ("/", ""):
            self.path = "/index.html"
        return super().do_GET()


def main() -> None:
    server = HTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}/"
    print(f"stock-chker running at {url}")
    print("Press Ctrl+C to stop.")
    try:
        webbrowser.open(url)
    except Exception:
        pass
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
