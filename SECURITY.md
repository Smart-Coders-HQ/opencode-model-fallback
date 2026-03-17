# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

To report a security vulnerability, email us at **blazej@smartcoders.xyz** with the subject line `[SECURITY] opencode-model-fallback`.

Please include:

- A description of the vulnerability and its potential impact
- Steps to reproduce the issue
- Any suggested mitigations or fixes

You should receive a response within **72 hours**. If you do not hear back, please follow up via email.

We will:

1. Acknowledge receipt of your report
2. Investigate and confirm the vulnerability
3. Work on a fix and release a patched version
4. Credit you in the release notes (unless you prefer to remain anonymous)

## Scope

This security policy covers the `opencode-model-fallback` plugin code. It does not cover:

- Third-party dependencies (report those to the respective projects)
- The OpenCode runtime itself
- Issues requiring physical access to your machine

## Known Security Considerations

- **Config file permissions**: The plugin reads config from `~/.config/opencode/model-fallback.json` and agent config directories. Ensure these paths have appropriate permissions (readable only by your user).
- **Log files**: Log files stored in `~/.local/share/opencode/logs/` may contain model usage metadata. They are created with `0o600` permissions (owner read/write only).
- **YAML parsing**: Agent config files with YAML frontmatter are parsed with the CORE schema, which disallows executable YAML types.

Thank you for helping keep opencode-model-fallback secure.
