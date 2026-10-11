"""Match catalog slot ids (``a/b/c``) to named nodes of a wireframe bundle.

First segment: every node with that name (case-insensitive). Each further
segment: the nearest descendants with that name (BFS; a branch is not searched
below a match). One result -> position; none -> missing; several -> the first
if all lie within ``COINCIDENT_M`` of each other, otherwise ambiguous.
"""
import math
from collections import deque
from dataclasses import dataclass, field

COINCIDENT_M = 0.05


@dataclass
class MatchResult:
    slots: dict = field(default_factory=dict)       # slotId -> {"xyz": [x, y, z]}
    missing: list = field(default_factory=list)
    ambiguous: list = field(default_factory=list)


def _descend(children: dict, nodes: list, start: int, name: str) -> list[int]:
    found, queue = [], deque(children.get(start, ()))
    while queue:
        i = queue.popleft()
        if nodes[i]["name"].casefold() == name:
            found.append(i)
        else:
            queue.extend(children.get(i, ()))
    return found


def match_slots(nodes: list[dict], slot_ids: list[str]) -> MatchResult:
    children: dict[int, list[int]] = {}
    for i, n in enumerate(nodes):
        children.setdefault(n["parent"], []).append(i)
    result = MatchResult()
    for slot in slot_ids:
        parts = [p.casefold() for p in slot.split("/")]
        current = [i for i, n in enumerate(nodes) if n["name"].casefold() == parts[0]]
        for part in parts[1:]:
            nxt: list[int] = []
            for i in current:
                for j in _descend(children, nodes, i, part):
                    if j not in nxt:
                        nxt.append(j)
            current = nxt
        if not current:
            result.missing.append(slot)
            continue
        pts = [nodes[i]["pos"] for i in current]
        if len(pts) > 1 and any(math.dist(a, b) > COINCIDENT_M for a in pts for b in pts):
            result.ambiguous.append(slot)
            continue
        result.slots[slot] = {"xyz": [float(x) for x in pts[0]]}
    return result
