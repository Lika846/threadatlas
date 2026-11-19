# Using ThreadAtlas

A guide to each part of the app: the first run, indexing, search, the map, reading, related
conversations and deleting your data. Setup is in the [README](../README.md#installation); the
full list of limitations is in [limitations.md](limitations.md).

## Getting started in the app

The home page guides a first run in four steps that check themselves off from the archive's real
state, with one main action at a time:

1. **Get your ChatGPT export:** in ChatGPT, Settings → Data controls, then **Export** under
   *Export data*, and confirm. Unzip the file from the email and use `conversations.json`. See
   [OpenAI's export instructions](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data).
2. **Import it** on the Import page.
3. **Index for meaning.** If the local model isn't installed (or its files don't match), the
   home page and the Import page say so and show the one command, `npm run model:fetch`, with
   a copy button.
4. **Explore:** the map, search and all conversations.

It also serves returning users:
- **Partly indexed:** continue indexing; what is ready can already be explored.
- **A new import waiting:** indexing comes back as the next step.
- **Everything indexed:** the map is the main action.

After an import, the Import page links straight to indexing.

## The semantic model

Semantic retrieval uses `multilingual-e5-small` (MIT; see the README's *Licence and credits*) at a pinned revision, run locally
with ONNX Runtime in a worker thread (ADR 0002). The app never downloads it. Install it
explicitly:

```bash
npm run model:fetch                      # from huggingface.co, pinned revision
npm run model:fetch -- --from <dir>      # or copy from a local folder (offline)
```

- **Files:** the four model files (135.4 MB) go to `data/models/multilingual-e5-small/`
  (git-ignored). Set `THREADATLAS_MODEL_DIR=/absolute/path` to use another folder.
- **Verification:** each file is checked against the size and SHA-256 in
  `src/lib/semantic/model-manifest.ts` before it is moved into place, and again when the
  model is loaded. A mismatch is refused.
- **No network afterwards:** loading the model, chunking and embedding make no network
  requests.
- **Optional:** without the model ThreadAtlas works exactly as before; the Import page shows
  how to install it. It is used only when you index and search by meaning.
- **Where it runs:** in a separate Node process that ThreadAtlas starts for an indexing
  run and that exits when the run ends. The Next.js server itself never loads ONNX
  Runtime, so a crash of the model's native code cannot take the app down.

## Indexing for meaning

The index core is in `src/lib/semantic/index/` (design:
`docs/m5.1b-semantic-index-design.md`). It adds three tables (migration
`20261111120000_semantic_index`, additive only; run `npm run db:deploy` after pulling):

- `EmbeddingIndex`: one row (`id = 'main'`) with the model configuration, an epoch and
  counters; no imported data. Created at the first indexing run, kept by delete-all.
- `EmbeddingStatus`: one row per conversation (`pending`, `running`, `indexed` or
  `failed`), kept after success.
- `EmbeddingChunk`: one int8 vector (388 bytes) per chunk with its message id and
  character offsets. **No message text is stored**; a chunk's text is always read from
  the message.

What already happens in this version:

- **Import:** every conversation that an import adds or replaces is queued for indexing
  in the same transaction, and its old vectors are deleted (unchanged, older and flagged
  copies change nothing).
- **Delete all imported data** also deletes every vector and status row and checks that
  none remain.

Indexing from **Import → Semantic index** (below the import form, so it is the next step after an import):

- **Manual only.** Nothing is indexed until you press **Start indexing**: not at startup,
  not after an import, not after *Retry failed*. The model must be installed
  (`npm run model:fetch`); the page says so if it is not.
- **Start / Resume:** indexes every conversation that is not indexed yet, one at a time,
  in a separate inference process (about 0.8 GB of memory while it runs, all returned
  when it ends). The panel shows indexed, waiting, in-progress and failed counts and
  refreshes every 2 seconds while the page is open. Leaving or reloading the page does not
  stop the run. One run at a time per database: a second ThreadAtlas process is told that
  another one is indexing.
- **Pause:** stops after the current batch (well under a second). The conversation in
  progress goes back to the queue; nothing partial is stored.
- **Retry failed:** gives conversations that failed three times (or were too large) three
  new attempts at the next Start.
- **Stopping ThreadAtlas while indexing** (Ctrl-C, or the default SIGTERM of a service
  manager) is safe: the conversation in progress returns to the queue without using up an
  attempt, and the inference process finishes its batch and exits. If ThreadAtlas is
  killed instead (SIGKILL, a crash), the Import page shows *interrupted* and the next Start
  continues; that conversation's attempt is counted.
- **Failures:** a conversation that makes the inference process crash, or hang for two
  minutes, fails that run; after three runs it is marked failed and later runs skip it.
  The app and keyword search keep working throughout.
- Imports and *Delete all imported data* can run during indexing: a replaced or deleted
  conversation's vectors are never stored or kept.

Limitations:

- A conversation with more than 20,000 chunks (about 1.3 million tokens), or a single
  message over 1,000,000 characters, is never indexed semantically
  (`CONVERSATION_TOO_LARGE`); keyword search still finds it.
- Vectors replaced by a re-import are deleted without `secure_delete`; their bytes can
  remain in free database pages until the next *Delete all imported data* (the same as
  replaced message text).
- Only one indexing process per database (an indexer lock next to the database file,
  `<database>.index-lock`, empty, mode 0600).

## Searching

Search has two modes:

- **By meaning** (the default once conversations are indexed on the Import page): finds
  conversations about what you describe, in any language, even when they use other words.
  - **Ranking:** conversations that also contain every word you typed rank higher. This
    is reciprocal rank fusion with the exact-word results, used only when those words
    match (ADR 0002 decision 7).
  - **Generic passages count for less:** a passage's score is reduced by half its average
    similarity to about 150 everyday subjects, so text that resembles everything a little (template
    advice, an essay paragraph, a riddle) doesn't crowd out real matches. Measured on synthetic
    sets: nDCG@10 0.840 → 0.852, 0.828 → 0.866 and 0.556 → 0.596 (`docs/spikes/search-v3/`).
  - **Results:** the close matches first: conversations whose similarity is within 0.03 of
    the best match, and every conversation that contains all your words. The rest, up to 50
    in total, stays in the same ranking under **Other results**, which opens on the same page
    without searching again. Each result shows the passage that matched, links to its
    message, and says why it matched ("Similar meaning", "Matches your words" or both).
  - **The cutoff:** on the synthetic research sets, close matches hold 80–91% of the relevant
    conversations among about 3–6 results. A broad query can leave many conversations within
    the margin.
  - **When it can't run** (the model is not installed, nothing is indexed yet, or the
    index was built with another model), the page uses exact words and says why. When
    some conversations are not indexed yet, it says how many: they appear only when the
    exact words match.
  - **The model:** the first search after a pause loads the model into a separate process
    (a few seconds; about 0.8 GB). It stays loaded while you search and exits after 5
    minutes without a search. Later searches take milliseconds.
  - **Privacy:** the query is embedded locally and is never logged.
- **Exact words** (keyword search, below), unchanged.

**Exact words** looks through conversation titles and the messages each conversation shows.
Every word must match; use `"quotes"` for an exact phrase and `*` after the last word
for words that start with it (at least two letters first). Matching ignores case and
accents. Each result shows where the words were found, with the matches highlighted, and
which message matched best ("Best match: message 1,351"). Opening it scrolls to that
message and outlines it, also after Back and Forward. Search needs JavaScript.

**What happens to what you type.** ThreadAtlas does not intentionally persist, log or put
your search terms in URLs:

- They are sent to the local server in the body of a POST request, never in the address,
  so they are not in your browser history or bookmarks. The search box asks the browser
  not to remember entries (`autocomplete="off"`).
- The page keeps the last query and page number in memory only, so Back from a
  conversation can run the search again. A reload forgets them. Nothing is written to
  cookies, localStorage, sessionStorage or IndexedDB.
- The server does not log queries or results. `next dev` would normally print every
  Server Action call with its arguments; this is turned off in `next.config.ts` and
  checked by a test that reads the dev server's output.
- Responses are sent with `Cache-Control: no-store`.

This is not a guarantee that search terms can't be seen anywhere: they are visible, like
any request, in the browser's developer tools and in the request body sent to the local
server.

## Map

**Map** (in the main navigation) groups your conversations by similar meaning into **themes**
and, within them, **topics**, using the vectors the semantic index already stored. Nothing is
sent anywhere, nothing is stored, and no model runs.

- **Three panels** (wide screens):
  - **Themes:** a list of every theme. The selected theme opens to its topics, and **Also in this
    theme** lists its conversations that belong to no topic. **Other** and **Not grouped yet**
    are at the end.
  - **The map:** your conversations in the centre, the themes around them, and the selected
    theme's topics beside it (up to 12, then a link to the rest).
  - **The selection's conversations:** the first 50, then **Show all**.
- **Selecting:** click a theme or topic in the list or on the map. Both always show the same
  thing, and the selection is in the address (`/map?theme=…&topic=…`), so Back, reload and
  bookmarks keep it. Drag to pan, scroll or pinch to zoom; the controls zoom or fit the whole map.
  Selecting never zooms out so far that labels become unreadable.
- **Keyboard and screen readers:**
  - Every theme and topic is a link: Tab moves through them in reading order, and Enter selects.
  - The map has no other focus stops, and a focused item out of view is brought into view.
  - The side panel announces what it shows.
  - With reduced motion, the view changes without animation.
- **Phones and 200% zoom:** the list comes first. Selecting shows that theme's or topic's
  conversations, and **Map** shows the map. Everything works without JavaScript except the map.
- **How groups are made:**
  - **Language factored out:** each message's language is detected (English, Norwegian and
    Russian are recognised; other text counts as "other"). Each language's average vector is
    subtracted from that language's passages, so conversations on one subject in different
    languages can meet. Without it, groups split by language first.
  - **One tree, cut twice:** the most similar conversations are joined first (average-linkage
    hierarchical clustering).
    - **Topics:** the joining stops at the smallest distance between 0.65 and 0.85 that leaves at
      most 15% of conversations on their own.
    - **Themes:** a coarser cut of the same tree, the finest that leaves at most 15 themes, so
      every topic is inside one theme. With 15 topics or fewer, themes and topics are the same.
    - **Other:** conversations close to no other.
    - Titles are not used for grouping.
  - **Names:**
    - A theme takes the nearest of about 30 broad subject names ("Food and cooking"), matched by
      the local model, each name used once.
    - A topic shows the titles of its two most typical conversations.
    - Without the precomputed name vectors, a theme is named by its title words (filler words
      removed in English, Norwegian and Russian).
  - **Chosen on synthetic sets** (`docs/spikes/mindmap/v3/`).
- **Speed:** the grouping is prepared in the background when indexing finishes, kept in memory
  until the semantic index, a title or the grouping settings change, and its slowest part (the
  tree) runs in a worker thread, so the rest of the app stays responsive. Measured with 3,000
  synthetic conversations on the development Mac:
  - **First map right after indexing:** about 3 s, while other pages answer within 62 ms.
  - **After restarting the server:** about 6 s the first time, with other pages held for up
    to 1.5 s while the vectors and message languages are read.
  - **Every later visit:** about 30 ms.
  - While the grouping is being prepared, the map page shows **Preparing the map…**.
- **k-means baseline:** **Compare with the k-means baseline** (`/map?method=kmeans`) shows the
  earlier one-level grouping (about √n groups, at most 12, without the language correction), for
  comparison.
- **The groups are a rough guide, not categories.** They can mix subjects and can change after
  you import or index more conversations. Conversations that aren't indexed yet are listed under
  **Not grouped yet**; index them on the Import page.

## Reading a conversation

- **Your messages** are shown exactly as you typed them, in a tinted block.
- **Assistant messages** are shown as formatted reading text: headings, lists, tables, code
  blocks, emphasis and links, rendered from their Markdown by a small renderer in ThreadAtlas (see *Markdown support* below).
  - Raw HTML in a message stays visible as text and is never interpreted.
  - Links work only for `http`, `https` and `mailto` addresses and open in a new tab
    without sending a referrer. Anything else, including relative links, is shown as text.
  - Images are never loaded; they appear as **[Image: …]**, so opening a conversation never
    makes the browser fetch anything.
  - Very long messages (over 100,000 characters) are shown as plain text.
- **Code and tool output** keep their exact text.
- **Related conversations:** on wide screens they sit in a column beside the conversation. On
  phones, and for screen readers and the keyboard, the conversation comes first, with a link to
  them near the top.

### Markdown support

The renderer (`src/lib/markdown/parse.ts`) covers what chat assistants usually write. Anything it
doesn't support is shown as the text that was written, never as HTML.

| Supported | Not supported (shown as text) |
| --- | --- |
| Headings (`#` to `######`), shown below the message's own heading | Setext headings (underlined with `===`) |
| Paragraphs; a single line break is kept, as in chat | Indented code blocks (4 spaces) |
| Fenced code blocks (``` or ~~~) with a language label, also inside list items | Raw HTML, including `<br>` and `<details>` |
| Bullet and numbered lists, nested by indentation, with a start number | HTML entities (`&amp;` is shown as typed) |
| Block quotes, horizontal rules | Reference-style links and footnotes |
| Pipe tables with alignment; inline formatting and code in cells; `\|` for a pipe | Task-list checkboxes, maths (`$…$`) |
| Bold, italic, both nested, strikethrough, inline code, backslash escapes | Images: shown as **[Image: alt text]**, never loaded |
| Links, `<autolinks>` and bare `http(s)://` URLs, to `http`, `https` and `mailto` only | Other link targets (`javascript:`, `data:`, relative links…): their text only |

- **Safety:** the parser produces a tree that is rendered as React elements; nothing is ever
  inserted as HTML. A link's text never contains another link. Links open in a new tab with
  `noopener noreferrer` and no referrer.
- **Bounded work:** parsing takes linear time in the message's length (the worst inputs found in
  review are timed by the tests), and messages over 100,000 characters are shown as plain text.
- **Tests:** `src/lib/markdown/parse.test.ts` (syntax, about 20 hostile URL forms, timing) and
  `src/components/markdown.test.tsx` (hostile messages and 2,000 random ones rendered to HTML).

## Related conversations

Each conversation page has a **Related conversations** section: up to five conversations
close to it in meaning, most similar first, with links. It is experimental and computed from
the semantic index; nothing is stored, sent anywhere or run through a model.

- **How:** the same language-corrected conversation vectors as the map (so
  conversations on one subject in different languages can be related), compared by cosine
  similarity. Only conversations at or above 0.35 are listed, so a conversation close to no
  other shows **No close conversations**; there are no forced matches.
- **Why related:** for most links, a disclosure shows one passage from each conversation that
  explains the link, as plain text, each linked to its message. A passage is chosen for being
  close to both conversations. Boilerplate (a passage repeated in 3 or more unrelated
  conversations, such as "I hope this helps! Let me know if…") is never shown. When no passage
  is informative, the link is listed without one.
- **States:** before indexing, and for a conversation that isn't indexed yet (or has no text),
  the section says so and links to the Import page. It works without JavaScript.
- **Speed:** the vectors are prepared once per index state (the same pass as the experimental
  topics, including reading the message text for language detection) and kept in memory; each
  page then takes a few milliseconds.

## Deleting your data

Settings → **Delete all imported data** removes every imported conversation, message and
import record from the local database (`data/threadatlas.db`). Type `DELETE` to confirm;
it cannot be undone. Your original export file is not touched.

The deletion happens in one transaction: either everything is deleted or nothing is. The
search index is emptied in the same transaction.
Then the database file is compacted (SQLite `VACUUM`, with `secure_delete` on during the
deletion), so that deleted text does not stay in it. The page says separately whether
the records were deleted and whether that cleanup finished and passed its checks. If
cleanup was interrupted (for example, the app was closed), use **Finish storage
cleanup**: it never deletes records and is safe to repeat.

This cleanup is **best effort**. It cannot erase copies the operating system or disk may
keep: unlinked journal or temporary-file blocks, APFS snapshots, SSD blocks, and backups
such as Time Machine. For stronger protection, use FileVault, and delete the database file
itself (`data/threadatlas.db` and its `-journal` file, with the app stopped) if you need
the data gone from the disk. Details: [import-format.md](import-format.md), *Deleting imported data*.
