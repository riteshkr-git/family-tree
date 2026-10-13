"""
Relationship endpoints: marriages and parent-child links.
"""
import logging
from collections import deque

from fastapi import APIRouter, Depends, HTTPException

from models import FamilyTree, Marriage, MarriageCreate, MarriageUpdate, ParentChild, ParentChildCreate
from session import TreeState, get_tree_state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["relationships"])


def _is_descendant(tree: FamilyTree, ancestor_id: str, candidate_id: str) -> bool:
    """True if candidate_id is ancestor_id itself or appears anywhere below it."""
    queue = deque([ancestor_id])
    seen = set()
    while queue:
        current = queue.popleft()
        if current == candidate_id:
            return True
        if current in seen:
            continue
        seen.add(current)
        queue.extend(pc.child_id for pc in tree.parent_child if pc.parent_id == current)
    return False


@router.get("/marriages", response_model=list[Marriage])
async def list_marriages(state: TreeState = Depends(get_tree_state)):
    return list(state.tree.marriages.values())


@router.post("/marriages", response_model=Marriage)
async def create_marriage(data: MarriageCreate, state: TreeState = Depends(get_tree_state)):
    tree = state.tree
    if data.spouse1_id == data.spouse2_id:
        raise HTTPException(status_code=400, detail="A person cannot marry themselves")
    if data.spouse1_id not in tree.persons:
        raise HTTPException(status_code=404, detail="Spouse 1 not found")
    if data.spouse2_id not in tree.persons:
        raise HTTPException(status_code=404, detail="Spouse 2 not found")

    pair = {data.spouse1_id, data.spouse2_id}
    if any({m.spouse1_id, m.spouse2_id} == pair for m in tree.marriages.values()):
        raise HTTPException(status_code=400, detail="These two people are already married")

    order = 1 + sum(1 for m in tree.marriages.values() if data.spouse1_id in (m.spouse1_id, m.spouse2_id))

    state.save_state("create_marriage")
    marriage = Marriage(
        spouse1_id=data.spouse1_id,
        spouse2_id=data.spouse2_id,
        marriage_date=data.marriage_date,
        order=order,
    )
    tree.marriages[marriage.id] = marriage
    return marriage


@router.put("/marriages/{marriage_id}", response_model=Marriage)
async def update_marriage(marriage_id: str, data: MarriageUpdate, state: TreeState = Depends(get_tree_state)):
    marriage = state.tree.marriages.get(marriage_id)
    if marriage is None:
        raise HTTPException(status_code=404, detail="Marriage not found")

    state.save_state("update_marriage")
    marriage.marriage_date = data.marriage_date
    return marriage


@router.delete("/marriages/{marriage_id}")
async def delete_marriage(marriage_id: str, state: TreeState = Depends(get_tree_state)):
    tree = state.tree
    if marriage_id not in tree.marriages:
        raise HTTPException(status_code=404, detail="Marriage not found")

    state.save_state("delete_marriage")
    del tree.marriages[marriage_id]
    for pc in tree.parent_child:
        if pc.marriage_id == marriage_id:
            pc.marriage_id = None
    return {"status": "deleted", "id": marriage_id}


@router.get("/children", response_model=list[ParentChild])
async def list_parent_child(state: TreeState = Depends(get_tree_state)):
    return state.tree.parent_child


@router.post("/children", response_model=ParentChild)
async def add_child(data: ParentChildCreate, state: TreeState = Depends(get_tree_state)):
    tree = state.tree
    if data.parent_id == data.child_id:
        raise HTTPException(status_code=400, detail="A person cannot be their own child")
    if data.parent_id not in tree.persons:
        raise HTTPException(status_code=404, detail="Parent not found")
    if data.child_id not in tree.persons:
        raise HTTPException(status_code=404, detail="Child not found")
    if data.marriage_id and data.marriage_id not in tree.marriages:
        raise HTTPException(status_code=404, detail="Marriage not found")

    if any(pc.parent_id == data.parent_id and pc.child_id == data.child_id for pc in tree.parent_child):
        raise HTTPException(status_code=400, detail="Relationship already exists")
    if _is_descendant(tree, data.child_id, data.parent_id):
        raise HTTPException(status_code=400, detail="That would make someone their own ancestor")

    state.save_state("add_child")
    link = ParentChild(parent_id=data.parent_id, child_id=data.child_id, marriage_id=data.marriage_id)
    tree.parent_child.append(link)
    return link


@router.delete("/children/{parent_id}/{child_id}")
async def remove_child(parent_id: str, child_id: str, state: TreeState = Depends(get_tree_state)):
    tree = state.tree
    remaining = [pc for pc in tree.parent_child if not (pc.parent_id == parent_id and pc.child_id == child_id)]
    if len(remaining) == len(tree.parent_child):
        raise HTTPException(status_code=404, detail="Relationship not found")

    state.save_state("remove_child")
    tree.parent_child = remaining
    return {"status": "deleted", "parent_id": parent_id, "child_id": child_id}
