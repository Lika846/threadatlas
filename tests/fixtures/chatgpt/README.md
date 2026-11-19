# Synthetic ChatGPT export fixtures

**Every file here is hand-written, fictional data.** Never place real ChatGPT exports,
excerpts of them, or "anonymised" real conversations in this directory (decisions
A7/A18, D13/D23).

Rules, enforced by `tests/fixture-policy.test.ts`:

- Only `.json` fixtures (plus this README) live here.
- Each fixture is a JSON array. **Every object entry carries `"_synthetic": true`.**
- Each file is at most 32 KiB.
- Text and titles contain the word `canary`, so tests can assert that no content leaks
  into issue reports. IDs never contain it.

The marker and the checks are **safeguards, not proof** that data is fictional. Whoever
adds a fixture is responsible for writing it by hand.

The shape follows the *commonly observed* export structure (an array of conversations
with `title`, `create_time`/`update_time`, `mapping`, `current_node`, `conversation_id`).
That structure is an assumption (plan §3, R17), not a verified schema.

| File | Purpose |
| --- | --- |
| `linear.json` | One linear conversation: structural root, hidden system message, user, assistant |
| `branching.json` | Regenerated answers and an edited user message (several branches); `current_node` on one branch |
| `missing-fields.json` | Missing `current_node`, missing title/timestamps, explicit `null` title, wrong-typed optional fields |
| `content-types.json` | `multimodal_text` with an image part, `code`, an unknown content type, tool message, hidden system message |
| `structural-anomalies.json` | Dangling parent, cycle, child missing from the mapping, key ≠ `node.id`, parent/children disagreement, multiple roots (for M1.2) |
| `duplicate-ids.json` | Same ID twice: newer wins; tied update time; missing update time |
| `id-fallback.json` | `id` only; no IDs (derived); identical ID-less pair (ambiguous); underivable; wrong-typed/blank `conversation_id`; mismatch; reserved prefix |
| `invalid-entries.json` | Non-object entries, missing/array/null mapping, plus one valid conversation |
| `unknown-fields.json` | Many unknown fields at conversation, node and message level (future export version) |
| `regenerated.json` | Three regenerated answers with `current_node` on the middle one; the same without `current_node` (latest answer is not the last listed) |
| `path-fallback.json` | `current_node` missing from the mapping; no timestamps (`last_child`); invalid and unrepresentable leaf times; tied leaf times; a cycle with no root (`none`); ISO vs numeric times |
| `malformed-messages.json` | Message as a bare string, a number, an empty object; content as a string; missing `content_type`; `text` instead of `parts`; missing or non-object author; unknown role; non-object node, invalid `children`, numeric `parent` |
| `unsupported-content.json` | Unknown types (payload only, with `text`, with `parts`), object part in `text`, multimodal with image and audio parts, code with and without language, HTML-like code, an unsafe type name, `execution_output` |
| `hidden-messages.json` | Empty and non-empty system messages, an explicitly hidden user message, hidden flag as the string `"true"` and as `false`, a tool message |
