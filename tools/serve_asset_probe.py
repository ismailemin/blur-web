"""Loopback-only probe server. Exposes web files and a bounded boot.pak prefix."""
from __future__ import annotations

import argparse
import json
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / 'probes/asset-reader/web'
CACHE = ROOT / 'game-data/Blur/cache'
PACKAGES = {'boot.pak', 'root.pak', 'gamedata.pak', 'gamedata_boot.pak', 'lut_rampak.pak', 'root_streaming.pak', 'shaders-speed.pak'}
LEVELS = {'usa_la_river', 'showroom', 'spa_barcelona_bowl_multiplayer'}
LIMIT = 64 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def send_bytes(self, data: bytes, kind: str) -> None:
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        url = urlsplit(self.path)
        if url.path.startswith('/reference/level/'):
            try:
                query = parse_qs(url.query, strict_parsing=True)
                if any(len(value) != 1 for value in query.values()) or query.get('level', [''])[0] not in LEVELS:
                    raise ValueError()
                folder = ROOT / 'game-data/Blur/levels' / query['level'][0]
                if url.path == '/reference/level/info':
                    if set(query) != {'level'}:
                        raise ValueError()
                    render, stream = folder / 'level.levelrender', folder / 'level.levelstream'
                    self.send_bytes(json.dumps({'name': query['level'][0], 'renderBytes': render.stat().st_size, 'streamBytes': stream.stat().st_size}).encode(), 'application/json')
                    return
                if url.path != '/reference/level/range' or set(query) != {'level', 'part', 'offset', 'bytes'}:
                    raise ValueError()
                part = query['part'][0]
                if part not in {'render', 'stream'}:
                    raise ValueError()
                source = folder / ('level.levelrender' if part == 'render' else 'level.levelstream')
                offset, length = int(query['offset'][0]), int(query['bytes'][0])
                if offset < 0 or not 1 <= length <= LIMIT or offset + length > source.stat().st_size:
                    raise ValueError()
                with source.open('rb') as file:
                    file.seek(offset)
                    self.send_bytes(file.read(length), 'application/octet-stream')
                return
            except (ValueError, KeyError):
                self.send_error(400, 'Invalid level reference range')
            except OSError:
                self.send_error(404, 'Local reference level not installed')
            return
        if url.path.startswith('/reference/'):
            query = parse_qs(url.query)
            names = query.get('pak', ['boot.pak'])
            if len(names) != 1 or names[0] not in PACKAGES:
                self.send_error(400, 'Unknown reference package')
                return
            reference = CACHE / names[0]
            if not reference.is_file():
                self.send_error(404, 'Local reference not installed')
                return
            if url.path == '/reference/info':
                self.send_bytes(json.dumps({'name': reference.name, 'size': reference.stat().st_size}).encode(), 'application/json')
                return
            if url.path in {'/reference/prefix', '/reference/range'}:
                try:
                    values = parse_qs(url.query, strict_parsing=True)
                    allowed = {'bytes', 'pak'} if url.path.endswith('/prefix') else {'bytes', 'pak', 'offset'}
                    if not set(values) <= allowed or len(values['bytes']) != 1:
                        raise ValueError()
                    length = int(values['bytes'][0])
                    offset = int(values.get('offset', ['0'])[0])
                    if len(values.get('offset', ['0'])) != 1 or offset < 0 or not 1 <= length <= LIMIT or offset + length > reference.stat().st_size:
                        raise ValueError()
                except (ValueError, KeyError):
                    self.send_error(400, 'Invalid prefix length')
                    return
                with reference.open('rb') as source:
                    source.seek(offset)
                    self.send_bytes(source.read(length), 'application/octet-stream')
                return
            self.send_error(404)
            return
        # Static serving is confined to web/. Block symlinks resolving elsewhere.
        target = Path(self.translate_path(url.path)).resolve()
        if not target.is_relative_to(WEB.resolve()):
            self.send_error(403)
            return
        super().do_GET()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(WEB)))
    print(f'Blur asset probe: http://127.0.0.1:{args.port}/', flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main()
