import json
import os
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from wireframes import cli
from wireframes.bundle import read_bundle
from wireframes.tests import synth, workers

TOOLS_DIR = Path(__file__).resolve().parents[2]
FAST = ["--depth-res", "128"]


def write_glb(folder, name, data=None, **kw):
    p = Path(folder) / name
    p.write_bytes(synth.ship_glb(**kw) if data is None else data)
    return p


def test_importing_the_cli_does_not_import_numpy():
    code = "import sys, wireframes, wireframes.cli, wireframes.__main__; print('numpy' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], cwd=TOOLS_DIR, capture_output=True,
                         text=True, check=True)
    assert out.stdout.strip() == "False"


# ---- build -------------------------------------------------------------------

def test_build_writes_a_bundle_named_after_the_class(tmp_path, capsys):
    src = write_glb(tmp_path, "My Ship.glb", class_name="AEGS_Test_Ship", inner=True)
    out = tmp_path / "out"
    assert cli.main(["build", str(src), "-o", str(out), *FAST]) == 0
    bundle = out / "AEGS_Test_Ship.swf.gz"
    assert [p.name for p in out.iterdir()] == [bundle.name]
    header, segs = read_bundle(bundle)
    assert header["kind"] == "vehicle"
    assert header["className"] == "AEGS_Test_Ship"
    assert header["sourceName"] == "My Ship.glb"
    assert header["build"] == {"creaseDeg": 60.0, "minEdgeFrac": 0.0025, "maxLines": 60000,
                               "visibility": True, "depthRes": 128,
                               "tool": header["build"]["tool"]}
    assert header["lines"] == len(segs) == 48                 # hull only: inner box culled
    assert np.isfinite(segs).all()
    assert np.allclose(np.abs(segs).max(), 2.0, atol=1e-3)
    names = {n["name"] for n in header["nodes"]}
    assert "hardpoint_class_2" in names and "turret_left" in names and "decal_only" not in names
    line = capsys.readouterr().out.strip().splitlines()
    assert len(line) == 1                                     # a one-line summary
    for token in ("AEGS_Test_Ship", "lines=48", f"bytes={bundle.stat().st_size}",
                  "hardpoints=3", "seconds="):
        assert token in line[0]


def test_build_without_visibility_keeps_interior_edges(tmp_path):
    src = write_glb(tmp_path, "s.glb", inner=True)
    assert cli.main(["build", str(src), "-o", str(tmp_path), "--no-visibility"]) == 0
    header, _ = read_bundle(tmp_path / "TEST_Ship.swf.gz")
    assert header["lines"] == 48 + 12
    assert header["build"]["visibility"] is False


def test_build_flags_reach_the_pipeline_and_the_header(tmp_path):
    src = write_glb(tmp_path, "s.glb")
    args = ["build", str(src), "-o", str(tmp_path), "--no-visibility", "--max-lines", "5",
            "--crease-deg", "45", "--min-edge-frac", "0.01", "--depth-res", "200",
            "--kind", "item"]
    assert cli.main(args) == 0
    header, _ = read_bundle(tmp_path / "TEST_Ship.swf.gz")
    assert header["lines"] == 5 and header["kind"] == "item"
    assert header["build"]["maxLines"] == 5 and header["build"]["creaseDeg"] == 45.0
    assert header["build"]["minEdgeFrac"] == 0.01 and header["build"]["depthRes"] == 200


def test_min_edge_frac_drops_short_edges(tmp_path):
    src = write_glb(tmp_path, "s.glb")                        # hull edges are 1 m of a 4 m box
    assert cli.main(["build", str(src), "-o", str(tmp_path), "--no-visibility",
                     "--min-edge-frac", "0.3"]) != 0          # nothing left -> clear failure
    assert not (tmp_path / "TEST_Ship.swf.gz").exists()


def test_class_name_flag_overrides_extras(tmp_path):
    src = write_glb(tmp_path, "s.glb")
    assert cli.main(["build", str(src), "-o", str(tmp_path), "--class-name", "Other_Name",
                     *FAST]) == 0
    assert read_bundle(tmp_path / "Other_Name.swf.gz")[0]["className"] == "Other_Name"
    assert not (tmp_path / "TEST_Ship.swf.gz").exists()


def test_missing_class_name_fails_and_names_the_flag(tmp_path, capsys):
    src = write_glb(tmp_path, "anon.glb", with_class=False)
    out = tmp_path / "out"
    assert cli.main(["build", str(src), "-o", str(out), *FAST]) == 1
    err = capsys.readouterr().err
    assert "--class-name" in err and "anon.glb" in err
    assert not out.exists() or list(out.iterdir()) == []
    # ...and the flag rescues it
    assert cli.main(["build", str(src), "-o", str(out), "--class-name", "Given", *FAST]) == 0
    assert (out / "Given.swf.gz").exists()


@pytest.mark.parametrize("name", ["../evil", "a/b", "", ".hidden", "x" * 200, "sp ace"])
def test_unsafe_class_names_are_refused(tmp_path, name, capsys):
    src = write_glb(tmp_path, "s.glb")
    out = tmp_path / "out"
    assert cli.main(["build", str(src), "-o", str(out), "--class-name", name, *FAST]) == 1
    assert "class name" in capsys.readouterr().err.lower()
    assert not list(tmp_path.rglob("*.swf.gz"))


def test_corrupt_glb_fails_with_a_message(tmp_path, capsys):
    src = write_glb(tmp_path, "bad.glb", data=b"this is not a glb")
    assert cli.main(["build", str(src), "-o", str(tmp_path)]) == 1
    assert "bad.glb" in capsys.readouterr().err


def test_limits_are_checked_before_any_work(tmp_path, capsys):
    src = write_glb(tmp_path, "s.glb")
    for extra in (["--max-lines", "80001"], ["--max-lines", "0"], ["--depth-res", "4"],
                  ["--crease-deg", "0"], ["--min-edge-frac", "-1"]):
        with pytest.raises(SystemExit) as e:
            cli.main(["build", str(src), "-o", str(tmp_path), *extra])
        assert e.value.code == 2
    capsys.readouterr()


def test_degenerate_geometry_builds_without_nans(tmp_path):
    b = synth.GlbBuilder()
    P, F = synth.subdivided_box(size=2.0, n=2)
    messy_f = np.concatenate([F, [[0, 0, 1], [3, 3, 3], [0, 1, 999]]])
    hull = b.mesh(P, messy_f)
    soup = b.mesh(P[F].reshape(-1, 3))                         # no index buffer
    no_pos = b.mesh(P, F, with_position=False)
    flat = b.mesh(np.zeros((3, 3), np.float32), np.array([[0, 1, 2]]))
    kids = [
        b.node("hull", mesh=hull, scale=(-1.0, 3.0, 0.5)),     # mirrored, non-uniform
        b.node("soup", mesh=soup, translation=(6.0, 0.0, 0.0), scale=(1.0, -1.0, -1.0)),
        b.node("no_pos", mesh=no_pos),
        b.node("flat", mesh=flat),
        b.node("squashed", mesh=hull, scale=(0.0, 0.0, 0.0)),
        b.node("hardpoint_x", translation=(1.0, 2.0, 3.0)),
    ]
    root = b.node("root", children=kids, extras={"entity_name": "EntityClassDefinition.Messy"})
    src = write_glb(tmp_path, "messy.glb", data=b.build([root]))
    assert cli.main(["build", str(src), "-o", str(tmp_path), *FAST]) == 0
    header, segs = read_bundle(tmp_path / "Messy.swf.gz")
    assert header["lines"] == len(segs) == 48
    assert np.isfinite(segs).all()
    assert np.isfinite(header["center"]).all() and np.isfinite(header["halfExtent"])
    assert np.allclose(np.abs(segs.reshape(-1, 3)).max(0), [7, 3, 1], atol=1e-2)


def test_glb_without_any_edges_fails_clearly(tmp_path, capsys):
    b = synth.GlbBuilder()
    root = b.node("root", extras={"entity_name": "EntityClassDefinition.Empty"})
    src = write_glb(tmp_path, "empty.glb", data=b.build([root]))
    assert cli.main(["build", str(src), "-o", str(tmp_path)]) == 1
    assert "no edges" in capsys.readouterr().err.lower()
    assert not list(tmp_path.glob("*.swf.gz"))


# ---- inspect -----------------------------------------------------------------

def test_inspect_prints_the_header_and_line_count(tmp_path, capsys):
    src = write_glb(tmp_path, "s.glb")
    cli.main(["build", str(src), "-o", str(tmp_path), *FAST])
    capsys.readouterr()
    assert cli.main(["inspect", str(tmp_path / "TEST_Ship.swf.gz")]) == 0
    out = capsys.readouterr().out
    header = json.loads(out[:out.rindex("}") + 1])
    assert header["className"] == "TEST_Ship"
    assert "lines: 48" in out[out.rindex("}"):]


def test_inspect_bad_bundle_fails(tmp_path, capsys):
    p = tmp_path / "x.swf.gz"
    p.write_bytes(b"junk")
    assert cli.main(["inspect", str(p)]) == 1
    assert "x.swf.gz" in capsys.readouterr().err


def test_module_entry_point_runs(tmp_path):
    src = write_glb(tmp_path, "s.glb")
    r = subprocess.run([sys.executable, "-m", "wireframes", "build", str(src), "-o",
                        str(tmp_path), *FAST], cwd=TOOLS_DIR, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    r = subprocess.run([sys.executable, "-m", "wireframes", "inspect",
                        str(tmp_path / "TEST_Ship.swf.gz")], cwd=TOOLS_DIR,
                       capture_output=True, text=True)
    assert r.returncode == 0 and '"className": "TEST_Ship"' in r.stdout


# ---- build-all ---------------------------------------------------------------

def test_build_all_continues_past_failures_and_exits_non_zero(tmp_path, capsys):
    src = tmp_path / "exports"
    (src / "nested").mkdir(parents=True)
    write_glb(src, "Alpha.glb", class_name="Ship_Alpha")
    write_glb(src, "Beta.GLB", class_name="Ship_Beta", inner=True)
    write_glb(src, "Broken.glb", data=b"glTF garbage that is not a real file")
    write_glb(src / "nested", "Deep.glb", class_name="Ship_Deep")     # non-recursive
    (src / "notes.txt").write_text("ignore me")
    out = tmp_path / "out"
    code = cli.main(["build-all", str(src), "-o", str(out), "--jobs", "2", *FAST])
    assert code != 0
    assert sorted(p.name for p in out.iterdir()) == ["Ship_Alpha.swf.gz", "Ship_Beta.swf.gz"]
    assert read_bundle(out / "Ship_Beta.swf.gz")[0]["lines"] == 48
    table = capsys.readouterr().out
    rows = {name: line for line in table.splitlines()
            for name in ("Alpha.glb", "Beta.GLB", "Broken.glb", "Deep.glb") if name in line}
    assert set(rows) == {"Alpha.glb", "Beta.GLB", "Broken.glb"}
    assert "ok" in rows["Alpha.glb"].lower() and "Ship_Alpha" in rows["Alpha.glb"]
    assert "FAILED" in rows["Broken.glb"]
    assert "2 built, 1 failed" in table


def test_build_all_reports_a_missing_class_name_and_carries_on(tmp_path, capsys):
    src = tmp_path / "exports"
    src.mkdir()
    write_glb(src, "Named.glb", class_name="Ship_Named")
    write_glb(src, "Anon.glb", with_class=False)
    out = tmp_path / "out"
    assert cli.main(["build-all", str(src), "-o", str(out), "--jobs", "2", *FAST]) == 1
    assert [p.name for p in out.iterdir()] == ["Ship_Named.swf.gz"]
    table = capsys.readouterr().out
    anon = next(line for line in table.splitlines() if "Anon.glb" in line)
    assert "FAILED" in anon and "--class-name" in anon


def test_build_all_all_good_exits_zero(tmp_path, capsys):
    src = tmp_path / "exports"
    src.mkdir()
    write_glb(src, "A.glb", class_name="Ship_A")
    assert cli.main(["build-all", str(src), "-o", str(tmp_path / "out"), *FAST]) == 0
    assert "1 built, 0 failed" in capsys.readouterr().out


def test_build_all_with_nothing_to_do_fails(tmp_path, capsys):
    assert cli.main(["build-all", str(tmp_path)]) == 1
    assert "no .glb" in capsys.readouterr().err.lower()
    assert cli.main(["build-all", str(tmp_path / "missing")]) == 1


def test_build_all_refuses_one_class_name_for_many_files(tmp_path, capsys):
    write_glb(tmp_path, "A.glb")
    write_glb(tmp_path, "B.glb")
    assert cli.main(["build-all", str(tmp_path), "--class-name", "Same"]) == 1
    assert "--class-name" in capsys.readouterr().err


def test_build_all_flags_two_files_with_the_same_class(tmp_path, capsys):
    write_glb(tmp_path, "A.glb", class_name="Twin")
    write_glb(tmp_path, "B.glb", class_name="Twin")
    assert cli.main(["build-all", str(tmp_path), "-o", str(tmp_path / "o"), *FAST]) == 1
    assert "same class name" in capsys.readouterr().out.lower()


def test_jobs_default_is_eight_and_must_be_positive(tmp_path):
    assert cli.build_parser().parse_args(["build-all", "x"]).jobs == 8
    with pytest.raises(SystemExit):
        cli.main(["build-all", str(tmp_path), "--jobs", "0"])


# ---- the process scheduler ---------------------------------------------------

def test_workers_pin_blas_threads_before_numpy_is_imported(monkeypatch):
    for var in workers.THREAD_VARS:
        monkeypatch.setenv(var, "16")
    results = cli.run_jobs(["a", "b", "c"], 2, workers.report_env)
    assert [ok for ok, _ in results] == [True, True, True]
    for i, (_, r) in enumerate(results):
        assert r["task"] == "abc"[i]                           # results keep task order
        assert r["numpy_preloaded"] is False
        assert [r[v] for v in workers.THREAD_VARS] == ["1", "1", "1"]
        assert r["pid"] != os.getpid()
    assert len({r["pid"] for _, r in results}) == 3            # one process per task
    assert [os.environ[v] for v in workers.THREAD_VARS] == ["16", "16", "16"]   # parent untouched


def test_job_count_is_honoured(tmp_path):
    tasks = [(str(tmp_path), f"t{i}", 0.6) for i in range(5)]
    results = cli.run_jobs(tasks, 2, workers.timed)
    assert [v for _, v in results] == [f"t{i}" for i in range(5)]
    spans = [tuple(map(float, (tmp_path / f"t{i}.txt").read_text().split()[:2]))
             for i in range(5)]
    events = sorted([(s, 1) for s, _ in spans] + [(e, -1) for _, e in spans])
    running = peak = 0
    for _, delta in events:
        running += delta
        peak = max(peak, running)
    assert peak == 2


def test_a_failing_or_dying_worker_does_not_stop_the_others():
    results = cli.run_jobs(["x", "raise", "die", "y"], 2, workers.flaky)
    assert results[0] == (True, "X") and results[3] == (True, "Y")
    assert results[1][0] is False and "boom from worker" in results[1][1]
    assert results[2][0] is False and "7" in results[2][1]


def test_build_pins_threads_while_running_and_restores_them(tmp_path, monkeypatch):
    monkeypatch.setenv("OMP_NUM_THREADS", "12")
    monkeypatch.delenv("OPENBLAS_NUM_THREADS", raising=False)
    monkeypatch.setenv("MKL_NUM_THREADS", "3")
    seen = {}
    real = cli._build_one

    def spy(task):
        seen.update({v: os.environ.get(v) for v in workers.THREAD_VARS})
        return real(task)

    monkeypatch.setattr(cli, "_build_one", spy)
    src = write_glb(tmp_path, "s.glb")
    assert cli.main(["build", str(src), "-o", str(tmp_path), *FAST]) == 0
    assert seen == dict.fromkeys(workers.THREAD_VARS, "1")
    assert os.environ["OMP_NUM_THREADS"] == "12" and os.environ["MKL_NUM_THREADS"] == "3"
    assert "OPENBLAS_NUM_THREADS" not in os.environ
    # ...also when the build fails
    bad = write_glb(tmp_path, "bad.glb", data=b"junk")
    assert cli.main(["build", str(bad), "-o", str(tmp_path)]) == 1
    assert os.environ["OMP_NUM_THREADS"] == "12" and "OPENBLAS_NUM_THREADS" not in os.environ


# ---- robust extent (stray fragments must not resize the ship) ----------------

def _hull_glb(with_decal: bool) -> bytes:
    b = synth.GlbBuilder()
    kids = [b.node("hull", mesh=b.mesh(*synth.subdivided_box(size=20.0, n=64))),
            b.node("hardpoint_gun", translation=(0.0, 1.0, 0.0))]
    if with_decal:                      # a 0.2 m fragment 200 m away
        tri = np.array([[0, 0, 0], [0.2, 0, 0], [0, 0.2, 0]], dtype=np.float32)
        kids.append(b.node("decal", mesh=b.mesh(tri, np.array([[0, 1, 2]])),
                           translation=(200.0, 0.0, 0.0)))
    root = b.node("root", children=kids, extras={"entity_name": "EntityClassDefinition.Hull"})
    return b.build([root])


def test_far_stray_fragment_does_not_change_the_result(tmp_path, capsys):
    clean = write_glb(tmp_path, "clean.glb", data=_hull_glb(False))
    stray = write_glb(tmp_path, "stray.glb", data=_hull_glb(True))
    assert cli.main(["build", str(clean), "-o", str(tmp_path / "a"), *FAST]) == 0
    quiet = capsys.readouterr()
    assert "warning" not in (quiet.out + quiet.err).lower()      # no strays: no warning
    assert cli.main(["build", str(stray), "-o", str(tmp_path / "b"), *FAST]) == 0
    noisy = capsys.readouterr()
    ha, sa = read_bundle(tmp_path / "a" / "Hull.swf.gz")
    hb, sb = read_bundle(tmp_path / "b" / "Hull.swf.gz")
    assert ha["lines"] == hb["lines"] == 768
    assert synth.segs_set(sa) == synth.segs_set(sb)
    assert ha["center"] == hb["center"] and ha["halfExtent"] == hb["halfExtent"]
    warning = [l for l in noisy.err.splitlines() if l.lower().startswith("warning")]
    assert len(warning) == 1
    assert "stray.glb" in warning[0] and "20.0" in warning[0] and "210.2" in warning[0]
    assert len(noisy.out.strip().splitlines()) == 1              # still a one-line summary


def test_build_all_shows_the_stray_warning(tmp_path, capsys):
    src = tmp_path / "exports"
    src.mkdir()
    write_glb(src, "stray.glb", data=_hull_glb(True))
    assert cli.main(["build-all", str(src), "-o", str(tmp_path / "o"), "--jobs", "1", *FAST]) == 0
    out = capsys.readouterr().out
    assert any(l.lower().startswith("warning") and "stray.glb" in l for l in out.splitlines())
    assert read_bundle(tmp_path / "o" / "Hull.swf.gz")[0]["lines"] == 768


# ---- malformed structure / OS errors: an error line, never a traceback -------

def _malformed(kind: str) -> bytes:
    b = synth.GlbBuilder()
    m = b.mesh(*synth.box())
    root = b.node("root", mesh=m, extras={"entity_name": "EntityClassDefinition.Odd"})
    if kind == "mesh_not_object":
        b.meshes[0] = 5
    elif kind == "primitives_not_list":
        b.meshes[0] = {"primitives": 7}
    elif kind == "attributes_is_list":
        b.meshes[0]["primitives"][0]["attributes"] = ["POSITION"]
    elif kind == "buffer_view_not_object":
        b.views[0] = "nope"
    elif kind == "accessor_not_object":
        b.accessors[0] = None
    elif kind == "accessors_is_dict":
        b.extra_json["accessors"] = {"0": 1}
    elif kind == "children_garbage":
        b.nodes[root]["children"] = [{"x": 1}, "y", 99]
    elif kind == "scenes_garbage":
        b.extra_json["scenes"] = [[1, 2]]
    elif kind == "buffers_garbage":
        b.extra_json["buffers"] = "zzz"
    elif kind == "extras_list_name_int":
        b.nodes[root]["name"] = 12
    return b.build([root])


@pytest.mark.parametrize("kind", ["mesh_not_object", "primitives_not_list", "attributes_is_list",
                                  "buffer_view_not_object", "accessor_not_object",
                                  "accessors_is_dict", "children_garbage", "scenes_garbage",
                                  "buffers_garbage", "extras_list_name_int"])
def test_malformed_gltf_structure_never_tracebacks(tmp_path, capsys, kind):
    src = write_glb(tmp_path, "odd.glb", data=_malformed(kind))
    code = cli.main(["build", str(src), "-o", str(tmp_path / "o"), *FAST])   # must not raise
    err = capsys.readouterr().err
    assert "Traceback" not in err
    if code != 0:
        assert code == 1 and err.startswith("error: odd.glb:")
        assert not list(tmp_path.rglob("*.swf.gz"))


def test_malformed_mesh_entries_are_a_glb_error():
    from wireframes.glb import GlbError, iter_mesh_instances, load_glb
    for kind in ("mesh_not_object", "buffer_view_not_object", "accessor_not_object"):
        with pytest.raises(GlbError):
            list(iter_mesh_instances(load_glb(_malformed(kind))))


def test_unwritable_output_is_an_error_line(tmp_path, capsys):
    src = write_glb(tmp_path, "s.glb")
    blocker = tmp_path / "not_a_dir"
    blocker.write_text("x")
    assert cli.main(["build", str(src), "-o", str(blocker / "out"), *FAST]) == 1
    err = capsys.readouterr().err
    assert err.startswith("error: s.glb:") and "Traceback" not in err
