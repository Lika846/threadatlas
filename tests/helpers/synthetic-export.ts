/**
 * Generated synthetic ChatGPT exports for persistence tests (M1.4). Every
 * value is invented here; nothing derives from a real export.
 */

export type SyntheticOptions = {
  id: string;
  /** Message nodes after the structural root (default 3). */
  messages?: number;
  /** `update_time` in epoch seconds; null omits it. Default 1_767_225_600. */
  updateTime?: number | null;
  title?: string;
  /** Prefix of every message text (e.g. a version tag or a canary). */
  tag?: string;
  /** Characters per message text (default: short). */
  textLength?: number;
  /** Extra conversation-level fields (e.g. unknown fields). */
  extra?: Record<string, unknown>;
  /** Extra fields on every node and on every message. */
  nodeExtra?: Record<string, unknown>;
  messageExtra?: Record<string, unknown>;
};

export const BASE_TIME = 1_767_225_600;

function text(tag: string, k: number, length?: number): string {
  const base = `${tag} synthetic message ${k}. `;
  if (length === undefined) return base.trim();
  return base.repeat(Math.ceil(length / base.length)).slice(0, length);
}

/** A linear conversation: a structural root, then alternating user/assistant messages. */
export function syntheticConversation(o: SyntheticOptions): Record<string, unknown> {
  const messages = o.messages ?? 3;
  const tag = o.tag ?? "v1";
  const mapping: Record<string, unknown> = {
    root: { id: "root", parent: null, children: messages > 0 ? ["n1"] : [], message: null, ...o.nodeExtra },
  };
  for (let k = 1; k <= messages; k++) {
    mapping[`n${k}`] = {
      id: `n${k}`,
      parent: k === 1 ? "root" : `n${k - 1}`,
      children: k < messages ? [`n${k + 1}`] : [],
      message: {
        id: `m${k}`,
        author: { role: k % 2 === 1 ? "user" : "assistant" },
        create_time: BASE_TIME + k,
        content: { content_type: "text", parts: [text(tag, k, o.textLength)] },
        status: "finished_successfully",
        ...o.messageExtra,
      },
      ...o.nodeExtra,
    };
  }
  const conv: Record<string, unknown> = {
    conversation_id: o.id,
    title: o.title ?? `Synthetic ${o.id}`,
    create_time: BASE_TIME,
    current_node: messages > 0 ? `n${messages}` : "root",
    mapping,
    ...o.extra,
  };
  if (o.updateTime !== null) conv.update_time = o.updateTime ?? BASE_TIME;
  return conv;
}

export function exportText(conversations: unknown[]): string {
  return JSON.stringify(conversations);
}

/** `count` conversations of `messages` messages each. */
export function syntheticExport(count: number, opts: Omit<SyntheticOptions, "id"> & { idPrefix?: string } = {}): unknown[] {
  const { idPrefix = "conv", ...rest } = opts;
  return Array.from({ length: count }, (_, i) => syntheticConversation({ ...rest, id: `${idPrefix}-${i}` }));
}
