"""
Pydantic models for the Family Tree application.
"""
from typing import Optional, List, Dict, Any, Literal
from pydantic import BaseModel, Field, field_validator
import uuid


Gender = Literal["male", "female", "unknown"]


def generate_id() -> str:
    return str(uuid.uuid4())


def _coerce_gender(value: Any) -> str:
    return value if value in ("male", "female", "unknown") else "unknown"


class Person(BaseModel):
    """A person in the family tree. (x, y) is the centre of the node card on the canvas."""
    id: str = Field(default_factory=generate_id, min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=200)
    gender: Gender = "unknown"
    date_of_birth: Optional[str] = Field(default=None, max_length=64)
    date_of_death: Optional[str] = Field(default=None, max_length=64)
    photo_path: Optional[str] = Field(default=None, max_length=256)
    photo_base64: Optional[str] = None  # Only populated inside exported JSON files
    notes: Optional[str] = Field(default=None, max_length=5000)
    x: float = 0.0
    y: float = 0.0

    @field_validator("gender", mode="before")
    @classmethod
    def _gender(cls, v: Any) -> str:
        return _coerce_gender(v)


class PersonCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    gender: Gender = "unknown"
    date_of_birth: Optional[str] = Field(default=None, max_length=64)
    date_of_death: Optional[str] = Field(default=None, max_length=64)
    photo_path: Optional[str] = Field(default=None, max_length=256)
    notes: Optional[str] = Field(default=None, max_length=5000)
    x: float = 0.0
    y: float = 0.0


class PersonUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=200)
    gender: Optional[Gender] = None
    date_of_birth: Optional[str] = Field(default=None, max_length=64)
    date_of_death: Optional[str] = Field(default=None, max_length=64)
    photo_path: Optional[str] = Field(default=None, max_length=256)
    notes: Optional[str] = Field(default=None, max_length=5000)
    x: Optional[float] = None
    y: Optional[float] = None


class PositionItem(BaseModel):
    id: str
    x: float
    y: float


class Marriage(BaseModel):
    id: str = Field(default_factory=generate_id, min_length=1, max_length=64)
    spouse1_id: str
    spouse2_id: str
    marriage_date: Optional[str] = Field(default=None, max_length=64)
    order: int = 1


class MarriageCreate(BaseModel):
    spouse1_id: str
    spouse2_id: str
    marriage_date: Optional[str] = Field(default=None, max_length=64)


class MarriageUpdate(BaseModel):
    marriage_date: Optional[str] = Field(default=None, max_length=64)


class ParentChild(BaseModel):
    parent_id: str
    child_id: str
    marriage_id: Optional[str] = None


class ParentChildCreate(BaseModel):
    parent_id: str
    child_id: str
    marriage_id: Optional[str] = None


class FamilyTree(BaseModel):
    persons: Dict[str, Person] = Field(default_factory=dict)
    marriages: Dict[str, Marriage] = Field(default_factory=dict)
    parent_child: List[ParentChild] = Field(default_factory=list)
    metadata: Dict[str, Any] = Field(default_factory=dict)


class LayoutOptions(BaseModel):
    direction: Literal["top-down", "left-right"] = "top-down"
    root_person_id: str
    spacing_x: float = Field(default=200.0, ge=60, le=2000)
    spacing_y: float = Field(default=170.0, ge=60, le=2000)
