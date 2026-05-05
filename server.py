"""stock-chker local server (Python stdlib, no pip install).

Run:
    python3 server.py             # PC + phones on same WiFi can reach it
    python3 server.py --local-only  # PC only (loopback)
    python3 server.py --port 9000

The server prints the URL(s) to use - including a LAN URL like
http://192.168.x.y:8765 so you can open it from your phone's browser.
"""
from __future__ import annotations

import argparse
import ipaddress
import json
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path

DEFAULT_PORT = 8765
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


def discover_lan_ips() -> list[str]:
    """Best-effort enumeration of this machine's LAN IPv4 addresses."""
    ips: list[str] = []

    # Trick: open a UDP socket to a public address (no packets actually sent)
    # and read back the source IP the OS picked. This is the most reliable
    # way to get "the IP your router sees you as".
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ip = s.getsockname()[0]
            if ip and ip not in ips:
                ips.append(ip)
        finally:
            s.close()
    except OSError:
        pass

    # Fallback: hostname lookup.
    try:
        host = socket.gethostname()
        for info in socket.getaddrinfo(host, None, family=socket.AF_INET):
            ip = info[4][0]
            if ip and ip not in ips:
                ips.append(ip)
    except socket.gaierror:
        pass

    # Filter to private/LAN ranges and skip loopback (we already print it).
    out: list[str] = []
    for ip in ips:
        try:
            addr = ipaddress.ip_address(ip)
        except ValueError:
            continue
        if addr.is_loopback:
            continue
        if addr.is_private or addr.is_link_local:
            out.append(ip)
    return out


def parse_args(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="stock-chker local server (Python stdlib only).",
    )
    p.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"Port to listen on (default: {DEFAULT_PORT}).",
    )
    p.add_argument(
        "--local-only",
        action="store_true",
        help="Bind to 127.0.0.1 only. Default binds to 0.0.0.0 so devices on "
             "your WiFi (e.g. your phone) can reach it.",
    )
    p.add_argument(
        "--no-browser",
        action="store_true",
        help="Do not auto-open the default browser.",
    )
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    bind = "127.0.0.1" if args.local_only else "0.0.0.0"
    port = args.port

    server = HTTPServer((bind, port), Handler)

    print("=" * 60)
    print(" stock-chker is running")
    print("=" * 60)
    print(f" On this PC:    http://127.0.0.1:{port}/")
    if not args.local_only:
        for ip in discover_lan_ips():
            print(f" On your phone: http://{ip}:{port}/")
        print("   (phone must be on the same WiFi as this PC)")
    print("=" * 60)
    print(" Press Ctrl+C to stop.")

    if not args.no_browser:
        try:
            webbrowser.open(f"http://127.0.0.1:{port}/")
        except Exception:
            pass

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()


if __name__ == "__main__":
    main()
