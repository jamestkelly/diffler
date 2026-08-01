import { readFile } from "node:fs/promises";

import { quizDocumentJsonSchema } from "../src/quiz.js";

const source = new URL("../schemas/quiz-document.schema.json", import.meta.url);
const checkedInSchema: unknown = JSON.parse(await readFile(source, "utf8"));

if (
  JSON.stringify(checkedInSchema) !== JSON.stringify(quizDocumentJsonSchema)
) {
  throw new Error(
    "Quiz schema is stale; run pnpm schema:write and commit the result",
  );
}
