from __future__ import annotations

import stat
import zipfile
from pathlib import Path

import pytest

from tracelens.launcher import run as run_mod


def _temp_extract_dirs(parent: Path) -> list[Path]:
    return [
        path
        for path in parent.iterdir()
        if path.is_dir() and path.name.startswith("tracelens_src.")
    ]


def _write_zip(path: Path, members: dict[str, bytes]) -> None:
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in members.items():
            archive.writestr(name, content)


@pytest.mark.parametrize("member_name", ["../../escaped.py", "..\\escaped.py"])
def test_bundled_source_rejects_parent_traversal(tmp_path: Path, member_name: str) -> None:
    archive = tmp_path / "tracelens_src.zip"
    _write_zip(
        archive,
        {
            "tracelens/__init__.py": b"",
            member_name: b"escaped",
        },
    )

    assert run_mod._extract_bundled_source(archive) is None
    assert not (tmp_path.parent / "escaped.py").exists()
    assert _temp_extract_dirs(tmp_path) == []


def test_bundled_source_rejects_absolute_member(tmp_path: Path) -> None:
    archive = tmp_path / "tracelens_src.zip"
    escaped = tmp_path.parent / f"{tmp_path.name}-absolute-escape.py"
    _write_zip(
        archive,
        {
            "tracelens/__init__.py": b"",
            str(escaped): b"escaped",
        },
    )

    assert run_mod._extract_bundled_source(archive) is None
    assert not escaped.exists()
    assert _temp_extract_dirs(tmp_path) == []


def test_bundled_source_rejects_symlink(tmp_path: Path) -> None:
    archive = tmp_path / "tracelens_src.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("tracelens/__init__.py", b"")
        link = zipfile.ZipInfo("tracelens/link")
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        zf.writestr(link, "../../escaped.py")

    assert run_mod._extract_bundled_source(archive) is None
    assert _temp_extract_dirs(tmp_path) == []


def test_bundled_source_caps_member_count(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    archive = tmp_path / "tracelens_src.zip"
    _write_zip(
        archive,
        {
            "tracelens/__init__.py": b"",
            "tracelens/extra.py": b"",
        },
    )
    monkeypatch.setattr(run_mod, "_MAX_BUNDLED_SOURCE_FILES", 1)

    assert run_mod._extract_bundled_source(archive) is None
    assert _temp_extract_dirs(tmp_path) == []


def test_bundled_source_caps_uncompressed_size(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    archive = tmp_path / "tracelens_src.zip"
    _write_zip(archive, {"tracelens/__init__.py": b"1234"})
    monkeypatch.setattr(run_mod, "_MAX_BUNDLED_SOURCE_BYTES", 3)

    assert run_mod._extract_bundled_source(archive) is None
    assert _temp_extract_dirs(tmp_path) == []


def test_bundled_source_cleans_temp_dir_for_invalid_zip(tmp_path: Path) -> None:
    archive = tmp_path / "tracelens_src.zip"
    archive.write_bytes(b"not a zip")

    assert run_mod._extract_bundled_source(archive) is None
    assert _temp_extract_dirs(tmp_path) == []


def test_bundled_source_cleans_incomplete_archive(tmp_path: Path) -> None:
    archive = tmp_path / "tracelens_src.zip"
    _write_zip(archive, {"unrelated.py": b""})

    assert run_mod._extract_bundled_source(archive) is None
    assert not (tmp_path / "tracelens_src").exists()
    assert _temp_extract_dirs(tmp_path) == []


def test_bundled_source_extracts_valid_archive(tmp_path: Path) -> None:
    archive = tmp_path / "tracelens_src.zip"
    _write_zip(
        archive,
        {
            "tracelens/__init__.py": b"",
            "tracelens/launcher/run.py": b"VALUE = 1\n",
        },
    )

    extracted = run_mod._extract_bundled_source(archive)

    assert extracted == str(tmp_path / "tracelens_src")
    assert (Path(extracted) / "tracelens/launcher/run.py").read_text() == "VALUE = 1\n"
    assert _temp_extract_dirs(tmp_path) == []


@pytest.mark.parametrize("service", ["../../escape", "/absolute/path", "..", "///"])
def test_default_output_keeps_hostile_service_name_under_baselines(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, service: str
) -> None:
    monkeypatch.setenv("TRACELENS_HOME", str(tmp_path))
    monkeypatch.setenv("OTEL_SERVICE_NAME", service)

    output = Path(run_mod._default_output(["python", "app.py"]))
    baselines = (tmp_path / "baselines").resolve()

    assert output.resolve().is_relative_to(baselines)
    assert output.name == "trace.jsonl"
    assert output.parent.parent == baselines


@pytest.mark.parametrize("sample", ["-0.1", "1.1", "nan", "inf", "not-a-number"])
def test_parse_run_flags_rejects_invalid_sample_rate(sample: str) -> None:
    with pytest.raises(SystemExit, match="sample-rate"):
        run_mod._parse_run_flags(
            ["--output", "trace.jsonl", "--sample-rate", sample],
            user_command=["python", "app.py"],
        )


@pytest.mark.parametrize("sample", ["0", "0.5", "1"])
def test_parse_run_flags_accepts_sample_rate_boundaries(sample: str) -> None:
    parsed = run_mod._parse_run_flags(
        ["--output", "trace.jsonl", "--sample-rate", sample],
        user_command=["python", "app.py"],
    )

    assert parsed[2] == sample


def test_parse_run_flags_rejects_negative_summary_byte_cap() -> None:
    with pytest.raises(SystemExit, match="summary-byte-cap must be nonnegative"):
        run_mod._parse_run_flags(
            ["--output", "trace.jsonl", "--summary-byte-cap", "-1"],
            user_command=["python", "app.py"],
        )


def test_frozen_launcher_rejects_non_python_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(run_mod, "_is_frozen", lambda: True)
    monkeypatch.setattr(run_mod, "_external_target_python", lambda _user: None)

    with pytest.raises(SystemExit, match="frozen binaries require an explicit Python target"):
        run_mod._maybe_handoff_to_target_python(
            ["--", "uvicorn", "app:app"], ["uvicorn", "app:app"]
        )


def test_frozen_launcher_allows_explicit_python_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(run_mod, "_is_frozen", lambda: True)
    monkeypatch.setattr(run_mod, "_external_target_python", lambda _user: None)
    monkeypatch.setattr(run_mod, "_is_python_command", lambda _user: True)

    run_mod._maybe_handoff_to_target_python(["--", "python", "app.py"], ["python", "app.py"])
