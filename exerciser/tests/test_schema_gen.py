"""Schema-driven input generation: determinism, class semantics, formats."""

from __future__ import annotations

from exerciser.schema import INPUT_CLASSES, generate_inputs, generate_value

USER_SCHEMA = {
    "type": "object",
    "required": ["email", "password", "age"],
    "properties": {
        "email": {"type": "string", "format": "email"},
        "password": {"type": "string", "minLength": 8, "maxLength": 40},
        "age": {"type": "integer", "minimum": 0, "maximum": 120},
        "role": {"type": "string", "enum": ["admin", "user", "guest"]},
        "nickname": {"type": "string"},
    },
}


def test_seeded_generation_is_deterministic():
    a = generate_value(USER_SCHEMA, 42, "valid")
    b = generate_value(USER_SCHEMA, 42, "valid")
    assert a == b


def test_different_seeds_can_differ():
    a = generate_value(USER_SCHEMA, 1, "valid")
    b = generate_value(USER_SCHEMA, 2, "valid")
    # At least one field should differ across seeds (email/password are random).
    assert a != b


def test_valid_instance_honours_constraints():
    inst = generate_value(USER_SCHEMA, 7, "valid")
    assert "@" in inst["email"]
    assert 8 <= len(inst["password"]) <= 40
    assert 0 <= inst["age"] <= 120
    # Optional fields are omitted from a minimal valid instance.
    assert "nickname" not in inst


def test_negative_drops_a_required_field():
    inst = generate_value(USER_SCHEMA, 7, "negative")
    # The first required field (email) is dropped to test rejection.
    assert "email" not in inst
    # The remaining required fields are still present (isolating one violation).
    assert "password" in inst and "age" in inst


def test_boundary_hits_edges():
    inst = generate_value(USER_SCHEMA, 7, "boundary")
    # password minLength edge, age minimum edge.
    assert len(inst["password"]) == 8
    assert inst["age"] == 0


def test_enum_valid_in_set_negative_out_of_set():
    schema = {"type": "string", "enum": ["a", "b", "c"]}
    assert generate_value(schema, 3, "valid") in {"a", "b", "c"}
    assert generate_value(schema, 3, "boundary") == "a"
    assert generate_value(schema, 3, "negative") not in {"a", "b", "c"}


def test_numeric_negative_exceeds_max():
    schema = {"type": "integer", "minimum": 0, "maximum": 10}
    assert generate_value(schema, 3, "negative") == 11


def test_format_email_valid_and_invalid():
    schema = {"type": "string", "format": "email"}
    assert "@" in generate_value(schema, 1, "valid")
    assert "@" not in generate_value(schema, 1, "negative")


def test_format_uuid_shape():
    schema = {"type": "string", "format": "uuid"}
    val = generate_value(schema, 1, "valid")
    assert val.count("-") == 4 and len(val) == 36


def test_negative_string_length_violation():
    schema = {"type": "string", "minLength": 5}
    # A min-length string violated → empty string.
    assert generate_value(schema, 1, "negative") == ""
    schema2 = {"type": "string", "maxLength": 3}
    # A max-length string violated → longer than max.
    assert len(generate_value(schema2, 1, "negative")) > 3


def test_array_class_semantics():
    schema = {"type": "array", "items": {"type": "integer", "minimum": 1, "maximum": 5}}
    assert generate_value(schema, 1, "boundary") == []  # empty-array edge
    assert generate_value(schema, 1, "negative") == "__wrong_type__"
    valid = generate_value(schema, 1, "valid")
    assert isinstance(valid, list) and all(1 <= x <= 5 for x in valid)


def test_generate_inputs_covers_all_classes():
    out = generate_inputs(USER_SCHEMA, 5)
    assert set(out) == set(INPUT_CLASSES)


def test_nullable_type_list_resolves():
    schema = {"type": ["string", "null"], "minLength": 2}
    val = generate_value(schema, 1, "valid")
    assert isinstance(val, str) and len(val) >= 2


def test_unbounded_integer_negative_probes_implicit_domain():
    # An unbounded int (no minimum) must yield a NEGATIVE value in the negative
    # class — the skip=-1/limit=-1 class of bug — not a wrong-type string.
    assert generate_value({"type": "integer"}, 3, "negative") == -1
    assert generate_value({"type": "number"}, 3, "negative") == -1.0
    # Bounded numbers still violate the declared bound (regression).
    assert generate_value({"type": "integer", "minimum": 0, "maximum": 10}, 3, "negative") == 11


def test_name_inference_shapes_underdeclared_string():
    # `email: str` with no declared format still gets an email-shaped valid value
    # and a malformed negative value, inferred from the field name.
    assert "@" in generate_value({"type": "string"}, 1, "valid", path="$.email")
    assert "@" not in generate_value({"type": "string"}, 1, "negative", path="$.email")
    # A query param named skip/id stays plain (no format inferred) — inference
    # only fires for recognised semantic names.
    assert "@" not in generate_value({"type": "string"}, 1, "valid", path="$query.token")


def test_name_inference_is_type_gated():
    # A field NAMED email but TYPED integer must never become an email string.
    val = generate_value({"type": "integer"}, 1, "valid", path="$.email_count")
    assert isinstance(val, int)


def test_declared_format_wins_over_name_inference():
    # A declared format is authoritative even when the name hints otherwise.
    val = generate_value({"type": "string", "format": "uuid"}, 1, "valid", path="$.email")
    assert val.count("-") == 4 and len(val) == 36
