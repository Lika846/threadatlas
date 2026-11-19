/**
 * Import issue codes.
 *
 * Privacy rule: issues carry codes, positions, field names and source IDs only.
 * Messages are static strings and are never built from imported content.
 */

export const ISSUE_DEFINITIONS = {
  // ---- File level: fatal, nothing is imported ---------------------------
  FILE_READ_FAILED: {
    level: "file",
    severity: "error",
    message: "The file could not be read.",
  },
  FILE_INCOMPLETE: {
    level: "file",
    severity: "error",
    message: "The upload was incomplete: fewer bytes arrived than were sent. Nothing was imported; please try again.",
  },
  FILE_TOO_LARGE: {
    level: "file",
    severity: "error",
    message: "The file is larger than the allowed upload size.",
  },
  FILE_EMPTY: {
    level: "file",
    severity: "error",
    message: "The file is empty.",
  },
  FILE_NOT_UTF8: {
    level: "file",
    severity: "error",
    message: "The file is not valid UTF-8 text.",
  },
  FILE_INVALID_JSON: {
    level: "file",
    severity: "error",
    message: "The file is not valid JSON.",
  },
  FILE_UNSUPPORTED_STRUCTURE: {
    level: "file",
    severity: "error",
    message:
      "Unsupported file structure: expected a ChatGPT conversations export (a JSON array of conversations).",
  },
  FILE_NO_CONVERSATIONS: {
    level: "file",
    severity: "error",
    message: "The export contains no conversations.",
  },
  FILE_TOO_DEEP: {
    level: "file",
    severity: "error",
    message: "The file is nested too deeply to be processed.",
  },

  // ---- Conversation level: that conversation is skipped ------------------
  CONVERSATION_NOT_OBJECT: {
    level: "conversation",
    severity: "error",
    message: "Skipped an entry that is not a conversation object.",
  },
  CONVERSATION_MAPPING_MISSING: {
    level: "conversation",
    severity: "error",
    message: "Skipped a conversation without a message mapping.",
  },
  CONVERSATION_MAPPING_INVALID: {
    level: "conversation",
    severity: "error",
    message: "Skipped a conversation whose message mapping is not an object.",
  },
  CONVERSATION_TOO_DEEP: {
    level: "conversation",
    severity: "error",
    message: "Skipped a conversation whose data is nested too deeply to process safely.",
  },
  CONVERSATION_ID_TOO_LONG: {
    level: "conversation",
    severity: "error",
    message:
      "Skipped a conversation whose ID is longer than 512 characters; it was not shortened or replaced.",
  },
  CONVERSATION_NODE_ID_TOO_LONG: {
    level: "conversation",
    severity: "error",
    message:
      "Skipped a conversation with a message node ID or parent reference longer than 512 characters; its message tree could not be reconstructed completely.",
  },
  CONVERSATION_ID_UNDERIVABLE: {
    level: "conversation",
    severity: "error",
    message:
      "Skipped a conversation that has no ID and too little content to derive a stable one.",
  },
  DUPLICATE_ID_SUPERSEDED: {
    level: "conversation",
    severity: "warning",
    message:
      "A conversation ID appeared more than once; the copy with the latest update time was kept and the other copies were skipped.",
  },

  // ---- Conversation level: flagged, not imported until resolved ---------
  DUPLICATE_ID_AMBIGUOUS: {
    level: "conversation",
    severity: "error",
    message:
      "A conversation ID appeared more than once and the newest copy could not be determined; all copies were flagged and none imported.",
  },
  CONVERSATION_ID_AMBIGUOUS: {
    level: "conversation",
    severity: "error",
    message:
      "Several conversations without IDs have identical content; they were flagged instead of being merged.",
  },
  CONVERSATION_ID_RESERVED: {
    level: "conversation",
    severity: "error",
    message:
      "A conversation ID uses the prefix reserved for derived IDs; it was flagged.",
  },

  // ---- Conversation level: accepted with a note -------------------------
  CONVERSATION_ID_DERIVED: {
    level: "conversation",
    severity: "warning",
    message:
      "A conversation had no ID; a deterministic ID was derived from its content.",
  },
  CONVERSATION_ID_MISMATCH: {
    level: "conversation",
    severity: "warning",
    message:
      "A conversation's conversation_id and id differ; conversation_id was used.",
  },
  FIELD_TOO_LONG: {
    level: "conversation",
    severity: "warning",
    message: "A conversation field was longer than 512 characters and was ignored.",
  },
  FIELD_INVALID_TYPE: {
    level: "conversation",
    severity: "warning",
    message: "A conversation field had an unexpected type and was ignored.",
  },

  // ---- Timestamps (A22, A30): conversation or node level, never fatal ---
  TIMESTAMP_INVALID: {
    level: "conversation",
    severity: "warning",
    message: "A timestamp was not a valid, representable time and was treated as missing.",
  },
  TIMESTAMP_UNUSUAL: {
    level: "conversation",
    severity: "warning",
    message: "A timestamp is unusually old or in the future; it was kept as exported.",
  },

  // ---- Visible path (A25) ----------------------------------------------
  CURRENT_NODE_NOT_IN_MAPPING: {
    level: "conversation",
    severity: "warning",
    message: "The conversation's current node is not in its mapping; a fallback path was used.",
  },
  PATH_FALLBACK: {
    level: "conversation",
    severity: "warning",
    message:
      "The visible path was chosen by a fallback rule and may not be the branch last viewed in ChatGPT.",
  },
  PATH_NONE: {
    level: "conversation",
    severity: "warning",
    message: "No visible path could be built for this conversation.",
  },
  PATH_CYCLE: {
    level: "conversation",
    severity: "warning",
    message: "The visible path ran into a cycle of parent links and was cut short.",
  },
  MULTIPLE_ROOTS: {
    level: "conversation",
    severity: "warning",
    message: "The conversation has more than one root node.",
  },
  TREE_CYCLE: {
    level: "conversation",
    severity: "warning",
    message: "Some nodes form a cycle of parent links and cannot be reached from a root.",
  },

  // ---- Node level (A24): node kept unless it is not an object -----------
  NODE_NOT_OBJECT: {
    level: "node",
    severity: "warning",
    message: "A mapping entry was not a node object and was dropped.",
  },
  NODE_REFERENCE_TOO_LONG: {
    level: "node",
    severity: "warning",
    message:
      "A node reference (a child entry or message ID) was longer than 512 characters and was ignored.",
  },
  NODE_ID_MISMATCH: {
    level: "node",
    severity: "warning",
    message: "A node's id differs from its mapping key; the key was used.",
  },
  NODE_PARENT_INVALID: {
    level: "node",
    severity: "warning",
    message: "A node's parent reference had an unexpected type; the node was treated as a root.",
  },
  NODE_PARENT_NOT_IN_MAPPING: {
    level: "node",
    severity: "warning",
    message:
      "A node's parent is not in the mapping; the reference was kept and the node treated as a root.",
  },
  NODE_CHILDREN_INVALID: {
    level: "node",
    severity: "warning",
    message: "A node's children list had an unexpected type or entries; they were ignored.",
  },
  NODE_CHILD_NOT_IN_MAPPING: {
    level: "node",
    severity: "warning",
    message: "A node lists a child that is not in the mapping.",
  },
  NODE_CHILD_PARENT_MISMATCH: {
    level: "node",
    severity: "warning",
    message: "A node lists a child whose parent is a different node; the child's parent was used.",
  },
  NODE_NOT_LISTED_BY_PARENT: {
    level: "node",
    severity: "warning",
    message: "A node's parent does not list it as a child; it was placed after the listed children.",
  },
  MESSAGE_MALFORMED: {
    level: "node",
    severity: "warning",
    message: "A message was malformed; it was kept and marked, with any recoverable text.",
  },
  MESSAGE_ROLE_MISSING: {
    level: "node",
    severity: "warning",
    message: "A message had no valid author role; it was kept without one.",
  },
  CONTENT_UNSUPPORTED: {
    level: "node",
    severity: "warning",
    message:
      "A message contained unsupported content; a placeholder was shown and the original content was kept.",
  },

  // ---- Persistence (M1.4): comparison with the stored copy ---------------
  CONVERSATION_REPROCESSED: {
    level: "conversation",
    severity: "info",
    message:
      "The stored copy was rebuilt with a newer parser version; its source data was identical.",
  },
  CONVERSATION_OLDER: {
    level: "conversation",
    severity: "warning",
    message:
      "The file contains an older copy of a stored conversation; the stored copy was kept.",
  },
  CONVERSATION_VERSION_AMBIGUOUS: {
    level: "conversation",
    severity: "error",
    message:
      "A stored conversation differs from the copy in the file, and their update times are missing, invalid or equal; it was flagged and the stored copy was kept.",
  },
  CONVERSATION_PARSER_DOWNGRADE: {
    level: "conversation",
    severity: "error",
    message:
      "A stored conversation was written by a newer ThreadAtlas parser than this one; it was flagged and the stored copy was kept.",
  },
  CONVERSATION_STATE_UNRECOGNISED: {
    level: "conversation",
    severity: "error",
    message:
      "A stored conversation has an unrecognised content-hash or parser version; it was flagged and the stored copy was kept.",
  },
  CONVERSATION_PERSIST_FAILED: {
    level: "conversation",
    severity: "error",
    message:
      "A conversation could not be saved because of a database error; any stored copy was kept unchanged.",
  },
} as const satisfies Record<
  string,
  {
    level: "file" | "conversation" | "node";
    /** "info" notes a normal event (e.g. a parser refresh); it does not make an import "with warnings". */
    severity: "error" | "warning" | "info";
    message: string;
  }
>;

export type IssueCode = keyof typeof ISSUE_DEFINITIONS;
export type FileErrorCode = {
  [K in IssueCode]: (typeof ISSUE_DEFINITIONS)[K]["level"] extends "file"
    ? K
    : never;
}[IssueCode];

export function issueMessage(code: IssueCode): string {
  return ISSUE_DEFINITIONS[code].message;
}

export function issueSeverity(code: IssueCode): "error" | "warning" | "info" {
  return ISSUE_DEFINITIONS[code].severity;
}

/**
 * Import-level outcomes (M1.4). Not tied to a conversation, so they are not
 * issue codes. A database error is reported with its `DbErrorCode`
 * (`src/lib/db/errors.ts`) instead.
 */
export const IMPORT_ERROR_DEFINITIONS = {
  IMPORT_BUSY: {
    message: "Another import or delete is in progress. Try again when it has finished.",
  },
  IMPORT_LOCK_FAILED: {
    message: "The import lock could not be acquired safely, so nothing was imported.",
  },
  IMPORT_INTERRUPTED: {
    message:
      "This import stopped before it finished (for example, the app was closed). Import the same file again to finish it.",
  },
  IMPORT_SUMMARY_UNAVAILABLE: {
    message:
      "The import ran, but its result could not be read from the database. The Last import section shows the stored result once the database can be read.",
  },
  IMPORT_CONFIG_INVALID: {
    message: "The import size limit (IMPORT_MAX_BYTES) is not configured correctly, so nothing was imported.",
  },
  IMPORT_PARSER_VERSION_INVALID: {
    message: "This ThreadAtlas build has an invalid parser version, so nothing was imported.",
  },
} as const satisfies Record<string, { message: string }>;

export type ImportErrorCode = keyof typeof IMPORT_ERROR_DEFINITIONS;
