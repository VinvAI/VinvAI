"""JSON Schema files for each entity in this package.

The .json files are generated from the pydantic models via
`python -m lens_contracts.tools.gen_schemas`.
Treat the JSON files as the source of truth for downstream validators (jsonschema), and the
pydantic models as the source of truth for in-process construction.
"""
