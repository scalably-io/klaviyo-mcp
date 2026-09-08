# Changelog

## 1.0.0

- First public release.
- Derived from: `container/tools/klaviyo-mcp` at `ef174fc3` (2026-08-31) in the private ScalablyAI repository.
- Changes from production: the private tool-outcome envelope is replaced by a plain JSON reply, tool annotations added (all 24 tools read-only), the reply wrapper rewritten as a readable `withReply` function with the same error, partial and no-op classification, no functional change.
- Build changes: `fastmcp` 4 and `zod` 4 (production ran the 3.x lines); a shebang line so the npm `bin` runs; the e2e test uses `localhost` and the current protocol version.
