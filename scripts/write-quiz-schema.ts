import { writeFile } from "node:fs/promises";

import { quizDocumentJsonSchema } from "../src/quiz.js";

const destination = new URL(
  "../schemas/quiz-document.schema.json",
  import.meta.url,
);
await writeFile(
  destination,
  `${JSON.stringify(quizDocumentJsonSchema, null, 2)}\n`,
);
