"""Static server for this folder that never caches, so an edit to app.js / sim.js shows up on reload.
    python3 serve.py [port]        then open http://localhost:8765"""
import http.server
import os
import socketserver
import sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8765


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *args):
        pass


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as s:
    print(f"http://localhost:{PORT}")
    s.serve_forever()
