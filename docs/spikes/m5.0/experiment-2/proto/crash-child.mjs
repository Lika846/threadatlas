// Child process for the hard-kill scenario: indexes and prints "commit" after each committed job.
import { Indexer, openDb } from "./indexer.mjs";
const [projectDir, rt, modelDir, file] = process.argv.slice(2);
const db = openDb(projectDir, file);
const ix = new Indexer({ db, rt, modelDir, onProgress: () => process.stdout.write("commit\n") });
await ix.run();
await ix.close();
db.close();
