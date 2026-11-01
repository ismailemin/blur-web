"""Verify loopback level range routes against real local data and malformed queries."""
import json
import sys
import threading
from functools import partial
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import urlopen

ROOT=Path(__file__).resolve().parents[3]
sys.path.insert(0,str(ROOT/'tools'))
from serve_asset_probe import Handler,WEB

class QuietHandler(Handler):
    def log_message(self,*args):pass

server=ThreadingHTTPServer(('127.0.0.1',0),partial(QuietHandler,directory=str(WEB)))
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
base=f'http://127.0.0.1:{server.server_port}'
def read(route):
    with urlopen(base+route,timeout=5) as response:return response.read()
try:
    info=json.loads(read('/reference/level/info?level=usa_la_river'))
    render=ROOT/'game-data/Blur/levels/usa_la_river/level.levelrender'
    assert info['renderBytes']==render.stat().st_size
    with render.open('rb') as file:expected=file.read(64)
    assert read('/reference/level/range?level=usa_la_river&part=render&offset=0&bytes=64')==expected
    invalid=[
        '/reference/level/info?level=../usa_la_river',
        '/reference/level/info?level=usa_la_river&level=showroom',
        '/reference/level/range?level=usa_la_river&part=../cache/root.pak&offset=0&bytes=64',
        '/reference/level/range?level=usa_la_river&part=render&offset=-1&bytes=64',
        '/reference/level/range?level=usa_la_river&part=render&offset=0&bytes=67108865',
        f'/reference/level/range?level=usa_la_river&part=render&offset={info["renderBytes"]}&bytes=1',
        '/reference/level/range?level=usa_la_river&part=render&offset=0&offset=1&bytes=64',
    ]
    for route in invalid:
        try:read(route);raise AssertionError('Malformed range accepted')
        except HTTPError as error:assert error.code==400
    print('PASS: level metadata, exact real range bytes, seven malformed/path/bounds rejections')
finally:
    server.shutdown();server.server_close();thread.join()
