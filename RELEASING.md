# Release checklist

This folder has not been published by this repair. A local build or passing
tests do not confirm PyPI publication or live paid API compatibility.

1. The public repository is `https://github.com/zelnum/zelnum-python`
   (organization `zelnum`). Confirm the URLs in `pyproject.toml` and README still
   point there — PyPI metadata cannot be edited after a file is uploaded, so a
   wrong owner or repository name would only be fixable with a new version.
   This local folder has no `.git` directory yet; run `git init` and add the
   remote before using GitHub Actions.
2. Run tests: `python -m pip install -e '.[dev]'`, then `python -m pytest -q`.
   With an authorized test account, smoke-test phone/email realtime and bulk
   against the deployed API. Confirm deductions, retries and downloads. Do not
   commit API keys or personal contact data. Unit tests use mocked responses.
3. Install `build` and `twine`. Build into an empty output directory with
   `python -m build --outdir release-dist`, run
   `python -m twine check --strict release-dist/*`, then
   `python scripts/check_dist.py release-dist`.
4. Configure [PyPI Trusted Publishing](https://docs.pypi.org/trusted-publishers/adding-a-publisher/).
   For the first release use a
   [pending publisher](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/).
   Project: `zelnum`; owner/repository: `zelnum/zelnum-python`;
   workflow: `ci.yml`; environment: `pypi`. Create the GitHub `pypi` environment
   and configure release approval protection where available.
5. Only when ready to publish, push a `vVERSION` tag matching both
   `pyproject.toml` and `src/zelnum/__init__.py`. **Pushing this tag starts the
   publication workflow.** Tests and build checks must pass before publishing
   the same verified artifacts. PyPI will not let you overwrite an existing
   release file; use a new version if that release already exists.
6. After publication, install from PyPI in a clean environment, check
   `zelnum --version`, inspect the rendered README and all Project links, and
   check the downloaded wheel's metadata. Recheck all links after release.

## Website links and SEO evidence (2026-09-28)

README and package metadata link only to `https://zelnum.com` (the canonical
apex) and `https://docs.zelnum.com`. `scripts/check_dist.py` fails the build if
`app.zelnum.com` or `www.zelnum.com` appears in published metadata:

- **`app.zelnum.com` is the Console** — a login-gated operations app, not a
  marketing surface. It is not promoted from any published artifact.
- **`www.zelnum.com` 301-redirects to the apex**, so link weight would be sent
  through a redirect. Use the apex.

Re-verify with `curl -sS -o /dev/null -w "%{http_code} %{redirect_url}"` before
writing any URL into package metadata: it must return 200 with no redirect.

**Do not promise a dofollow backlink from PyPI.** A direct inspection of the
public [HTTPX project page](https://pypi.org/project/httpx/) found
`rel="nofollow"` on its Homepage and Documentation project links, and
`rel=nofollow` on README external links. The
[Warehouse discussion](https://github.com/pypi/warehouse/issues/8974) also
documents this behavior. Link attributes are controlled by PyPI, not by our
README or metadata. This is evidence about current platform rendering, not a
post-publication audit of the Zelnum page.

Publishing can serve developer discovery, documentation access, AI retrieval
(crawlers that answer questions do not read `rel`) and referral traffic.
Indexing, ranking benefits, and third-party directory replication are not
guaranteed. Audit any third-party page's actual HTML and indexing status before
describing it as a dofollow backlink. Avoid duplicate packages made solely for
links. This Python project has no `package.json` or Node-RED node; npm/Node-RED
publication needs its own working integration and audit.

**GitHub links are nofollow as well.** Measured 2026-09-28 on live pages: README
body external links on `psf/requests` (6/6) and `encode/httpx` (15/15), the
repository About sidebar website link, and the organization profile website link
all carry `rel="nofollow"`. GitHub is still worth doing — for developer
distribution, source-of-truth trust, brand entity recognition and AI retrieval
(crawlers that answer questions do not read `rel`) — but not as link equity.

## Adding other language SDKs later

Decided 2026-09-28: one repository per language under the `zelnum` organization,
named `<brand>-<language>`. Measured convention — stripe, twilio, openai and
resend all publish separate repositories (`stripe-python`, `stripe-java`,
`stripe-php`, `stripe-node`); `stripe-sdk` does not exist and `{brand}/python-sdk`
naming returns 404 for 6/6 brands checked. The organization page is the family
showcase, so a multi-language monorepo buys little and costs: one repository
would hold the publish rights of every ecosystem (PyPI Trusted Publishing binds
to `owner/repo`, not to a subdirectory), tags would have to become
`python-v0.1.0`, and CI would need path filters or every PHP commit would run the
Python matrix.

**Maven Central (Java):** the free `io.github.<username>` namespace is only
granted to the GitHub **user** account used to sign up — Sonatype states that
`io.github.<github organization name>` is not available automatically. Register
`com.zelnum` and verify it with a DNS TXT record on `zelnum.com` instead
(Cloudflare, a few minutes).
