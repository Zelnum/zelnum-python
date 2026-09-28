"""Verify release artifacts, first-party links, and optional vVERSION tag."""

import ast
import os
import sys
import tarfile
import zipfile
from email.parser import Parser
from pathlib import Path


def main():
    folder = Path(sys.argv[1] if len(sys.argv) > 1 else "dist")
    wheels = list(folder.glob("*.whl"))
    sdists = list(folder.glob("*.tar.gz"))
    assert len(wheels) == len(sdists) == 1, "Expected exactly one wheel and one sdist"
    with zipfile.ZipFile(wheels[0]) as wheel:
        metadata = wheel.read(next(n for n in wheel.namelist() if n.endswith("/METADATA"))).decode()
        assert "zelnum/py.typed" in wheel.namelist()
        source = wheel.read("zelnum/__init__.py").decode()
        version = next(ast.literal_eval(node.value) for node in ast.parse(source).body
                       if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "__version__" for t in node.targets))
    with tarfile.open(sdists[0]) as sdist:
        name = next(n for n in sdist.getnames() if n.endswith("/PKG-INFO"))
        sdist_metadata = sdist.extractfile(name).read().decode()
        assert any(n.endswith("/README.md") for n in sdist.getnames())
    for content in (metadata, sdist_metadata):
        parsed = Parser().parsestr(content)
        assert parsed["Name"] == "zelnum"
        assert parsed["Version"] == version
        assert parsed["Description-Content-Type"] == "text/markdown"
        urls = parsed.get_all("Project-URL")
        for url in ("Homepage, https://zelnum.com", "Pricing, https://zelnum.com/pricing/", "Documentation, https://docs.zelnum.com"):
            assert url in urls, f"Missing project link: {url}"
        for url in ("https://zelnum.com", "https://docs.zelnum.com"):
            assert f"]({url})" in parsed.get_payload(), f"Missing README link: {url}"
        # The Console is a login-gated operations app, not a marketing surface:
        # it must never be promoted from published artifacts. www is a 301 to
        # the apex, so it must not appear as a link target either.
        blob = content + parsed.get_payload()
        for forbidden in ("app.zelnum.com", "www.zelnum.com"):
            assert forbidden not in blob, f"Forbidden link target in published metadata: {forbidden}"
    if os.environ.get("GITHUB_REF", "").startswith("refs/tags/"):
        assert os.environ["GITHUB_REF"] == f"refs/tags/v{version}", "Tag/package version mismatch"
    print(f"Validated wheel + sdist {version}: metadata, README links, typed marker and version")


if __name__ == "__main__":
    main()
