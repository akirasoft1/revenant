"""``python -m wireframes ...`` (run from ``tools/``)."""
import sys

from .cli import main

if __name__ == "__main__":      # the guard matters: spawned workers re-import this module
    sys.exit(main())
