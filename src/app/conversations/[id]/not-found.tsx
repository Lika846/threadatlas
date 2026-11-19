import Link from "next/link";
import { LINK } from "@/components/styles";


/**
 * Shown for an unknown or deleted conversation (M2.3), for example a search
 * result opened after delete-all. Says nothing about which id was asked for.
 */
export default function ConversationNotFound() {
  return (
    <>
      <h1 className="text-3xl font-semibold tracking-tight">Conversation not found</h1>
      <p className="mt-4 max-w-prose">
        This conversation no longer exists. It may have been deleted, or the link may be out of date.
      </p>
      <ul className="mt-6 flex flex-wrap gap-6">
        <li>
          <Link href="/search" className={LINK}>
            Search again
          </Link>
        </li>
        <li>
          <Link href="/conversations" className={LINK}>
            All conversations
          </Link>
        </li>
      </ul>
    </>
  );
}
