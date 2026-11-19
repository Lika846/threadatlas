# Source of `guidelines.md`

`guidelines.md` is an unmodified copy of `command.md` from Vercel Labs' Web Interface
Guidelines, pinned so that reviews are reproducible and nothing is fetched at review time.

| | |
| --- | --- |
| Repository | https://github.com/vercel-labs/web-interface-guidelines |
| File | `command.md` |
| Commit | `434b7f91364665f2f733b310ec54809bf8f37937` (main, 2026-10-05) |
| Last change to the file | `4ecfb9fb8d1d3b7009674869b3aaee2f904042e1` ("Add desktop overscroll guideline") |
| SHA-256 | `d246b026f4f29b5823a9cc857f9edf3d2507002e055e32040cadeaf3b38e0234` |
| Licence | MIT, Copyright (c) 2025 Vercel Labs (`LICENSE` in this folder) |
| Copied | 2026-11-18 |

The upstream skill that uses these rules is `web-design-guidelines` in
https://github.com/vercel-labs/agent-skills. It downloads the rules from the `main` branch on
every run; this project skill replaces that download with the pinned copy. `SKILL.md` and
`react-flow-checklist.md` are ThreadAtlas's own files, not part of Vercel's work.

**Check the copy:** `shasum -a 256 .claude/skills/web-interface-review/guidelines.md`

**Update it deliberately:** download `command.md` at a new commit, read the diff against
`guidelines.md`, replace the file, and update the commit, date and SHA-256 above in the same
commit.
