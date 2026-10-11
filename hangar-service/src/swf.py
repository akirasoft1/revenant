"""Wireframe bundle (.swf.gz) validation.

Format: gzip of ``b"SWF1"`` + uint32 LE header length + header JSON (UTF-8) +
int16 LE x ``lines * 6``. The server never renders the lines; it validates the
envelope, reads the node list for slot matching and stores the bytes verbatim.
"""
import json
import re
import struct
import zlib
from dataclasses import dataclass

MAGIC = b"SWF1"
MAX_UPLOAD = 2 * 1024 * 1024
MAX_DECOMPRESSED = 8 * 1024 * 1024
MAX_LINES = 80_000
MAX_NODES = 5_000
CLASS_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
_REQUIRED = ("format", "kind", "className", "sourceName", "space", "center", "halfExtent",
             "lines", "nodes", "build")


class SwfError(ValueError):
    """The bundle is malformed; the message names the problem."""


@dataclass(frozen=True)
class Bundle:
    header: dict
    lines: int
    nodes: list[dict]
    build: dict


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _inflate(data: bytes) -> bytes:
    d = zlib.decompressobj(wbits=31)
    try:
        out = d.decompress(data, MAX_DECOMPRESSED + 1)
    except zlib.error as e:
        raise SwfError(f"not a valid gzip stream: {e}") from None
    if len(out) > MAX_DECOMPRESSED:
        raise SwfError(f"decompressed size is over the {MAX_DECOMPRESSED // (1024 * 1024)} MB limit")
    if not d.eof:
        raise SwfError("not a valid gzip stream: truncated")
    return out


def parse(data: bytes) -> Bundle:
    raw = _inflate(data)
    if raw[:4] != MAGIC:
        raise SwfError("bad magic: expected SWF1")
    if len(raw) < 8:
        raise SwfError("truncated header")
    (hlen,) = struct.unpack_from("<I", raw, 4)
    if 8 + hlen > len(raw):
        raise SwfError("header length runs past the end of the bundle")
    try:
        header = json.loads(raw[8:8 + hlen].decode("utf-8"))
    except (ValueError, RecursionError):
        raise SwfError("header is not valid JSON") from None
    if not isinstance(header, dict):
        raise SwfError("header must be a JSON object")
    missing = [k for k in _REQUIRED if k not in header]
    if missing:
        raise SwfError(f"header is missing keys: {', '.join(missing)}")
    if header["kind"] != "vehicle":
        raise SwfError(f"kind must be 'vehicle', got {header['kind']!r}")
    cn = header["className"]
    if not isinstance(cn, str) or not CLASS_NAME_RE.fullmatch(cn):
        raise SwfError("className must match [A-Za-z0-9][A-Za-z0-9_.-]{0,127}")
    c = header["center"]
    if not (isinstance(c, list) and len(c) == 3 and all(_num(x) for x in c)):
        raise SwfError("center must be three numbers")
    if not _num(header["halfExtent"]) or header["halfExtent"] <= 0:
        raise SwfError("halfExtent must be a positive number")
    lines = header["lines"]
    if not isinstance(lines, int) or isinstance(lines, bool) or lines < 0:
        raise SwfError("lines must be a non-negative integer")
    if lines > MAX_LINES:
        raise SwfError(f"lines is over the {MAX_LINES} limit")
    nodes = header["nodes"]
    if not isinstance(nodes, list):
        raise SwfError("nodes must be a list")
    if len(nodes) > MAX_NODES:
        raise SwfError(f"nodes is over the {MAX_NODES} limit")
    for n in nodes:
        ok = (isinstance(n, dict) and isinstance(n.get("name"), str)
              and isinstance(n.get("parent"), int) and not isinstance(n.get("parent"), bool)
              and -1 <= n["parent"] < len(nodes)
              and isinstance(n.get("pos"), list) and len(n["pos"]) == 3 and all(_num(x) for x in n["pos"]))
        if not ok:
            raise SwfError("nodes entries must be {name: str, parent: index or -1, pos: [x, y, z]}")
    if len(raw) - 8 - hlen != lines * 12:
        raise SwfError(f"payload is {len(raw) - 8 - hlen} bytes but lines={lines} needs {lines * 12}")
    build = header["build"] if isinstance(header["build"], dict) else {}
    return Bundle(header=header, lines=lines, nodes=nodes, build=build)
