import { CopyButton } from "@/components/copy-button";
import { NOTE } from "@/components/styles";
import type { ModelState } from "@/lib/semantic/index/service";
import { E5_SMALL_MANIFEST } from "@/lib/semantic/model-manifest";

/**
 * What to do when the local language model is missing or doesn't match (phase 3): what it is
 * for, the one command that installs it, and what that command does on the network. Shown on
 * the home page and the Import page; static text only.
 */

const COMMAND = "npm run model:fetch";
const sizeMB = Math.round(E5_SMALL_MANIFEST.files.reduce((n, f) => n + f.size, 0) / 1e6);

export function ModelHelp({ state }: { state: Exclude<ModelState, "ok"> }) {
  return (
    <div className={NOTE.warning} data-testid="model-help">
      <p className="font-medium">
        {state === "missing"
          ? "Indexing needs the local language model, which isn't installed yet."
          : state === "invalid"
            ? "The local language model's files don't match the approved version."
            : "The model folder setting (THREADATLAS_MODEL_DIR) isn't valid: it must be an absolute path."}
      </p>
      {state !== "dir-invalid" && (
        <>
          <p className="mt-2">
            Search by meaning, the map and related conversations use a small multilingual model (multilingual-e5-small, about {sizeMB} MB)
            that runs on this computer. Install it once by running this command in the ThreadAtlas folder, then reload this page:
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <code className="rounded bg-white px-2 py-1 font-mono text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">{COMMAND}</code>
            <CopyButton text={COMMAND} label="Copy command" />
          </div>
          <p className="mt-2">
            It downloads the pinned model files from Hugging Face and checks each one against its checksum: the only download ThreadAtlas itself
            makes. Already have the files? <code className="font-mono">{COMMAND} -- --from &lt;folder&gt;</code> copies them instead.
          </p>
        </>
      )}
    </div>
  );
}
