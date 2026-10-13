"""
Auto-arrange: a hierarchical layout of the component that contains the chosen root.

Generations are assigned by walking the whole connected component (parents one level
up, spouses on the same level), so ancestors of the chosen root keep their proper rows
instead of being dumped as "disconnected". Horizontal order comes from a depth-first
walk starting at the founders (people with no parents), placing each couple centred
over their children.
"""
import logging
from collections import deque
from typing import Dict, List, Set

from models import FamilyTree, LayoutOptions

logger = logging.getLogger(__name__)


def calculate_layout(tree: FamilyTree, options: LayoutOptions) -> Dict[str, Dict[str, float]]:
    if not tree.persons or options.root_person_id not in tree.persons:
        return {}

    spacing_x = options.spacing_x
    spacing_y = options.spacing_y

    # ---- relationship indices -------------------------------------------------
    marriages_by_person: Dict[str, list] = {}
    children_by_marriage: Dict[str, List[str]] = {}
    children_by_parent: Dict[str, List[str]] = {}
    parents_by_child: Dict[str, List[str]] = {}
    spouses_of: Dict[str, Set[str]] = {}

    for m in tree.marriages.values():
        if m.spouse1_id not in tree.persons or m.spouse2_id not in tree.persons:
            continue
        marriages_by_person.setdefault(m.spouse1_id, []).append(m)
        marriages_by_person.setdefault(m.spouse2_id, []).append(m)
        spouses_of.setdefault(m.spouse1_id, set()).add(m.spouse2_id)
        spouses_of.setdefault(m.spouse2_id, set()).add(m.spouse1_id)
        children_by_marriage[m.id] = []

    for pc in tree.parent_child:
        if pc.parent_id not in tree.persons or pc.child_id not in tree.persons:
            continue
        children_by_parent.setdefault(pc.parent_id, []).append(pc.child_id)
        parents_by_child.setdefault(pc.child_id, []).append(pc.parent_id)
        if pc.marriage_id in children_by_marriage and pc.child_id not in children_by_marriage[pc.marriage_id]:
            children_by_marriage[pc.marriage_id].append(pc.child_id)

    # ---- generation numbers for the root's component -----------------------------
    def assign_generations(start: str) -> Dict[str, int]:
        gen = {start: 0}
        queue = deque([start])
        while queue:
            pid = queue.popleft()
            g = gen[pid]
            neighbours = (
                [(c, g + 1) for c in children_by_parent.get(pid, [])]
                + [(p, g - 1) for p in parents_by_child.get(pid, [])]
                + [(s, g) for s in spouses_of.get(pid, set())]
            )
            for other, other_gen in neighbours:
                if other not in gen:
                    gen[other] = other_gen
                    queue.append(other)
        return gen

    positions: Dict[str, Dict[str, float]] = {}
    visited: Set[str] = set()
    cursor = {"x": 0.0}

    def family_children(pid: str) -> List[str]:
        """Children of pid across all marriages, then any unlinked ones, in stable order."""
        ordered: List[str] = []
        for m in sorted(marriages_by_person.get(pid, []), key=lambda m: m.order):
            ordered.extend(children_by_marriage.get(m.id, []))
        ordered.extend(children_by_parent.get(pid, []))
        seen: Set[str] = set()
        return [c for c in ordered if not (c in seen or seen.add(c))]

    def place_unit(pid: str, base_x: float, gen: Dict[str, int]) -> float:
        """Place pid, their spouses and descendants from base_x. Returns the width used."""
        if pid in visited:
            return 0.0
        visited.add(pid)

        spouses = []
        for m in sorted(marriages_by_person.get(pid, []), key=lambda m: m.order):
            sid = m.spouse2_id if m.spouse1_id == pid else m.spouse1_id
            if sid not in visited:
                visited.add(sid)
                spouses.append(sid)

        unit_width = spacing_x * (1 + len(spouses))

        before = set(positions)
        children_width = 0.0
        for child in family_children(pid):
            children_width += place_unit(child, base_x + children_width, gen)

        total = max(children_width, unit_width)
        if 0 < children_width < unit_width:
            # Couple is wider than its descendants: centre the descendants under the couple
            shift = (unit_width - children_width) / 2
            for placed in positions.keys() - before:
                positions[placed]["x"] += shift
        start_x = base_x + (total - unit_width) / 2 + spacing_x / 2
        row = gen.get(pid, 0)
        positions[pid] = {"x": start_x, "y": row * spacing_y}
        for i, sid in enumerate(spouses, start=1):
            positions[sid] = {"x": start_x + i * spacing_x, "y": gen.get(sid, row) * spacing_y}
        return total

    def layout_component(start: str) -> None:
        gen = assign_generations(start)
        lowest = min(gen.values())
        for pid in gen:
            gen[pid] -= lowest

        founders = [pid for pid in gen if not parents_by_child.get(pid)]
        founders.sort(key=lambda pid: (gen[pid], tree.persons[pid].x))
        for founder in founders:
            cursor["x"] += place_unit(founder, cursor["x"], gen)
        for pid in gen:  # anything not reachable through a founder (cycles in bad data)
            cursor["x"] += place_unit(pid, cursor["x"], gen)

    layout_component(options.root_person_id)

    # Other components, left to right after the main tree
    for pid in sorted(tree.persons, key=lambda p: tree.persons[p].x):
        if pid not in visited:
            cursor["x"] += spacing_x / 2
            layout_component(pid)

    if options.direction == "left-right":
        positions = {pid: {"x": pos["y"], "y": pos["x"]} for pid, pos in positions.items()}

    logger.info("Laid out %d persons", len(positions))
    return positions
