# Fork Patches

This branch (`fork-patches`) tracks customizations to OpenClaw for personal
agent instances (Midas, Mentor, etc.). It is not tied to any single agent.

## Current Base

`v2026.3.14` (upstream `openclaw/openclaw`, rebased 2026-03-15)

## Active Patches

### 1. Aligned table rendering mode for Discord

**Commit:** `ee58c8e9f`
**Files:** `src/config/types.base.ts`, `src/config/zod-schema.core.ts`,
`src/config/markdown-tables.ts`, `src/markdown/ir.ts`
**Upstream PR:** None filed

Discord's default table rendering (code blocks or bullets) looks bad. This adds
a new `MarkdownTableMode = "aligned"` set as the default for Discord channels.

- **Narrow tables (≤60 chars):** Aligned code block — space-padded columns with
  Unicode box-drawing separator (`─`). Styles stripped so monospace alignment holds.
- **Wide tables (>60 chars):** Emoji-card format — each row becomes a card with
  the first column as a bold title and remaining columns as emoji-prefixed lines.
  A pattern matcher (~35 categories) assigns semantic emojis to column headers
  (e.g. "Price" → 💰, "Status" → 🔄). Unmatched headers get colored square
  fallbacks. Renders as regular Discord text so bold/italic/links work.

Also fixes the Discord chunker eating blank lines between cards.

**Drop when:** Submitted and merged upstream, or feature becomes unwanted.

---

### 2. Z.AI SSE ping filter

**Commit:** `92fa5ff27`
**Files:** `src/agents/pi-embedded-utils.ts`,
`src/agents/pi-embedded-helpers/errors.ts`
**Upstream PR:** None filed

Z.AI's streaming API sends SSE keep-alive ping messages that leaked into actual
AI response content. The stream parser now detects and discards these events.

**Drop when:** Z.AI fixes their API, or submitted and merged upstream.

---

### 3. Fork CI workflows

**Commit:** `63882194a`
**Files:** `.github/workflows/fork-build.yml`,
`.github/workflows/sync-upstream.yml`

- `fork-build.yml`: Builds on every push to `fork-patches`. Fetches upstream
  tags for accurate patch counting. Publishes tarball as GitHub Release tagged
  `fork-v{VERSION}-p{COUNT}`.
- `sync-upstream.yml`: Rebases `fork-patches` onto `upstream/main` daily at
  8am UTC. Uses Claude Code CLI for automated conflict resolution. Creates a
  GitHub Issue with manual resolution steps if both rebase and LLM fail.
  Uses `FORK_PAT` secret for push (required for upstream workflow file changes).

**Drop when:** Never (infrastructure patch, always needed).

---

## Dropped Patches (absorbed by upstream)

| Patch                                      | Absorbed in                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| pi-ai `chunk.choices` guard (dep patch)    | `pi-ai@0.58.0` -- upstream now uses `chunk.choices?.[0]` (optional chaining). Patch file and postinstall script removed 2026-03-16.                  |
| contextTokens refresh on model switch      | `v2026.3.x` -- upstream merged as #38044 (`fix(sessions): clear stale contextTokens on model switch`). Fork patch dropped during 2026-03-15 rebase.  |
| Config contextWindow overrides MODEL_CACHE | `v2026.2.19` -- upstream independently implemented `applyConfiguredContextWindows()` and `applyDiscoveredContextWindows()` with identical semantics. |
| Anthropic Sonnet 4.6 model support         | `v2026.2.15`                                                                                                                                         |

---

## Upgrading to a New Upstream Version

When upstream cuts a new release (e.g. `v2026.2.21`):

**If the daily sync handled it cleanly (no conflicts):**
The rebase ran automatically, the build triggered, and a new tarball is already
in GitHub Releases. Skip to the deploy step.

**If there were conflicts (GitHub Issue was created):**

```bash
# On your development machine:
cd ~/dev/midas/openclaw
git fetch upstream --tags
git checkout fork-patches
git rebase upstream/main
# Resolve any conflicts — check FORK-PATCHES.md to understand what each patch does
git rebase --continue
git push --force-with-lease origin fork-patches
# GitHub Actions builds and publishes the new tarball automatically
```

**Deploy to agents:**

```bash
ssh -i ~/.ssh/hetzner root@46.224.62.76

# Check current version
openclaw --version

# Get the latest release URL from GitHub, then:
npm install -g https://github.com/michaelbship/openclaw/releases/download/fork-v2026.2.XX-pN/openclaw-2026.2.XX.tgz

# Restart the gateway (adjust to whatever process manager is in use)
openclaw --version  # verify
```

**Reviewing patches after a new upstream version:**
Check whether any active patches have been absorbed. For each patch, run:

```bash
git diff v{NEW_VERSION}..fork-patches -- {files-for-that-patch}
```

If the diff is empty, the patch was absorbed — remove its commits from the
branch and update this file.

---

## Rollback

The pre-rebase state is preserved as:

- Branch: `backup/midas-patches-pre-rebase`
- Tag: `backup/remote-tip-2026-02-19`

To restore:

```bash
git push origin backup/midas-patches-pre-rebase:fork-patches --force-with-lease
```
