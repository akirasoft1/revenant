"""Command line: ``build``, ``build-all``, ``inspect``.

This module must not import numpy at import time. ``build-all`` runs one
process per ship, and each one has to see ``OMP_NUM_THREADS`` /
``OPENBLAS_NUM_THREADS`` / ``MKL_NUM_THREADS`` = 1 BEFORE numpy loads, so that
``--jobs N`` means N cores and not N x (BLAS threads).
"""
from __future__ import annotations

import argparse
import contextlib
import json
import multiprocessing
import multiprocessing.connection
import os
import sys
import time
import traceback
from pathlib import Path

from . import __version__

THREAD_VARS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")
DEFAULT_JOBS = 8
DEFAULT_OUT = Path(__file__).resolve().parent / "out"       # git- and docker-ignored
SERVER_MAX_LINES = 80_000


def pin_threads() -> None:
    for var in THREAD_VARS:
        os.environ[var] = "1"


@contextlib.contextmanager
def _pinned_environment():
    """Thread variables = 1 while a build runs or workers are being started (a
    spawned process inherits the environment as it is at that moment), restored
    afterwards."""
    saved = {var: os.environ.get(var) for var in THREAD_VARS}
    pin_threads()
    try:
        yield
    finally:
        for var, value in saved.items():
            if value is None:
                os.environ.pop(var, None)
            else:
                os.environ[var] = value


# ---- one process per task --------------------------------------------------------

def _child(conn, target, task) -> None:
    pin_threads()                       # already inherited; repeated so it cannot be lost
    try:
        payload = (True, target(task))
    except Exception as e:              # noqa: BLE001 - report every failure to the parent
        text = str(e) if getattr(e, "user_facing", False) else f"{type(e).__name__}: {e}"
        if not getattr(e, "user_facing", False):
            traceback.print_exc()
        payload = (False, text)
    try:
        conn.send(payload)
    finally:
        conn.close()


def run_jobs(tasks, jobs: int, target) -> list[tuple[bool, object]]:
    """Run ``target(task)`` for every task, each in its own fresh process, at
    most ``jobs`` at a time. Returns ``(ok, result-or-error-text)`` in task
    order. One task failing — even its process dying — never stops the rest."""
    tasks = list(tasks)
    jobs = max(1, int(jobs))
    ctx = multiprocessing.get_context("spawn")      # fresh interpreter: numpy not loaded yet
    results: list = [None] * len(tasks)
    running: dict = {}                              # sentinel -> (index, process, connection)
    pending = list(range(len(tasks)))[::-1]
    try:
        with _pinned_environment():
            while pending or running:
                while pending and len(running) < jobs:
                    i = pending.pop()
                    recv, send = ctx.Pipe(duplex=False)
                    proc = ctx.Process(target=_child, args=(send, target, tasks[i]))
                    proc.start()
                    send.close()
                    running[proc.sentinel] = (i, proc, recv)
                for sentinel in multiprocessing.connection.wait(list(running)):
                    i, proc, recv = running.pop(sentinel)
                    proc.join()
                    try:
                        results[i] = recv.recv() if recv.poll() else (
                            False, f"worker process exited with code {proc.exitcode}")
                    except (EOFError, OSError) as e:
                        results[i] = (False, f"worker process failed ({e}); "
                                             f"exit code {proc.exitcode}")
                    finally:
                        recv.close()
    finally:
        for _i, proc, recv in running.values():     # interrupted: do not leave orphans
            proc.terminate()
            proc.join()
            recv.close()
    return results


# ---- commands ----------------------------------------------------------------------

def _options(args):
    from .pipeline import Options
    return Options(crease_deg=args.crease_deg, min_edge_frac=args.min_edge_frac,
                   max_lines=args.max_lines, visibility=not args.no_visibility,
                   depth_res=args.depth_res, kind=args.kind, class_name=args.class_name)


def _build_one(task) -> dict:
    """Worker body (also used in-process by ``build``). Numpy loads here."""
    src, out_dir, option_values = task
    from .bundle import BundleError
    from .glb import GlbError
    from .pipeline import BuildError, Options, build_bundle
    try:
        return build_bundle(src, out_dir, Options(**option_values))
    except (GlbError, BuildError, BundleError, ValueError, MemoryError, OSError) as e:
        raise _UserError(str(e) or type(e).__name__) from e


class _UserError(Exception):
    user_facing = True


def _summary(r: dict) -> str:
    return (f"{r['className']}: lines={r['lines']} bytes={r['bytes']} "
            f"hardpoints={r['hardpoints']} seconds={r['seconds']:.1f} "
            f"(edges {r['edgeSeconds']:.1f}s, visibility {r['visibilitySeconds']:.1f}s; "
            f"{r['featureEdges']} feature edges, {r['visibleEdges']} visible; {r['path']})")


def cmd_build(args) -> int:
    src = Path(args.file)
    from dataclasses import asdict
    try:
        with _pinned_environment():     # restored afterwards: main() may be called in-process
            result = _build_one((str(src), str(args.out), asdict(_options(args))))
    except _UserError as e:
        print(f"error: {src.name}: {e}", file=sys.stderr)
        return 1
    for warning in result["warnings"]:
        print(f"warning: {src.name}: {warning}", file=sys.stderr)
    print(_summary(result))
    return 0


def _table(rows: list[list[str]]) -> str:
    widths = [max(len(r[c]) for r in rows) for c in range(len(rows[0]))]
    lines = []
    for n, r in enumerate(rows):
        lines.append("  ".join(cell.ljust(widths[c]) for c, cell in enumerate(r)).rstrip())
        if n == 0:
            lines.append("  ".join("-" * w for w in widths))
    return "\n".join(lines)


def cmd_build_all(args) -> int:
    folder = Path(args.folder)
    if not folder.is_dir():
        print(f"error: {folder} is not a folder", file=sys.stderr)
        return 1
    files = sorted((p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == ".glb"),
                   key=lambda p: p.name.lower())
    if not files:
        print(f"error: no .glb files in {folder}", file=sys.stderr)
        return 1
    if args.class_name is not None and len(files) > 1:
        print("error: --class-name names one ship, but this folder has "
              f"{len(files)} .glb files — use 'build' for that file", file=sys.stderr)
        return 1
    from dataclasses import asdict
    options = asdict(_options(args))
    started = time.perf_counter()
    results = run_jobs([(str(p), str(args.out), options) for p in files], args.jobs, _build_one)

    rows = [["file", "status", "class", "lines", "bytes", "hardpoints", "seconds", "detail"]]
    built, by_class, warnings = 0, {}, []
    for path, (ok, value) in zip(files, results):
        if ok:
            built += 1
            by_class.setdefault(value["className"], []).append(path.name)
            warnings += [f"warning: {path.name}: {w}" for w in value["warnings"]]
            rows.append([path.name, "ok", value["className"], str(value["lines"]),
                         str(value["bytes"]), str(value["hardpoints"]),
                         f"{value['seconds']:.1f}",
                         f"edges {value['edgeSeconds']:.1f}s, "
                         f"visibility {value['visibilitySeconds']:.1f}s"])
        else:
            rows.append([path.name, "FAILED", "-", "-", "-", "-", "-",
                         " ".join(str(value).split())])
    print(_table(rows))
    for line in warnings:
        print(line)
    failed = len(files) - built
    print(f"\n{built} built, {failed} failed in {time.perf_counter() - started:.1f}s "
          f"(jobs={args.jobs}) -> {args.out}")
    clashes = {name: names for name, names in by_class.items() if len(names) > 1}
    for name, names in clashes.items():
        print(f"WARNING: {', '.join(names)} have the same class name {name!r}: "
              "they wrote the same bundle, only one survives")
    return 1 if failed or clashes else 0


def cmd_inspect(args) -> int:
    from .bundle import BundleError, read_bundle
    try:
        header, segs = read_bundle(args.bundle)
    except BundleError as e:
        print(f"error: {Path(args.bundle).name}: {e}", file=sys.stderr)
        return 1
    print(json.dumps(header, indent=2, ensure_ascii=False))
    print(f"lines: {len(segs)}")
    return 0


# ---- arguments -----------------------------------------------------------------------

def _number(kind, low, high, what, *, low_open=False, high_open=False):
    def parse(text):
        try:
            value = kind(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{text!r} is not a number") from None
        too_low = value <= low if low_open else value < low
        too_high = value >= high if high_open else value > high
        if value != value or too_low or too_high:
            raise argparse.ArgumentTypeError(f"{what} (got {text})")
        return value
    return parse


def _add_build_flags(p) -> None:
    p.add_argument("-o", "--out", type=Path, default=DEFAULT_OUT, metavar="OUT_DIR",
                   help="output folder (default: tools/wireframes/out/, which is git-ignored)")
    p.add_argument("--crease-deg", default=60.0, metavar="DEG",
                   type=_number(float, 0, 180, "must be between 0 and 180 degrees, exclusive",
                                low_open=True, high_open=True),
                   help="keep edges whose faces differ by more than this angle (default 60)")
    p.add_argument("--min-edge-frac", default=0.0025, metavar="FRAC",
                   type=_number(float, 0, 1, "must be at least 0 and below 1", high_open=True),
                   help="drop edges shorter than this fraction of the longest dimension "
                        "(default 0.0025)")
    p.add_argument("--max-lines", default=60_000, metavar="N",
                   type=_number(int, 1, SERVER_MAX_LINES,
                                f"must be 1..{SERVER_MAX_LINES} (the server's limit)"),
                   help="keep at most this many edges, longest first (default 60000)")
    p.add_argument("--no-visibility", action="store_true",
                   help="skip the visible-from-outside cull (keeps interior edges)")
    p.add_argument("--depth-res", default=640, metavar="PX",
                   type=_number(int, 16, 4096, "must be 16..4096"),
                   help="depth-map resolution for the visibility cull (default 640)")
    p.add_argument("--kind", default="vehicle",
                   help="bundle kind (default vehicle; the server only accepts vehicle today)")
    p.add_argument("--class-name", default=None, metavar="NAME",
                   help="class name to use instead of the one in the GLB's extras.entity_name")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m wireframes",
        description="Wireframe bundles (.swf.gz) from StarBreaker .glb ship exports. "
                    "Bundles hold extracted game geometry: never commit them.")
    parser.add_argument("--version", action="version", version=f"wireframes {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    b = sub.add_parser("build", help="build one bundle from one .glb")
    b.add_argument("file", help="the .glb export")
    _add_build_flags(b)
    b.set_defaults(run=cmd_build)

    a = sub.add_parser("build-all", help="build every *.glb in a folder (not recursive)")
    a.add_argument("folder", help="folder holding .glb exports")
    a.add_argument("--jobs", default=DEFAULT_JOBS, metavar="N",
                   type=_number(int, 1, 256, "must be 1..256"),
                   help=f"ships built at once, one single-threaded process each "
                        f"(default {DEFAULT_JOBS})")
    _add_build_flags(a)
    a.set_defaults(run=cmd_build_all)

    i = sub.add_parser("inspect", help="print a bundle's header and line count")
    i.add_argument("bundle", help="a .swf.gz bundle")
    i.set_defaults(run=cmd_inspect)
    return parser


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    return args.run(args)
