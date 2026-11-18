import pytest

from backend import settings as team_settings


@pytest.fixture(autouse=True)
def isolated_settings(tmp_path, monkeypatch):
    """Tests never read or write the team's real config/team-settings.json."""
    store = team_settings.Store(tmp_path / 'team-settings.json')
    monkeypatch.setattr(team_settings, 'store', store)
    return store
