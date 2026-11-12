"""Static server for the meta map: like `python3 -m http.server`, but browsers always revalidate,
so regenerated data and edited scripts show up on a plain reload."""
import functools, http.server, os, sys

class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8793
handler = functools.partial(Handler, directory=os.path.dirname(os.path.abspath(__file__)))
http.server.ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
