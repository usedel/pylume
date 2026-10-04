"""共享 fixture：隔离的 probe home + 默认配置。"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parent.parent / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from pylume_probe.config import ProbeConfig  # noqa: E402


@pytest.fixture()
def cfg(tmp_path: Path) -> ProbeConfig:
    return ProbeConfig(db_dir=str(tmp_path / "traces"))
