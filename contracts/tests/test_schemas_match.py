from __future__ import annotations

import json
from importlib import resources

import pytest

from lens_contracts.tools.gen_schemas import ENTITIES, render


@pytest.mark.parametrize(("name", "entity"), ENTITIES.items())
def test_committed_schema_matches_model(name: str, entity: type[object]) -> None:
    path = resources.files("lens_contracts.schemas").joinpath(f"{name}.schema.json")
    committed = json.loads(path.read_text(encoding="utf-8"))
    assert committed == render(entity)
