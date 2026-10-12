"""Worker targets for the scheduler tests.

Deliberately numpy-free at import time: a spawned worker imports this module
before running the target, and the tests check numpy has not been imported yet.
"""
import os
import sys
import time

THREAD_VARS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS")


def report_env(task):
    before = "numpy" in sys.modules
    import numpy  # noqa: F401  (imported only after the environment was read)
    return {"task": task, "numpy_preloaded": before, "pid": os.getpid(),
            **{k: os.environ.get(k) for k in THREAD_VARS}}


def timed(task):
    log_dir, name, seconds = task
    start = time.time()
    time.sleep(seconds)
    with open(os.path.join(log_dir, name + ".txt"), "w") as f:
        f.write(f"{start} {time.time()} {os.getpid()}")
    return name


def flaky(task):
    if task == "raise":
        raise RuntimeError("boom from worker")
    if task == "die":
        os._exit(7)
    return task.upper()
