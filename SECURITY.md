# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately by emailing
[security@pkgstory.dev](mailto:security@pkgstory.dev) or using
[GitHub's private vulnerability reporting](https://github.com/starhaven-io/pkgstory/security/advisories/new).
Do not open a public issue for an undisclosed vulnerability.

Include the affected component, version, or commit; reproduction steps; potential
impact; and any suggested mitigation. We will acknowledge the report,
investigate it, and coordinate disclosure with you.

## Supported versions

pkgstory is a continuously deployed service. Security fixes are applied to the
current deployment; older revisions are not supported.

## Security boundaries

Homebrew repository content and history are untrusted input. pkgstory reads blobs
with Git plumbing and parses package definitions as text; it must never execute
formula or cask DSL. Package paths are accepted only from documented tap roots,
and one pinned Git revision supplies history, blobs, presence, and replacement
metadata for a crawl window.

Raw author email fields are used only to derive stable hashed contributor keys.
They are not persisted in the public read model, and email-shaped author names
are replaced before storage and export.

Catalog-wide pages use precomputed KV payloads. Public request paths may issue
indexed, per-package D1 queries but must not scan the full catalog. GitHub Actions
and Cloudflare credentials are production control-plane secrets; workflow
permissions and generated installation tokens must remain explicit and minimal.
