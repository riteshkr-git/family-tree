"""
Person CRUD endpoints.
"""
import logging
from typing import List

from fastapi import APIRouter, Depends, HTTPException

from models import Person, PersonCreate, PersonUpdate, PositionItem
from session import TreeState, get_tree_state

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/persons", tags=["persons"])


@router.get("", response_model=list[Person])
async def list_persons(state: TreeState = Depends(get_tree_state)):
    return list(state.tree.persons.values())


@router.post("", response_model=Person)
async def create_person(data: PersonCreate, state: TreeState = Depends(get_tree_state)):
    person = Person(**data.model_dump())
    state.save_state("create_person")
    state.tree.persons[person.id] = person
    return person


@router.patch("/positions")
async def update_positions(positions: List[PositionItem], state: TreeState = Depends(get_tree_state)):
    """Batch position update after a drag. Deliberately not recorded in undo history."""
    count = 0
    for pos in positions:
        person = state.tree.persons.get(pos.id)
        if person is not None:
            person.x = pos.x
            person.y = pos.y
            count += 1
    state.touch()
    return {"status": "success", "updated_count": count}


@router.get("/{person_id}", response_model=Person)
async def get_person(person_id: str, state: TreeState = Depends(get_tree_state)):
    person = state.tree.persons.get(person_id)
    if person is None:
        raise HTTPException(status_code=404, detail="Person not found")
    return person


@router.put("/{person_id}", response_model=Person)
async def update_person(person_id: str, data: PersonUpdate, state: TreeState = Depends(get_tree_state)):
    person = state.tree.persons.get(person_id)
    if person is None:
        raise HTTPException(status_code=404, detail="Person not found")

    state.save_state("update_person")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(person, field, value)
    return person


@router.delete("/{person_id}")
async def delete_person(person_id: str, state: TreeState = Depends(get_tree_state)):
    """Delete a person and every relationship that references them."""
    tree = state.tree
    if person_id not in tree.persons:
        raise HTTPException(status_code=404, detail="Person not found")

    state.save_state("delete_person")
    del tree.persons[person_id]

    removed_marriages = {
        m_id for m_id, m in tree.marriages.items()
        if person_id in (m.spouse1_id, m.spouse2_id)
    }
    for m_id in removed_marriages:
        del tree.marriages[m_id]

    tree.parent_child = [
        pc for pc in tree.parent_child
        if person_id not in (pc.parent_id, pc.child_id)
    ]
    # Children of a dissolved marriage keep their parent links but lose the marriage grouping
    for pc in tree.parent_child:
        if pc.marriage_id in removed_marriages:
            pc.marriage_id = None

    return {"status": "deleted", "id": person_id}
