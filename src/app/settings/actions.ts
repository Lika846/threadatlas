"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { isDeleteConfirmed } from "@/lib/data/confirmation";
import { deleteAllImportedData, finishStorageCleanup } from "@/lib/data/delete-all";
import {
  cleanupResultState,
  CONFIRMATION_REQUIRED_MESSAGE,
  deleteResultState,
  INTERNAL_ERROR_MESSAGE,
  REQUEST_REJECTED_MESSAGE,
  type SettingsActionState,
} from "@/lib/data/messages";
import { checkServerActionRequest } from "@/lib/request-guards";

/**
 * Settings Server Actions (M1.7, A11, A81). Each one checks the request
 * itself first (loopback Host, exact Origin, Sec-Fetch-Site, then
 * Next-Action as a supplementary check), because Next.js's own check lets a
 * missing Origin, `Sec-Fetch-Site: cross-site` and the no-JavaScript form
 * path through (step 0). Arguments are untrusted: an action can be called
 * directly with any values. Nothing is logged; errors become fixed messages.
 */

let seq = 0;
const next = () => (seq = (seq + 1) % Number.MAX_SAFE_INTEGER);

async function requestAllowed(): Promise<boolean> {
  try {
    return checkServerActionRequest(await headers()).ok;
  } catch {
    return false;
  }
}

const rejected = (): SettingsActionState => ({ outcome: "rejected", tone: "error", code: "REQUEST_FORBIDDEN", message: REQUEST_REJECTED_MESSAGE, seq: next() });
const internal = (): SettingsActionState => ({ outcome: "rejected", tone: "error", code: "INTERNAL_ERROR", message: INTERNAL_ERROR_MESSAGE, seq: next() });

export async function deleteAllAction(_prev: SettingsActionState, formData: unknown): Promise<SettingsActionState> {
  if (!(await requestAllowed())) return rejected();
  const phrase = formData instanceof FormData ? formData.get("confirm") : null;
  if (!isDeleteConfirmed(phrase)) {
    return { outcome: "rejected", tone: "error", code: "CONFIRMATION_REQUIRED", message: CONFIRMATION_REQUIRED_MESSAGE, seq: next() };
  }
  try {
    const state = deleteResultState(await deleteAllImportedData(), next());
    revalidatePath("/", "layout");
    return state;
  } catch {
    return internal();
  }
}

/** Never deletes records, whatever it is called with: it takes no input. */
export async function finishCleanupAction(): Promise<SettingsActionState> {
  if (!(await requestAllowed())) return rejected();
  try {
    const state = cleanupResultState(await finishStorageCleanup(), next());
    revalidatePath("/", "layout");
    return state;
  } catch {
    return internal();
  }
}
