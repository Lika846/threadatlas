/**
 * The message a URL fragment points at (M2.3 polish). Search results link to
 * `/conversations/<id>[?page=N]#m-<number>`, where `m-<number>` is the id of a
 * message heading in `MessageView`. Pure: only the exact `#m-<positive integer>`
 * form is accepted, so the result is always a safe element id (never a CSS
 * selector or anything taken from the fragment as-is).
 */
const LINKED_MESSAGE = /^#m-([1-9][0-9]{0,8})$/;

export function linkedMessageId(hash: string): string | null {
  const m = LINKED_MESSAGE.exec(hash);
  return m ? `m-${m[1]}` : null;
}
