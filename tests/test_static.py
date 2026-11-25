"""The server shows the app, and only the app."""
import pytest

import server


@pytest.fixture
def web():
    return server.app.test_client()


@pytest.mark.parametrize('path', ['/', '/index.html', '/app.js', '/call.js', '/style.css', '/socket.io.min.js'])
def test_app_files_are_served(web, path):
    assert web.get(path).status_code == 200


@pytest.mark.parametrize('path', ['/server.py', '/requirements.txt', '/.gitignore', '/.git/config', '/tests/helpers.py', '/../server.py'])
def test_private_files_are_not_served(web, path):
    assert web.get(path).status_code == 404