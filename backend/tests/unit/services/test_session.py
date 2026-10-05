from __future__ import annotations

import pytest

from app.services.session import SessionService, SessionServiceError

pytestmark = pytest.mark.unit


def test_update_credentials_rejects_username_rename(isolated_db):
    del isolated_db
    service = SessionService()
    token = service.login(username="admin", password="admin123")["token"]

    with pytest.raises(SessionServiceError) as excinfo:
        service.update_credentials(
            token=token,
            current_password="admin123",
            username="renamed",
            password="newpass123",
        )
    assert excinfo.value.status_code == 400
    assert "fixed" in str(excinfo.value)

    # Nothing changed: existing session survives and credentials still work.
    assert service.check(token=token)["user"] == "admin"
    with pytest.raises(SessionServiceError):
        service.login(username="renamed", password="newpass123")
    assert service.login(username="admin", password="admin123")["username"] == "admin"


def test_update_credentials_still_validates_password_before_rename_check(isolated_db):
    del isolated_db
    service = SessionService()
    token = service.login(username="admin", password="admin123")["token"]

    # Wrong current password is reported as a credential failure, not a rename error.
    with pytest.raises(SessionServiceError) as excinfo:
        service.update_credentials(
            token=token,
            current_password="wrongpass",
            username="renamed",
            password="newpass123",
        )
    assert excinfo.value.status_code == 403

    # Unauthenticated rename attempt cannot inspect the stored username.
    with pytest.raises(SessionServiceError) as excinfo:
        service.update_credentials(
            token="bogus-token",
            current_password="admin123",
            username="renamed",
            password="newpass123",
        )
    assert excinfo.value.status_code == 401


def test_update_credentials_allows_password_change_with_same_username(isolated_db):
    del isolated_db
    service = SessionService()
    token = service.login(username="admin", password="admin123")["token"]

    result = service.update_credentials(
        token=token,
        current_password="admin123",
        username="admin",
        password="newpass123",
    )
    assert result["reauth_required"] is True

    # All sessions were wiped by the credential update.
    with pytest.raises(SessionServiceError) as excinfo:
        service.check(token=token)
    assert excinfo.value.status_code == 401

    # The new password works with the unchanged username.
    assert service.login(username="admin", password="newpass123")["username"] == "admin"