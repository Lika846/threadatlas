# Limitations and known issues

Everything known to be missing, approximate or surprising in this release. The most important
ones are summarised in the [README](../README.md#limitations).

## All limitations

- The npm scripts use POSIX inline env syntax (`VAR=1 cmd`). On Windows, use
  WSL or run `npx next telemetry disable` once.
- The CSP allows `'unsafe-inline'` scripts because App Router hydration needs it
  without a nonce setup. Imported content must still never be rendered as raw
  HTML.
- E2E tests run in Chromium only; no Firefox/WebKit coverage yet.
- Conversations without a `conversation_id` or `id` get an identifier derived
  from their content (`derived:v1:…`). If such a conversation is edited or
  continued, it gets a new derived ID, so re-importing it creates a **duplicate**
  rather than updating the earlier copy. No fuzzy matching is attempted in this
  version.
- Conversations nested deeper than 512 JSON object/array levels are skipped
  with `CONVERSATION_TOO_DEEP` (real exports nest about 10 levels). See
  `docs/import-format.md`.
- External IDs longer than 512 characters are never shortened. A conversation whose
  own ID, a mapping key or a `parent` reference is that long is skipped as a whole, so
  no conversation is stored with part of its message tree missing. Oversized child
  entries, message IDs and `current_node` are ignored with a warning. See
  `docs/import-format.md`.
- No automated accessibility audit yet: the tests check landmarks, headings, the skip link,
  keyboard order, focus, reduced motion, 200% zoom and measured colour contrast. Not tested
  with a real screen reader, Safari, Firefox or touch devices.
- Conversations are shown along the branch that was
  open in ChatGPT, or a best guess when the export doesn't say. Other branches are marked
  but can't be opened yet. Long conversations are shown 1,000 messages per page.
- Importing needs JavaScript (the file is sent as the request body). Imports must come
  from the ThreadAtlas page itself: requests from other sites or other local ports are
  refused.
- Importing a file near the 50 MiB limit raises the server's memory use by about
  0.5–0.6 GiB (about 0.7 GiB in total); the server keeps that memory afterwards, and
  several large imports in a row can bring it to about 0.9 GiB. Restarting the app frees it.
- If you close the tab during an import, the import still finishes; open the Import page
  again to see the result under *Last import*.
- **One import or delete at a time per database**, across processes: a second import,
  delete-all or storage cleanup waits up to about 1 second for the lock, then gets "busy"
  until the first finishes. (The wait covers the semantic indexer's short commits.) The lock is a file next to the
  database (`data/threadatlas.db.lock`) and is reliable only on a **local** disk, not on
  a network drive. Don't delete it while the app runs.
- Imports are not instant: about 23 s for a 30 MiB export of 2,000 conversations on the
  development Mac (an unchanged re-import about 1.3 s). The database driver is
  synchronous, so the server pauses for up to about 0.1 s between conversations and up
  to about 0.6 s on a single very large conversation (20,000 messages).
- An import that stops early (crash, closed app, full disk) keeps every conversation it
  finished and is reported as "Accounted for X of Y; Z not accounted for". Importing the
  same file again completes it safely.
- A stored conversation without a valid `update_time` can't be updated by a changed copy:
  the new copy is flagged instead. An older export never overwrites newer stored data.
- When a re-import replaces a conversation, the old version's text can stay in unused
  database pages until the space is reused or the file is compacted (delete-all compacts
  it). Secure deletion during imports is not enabled.
- If a database transaction could not be closed cleanly (rare; a failed rollback),
  ThreadAtlas stops writing: the operation that hit it reports its own error, and from
  then on every import, delete-all and storage cleanup reports "Restart ThreadAtlas to
  continue" and changes nothing. Restart the app (stop `npm run start` or `npm run dev` and
  start it again). If an import was running, the next import marks it as interrupted,
  and importing the same file again completes it. Until the restart, the database can stay
  locked for other programs.
- Delete-all and storage cleanup need JavaScript and must come from the ThreadAtlas
  Settings page itself. If another program keeps the database open in a read transaction,
  they can wait up to 5 seconds and then report "busy"; try again.
- Deleting imported data is best effort against copies outside the database file (see
  [guide.md](guide.md#deleting-your-data)).
- Markdown is rendered for assistant messages only, and only the common subset (see
  [guide.md](guide.md#markdown-support)). ChatGPT's export menu can change; the first-run steps
  link to OpenAI's own instructions.
- **Search index.** The database also holds a full-text index of every imported message
  and title, hidden messages and other branches included. It stores words, not
  sentences, and it adds roughly half the size of the message text (measured on
  synthetic data). It makes imports about a quarter slower, and re-imports that replace
  conversations about a third slower. After such an import the index is compacted
  while the import still holds the lock, which pauses the server for about 0.3 s per
  50,000 messages. Until then, the replaced text's words stay in the index. Afterwards,
  pieces can stay in unused database space until it is reused or compacted. Delete-all
  empties the index and checks it.
- Keyword matching is by whole word, ignoring case and accents. Chinese or Japanese text
  written without spaces, "ss" for "ß", Greek without accents, emoji and other word forms
  ("run" vs "running", or Russian "сеть" vs "сети") are not matched; `*` after the shared
  start of a word helps. Punctuation is ignored, so `C++` also finds
  "C#".
- Search covers titles and the messages a conversation shows by default; words only in
  hidden messages or other branches are not found. A short prefix that matches most
  words (such as `th*`) can pause the server for about half a second on 50,000
  messages (measured on synthetic data).
- A search result links to a message by its position. If the conversation is re-imported
  with a different path after you searched, the link can point to another message;
  searching again fixes it. A deleted conversation shows "Conversation not found".
- After pulling this version, run `npm run db:deploy` to add the search index to your
  database (it also indexes the conversations you already imported). Until then,
  delete-all refuses with "not migrated" and deletes nothing.
- **Semantic model.** The ONNX Runtime package is pinned to 1.23.2, the last
  release with macOS Intel binaries, and adds about 250 MB to `node_modules`, mostly
  other platforms' binaries. Starting the model takes about 1.5–2.5 s, most of it the
  SHA-256 check of the 135 MB model files. The model is used only for indexing.
- **Semantic index.** After pulling this version, run `npm run db:deploy` to
  add the three index tables. Until then, an import stops with "not migrated" before
  storing any conversation (it now queues conversations for indexing; the attempt is
  recorded as a failed import), and delete-all refuses with "not migrated" and deletes
  nothing. The index's limitations are in [guide.md](guide.md#indexing-for-meaning).
- **Search by meaning.**
  - **The small model's weak spot:** queries in one language whose answer sits in
    another, buried in a long conversation, are its clearest weakness (Experiment 2).
    Exact words still find them.
  - **Speed:** results are computed in memory over every stored vector, which takes
    tens of milliseconds at 50,000 chunks (ADR 0002 sets a revisit threshold of about
    100,000 chunks).
  - **Very short messages** ("ok", "thanks!", anything under about 5–6 words) count only
    when a conversation has nothing longer: otherwise they match almost any short query
    and crowd out real answers. A conversation whose only meaningful message is that
    short ranks after longer matches.
  - **Relevance figures** come from small synthetic research sets, not from your data.
- **Semantic indexing.** The inference process is started from the source tree
  (`src/lib/semantic/inference-child.ts`), so `npm run start` must run from the project
  folder (as for the database). A normal stop gives the interrupted conversation's attempt
  back through Next.js's default shutdown handling; a kill or crash counts it.
- "No data leaves the machine" is a design property (no network code, CSP, telemetry off).
  The test suites check it by observation (a browser request guard and connection
  sampling), which can't prove zero network traffic.
- **Map groups** come from a small model's vectors, and their settings were chosen on synthetic
  conversations written by one person (`docs/spikes/mindmap/`). They still need checking on a
  real archive.
  - **Broad themes:** with at most 15 themes, some are broader than you'd draw them (career,
    study and family together, on one test set).
  - **English names:** theme names come from a fixed English list, even for a theme of Norwegian
    conversations.
  - **Language detection** knows English, Norwegian and Russian only. Ukrainian and other
    Cyrillic text counts as Russian. German or Spanish can be read as English when they share
    short words ("in", "is").
  - **Small languages:** when every conversation in a small language is on one subject,
    factoring out that language's average also removes the subject. A language found in only one
    conversation is not factored out.
  - **Memory:** computing the grouping needs about 36 MB at 3,000 conversations; only the result
    is kept.
  - **Attribution:** the map shows the React Flow attribution link (the library's licence asks
    for it; the link goes to the library's site only if clicked).
- **Related conversations** use an experimental threshold (0.35) chosen on synthetic
  conversations embedded with the real model (`docs/spikes/graph/`): about 8% of links were
  wrong there, and about one in
  nine conversations with related ones got none. It is not yet checked on a real or a much
  larger archive, where the similarity scale may differ. Long conversations that drift between
  subjects are averaged into one vector and may match nothing.
- **Repeated text** (templates, boilerplate, a standard pasted prompt) is recognised by its
  text, ignoring case and spacing: it counts once in the averages, and text found in 10 or
  more conversations doesn't count toward their meaning (unless it is all a conversation has,
  so identical conversations still match). The cutoff of 10 is a heuristic, not tuned on real
  data. Reworded boilerplate isn't recognised this way;
  as an explaining passage it is still skipped when it is close enough (similarity 0.9) to
  copies in 3 or more unrelated conversations.
