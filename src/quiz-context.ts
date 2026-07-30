import { z } from "zod";

import type { QuizDocument } from "./quiz.js";

const contextSchema = z.object({
  schemaVersion: z.literal(1),
  repository: z.object({
    name: z.string().min(1),
    remote: z.string().min(1).optional(),
  }),
  comparison: z.object({
    baseRef: z.string().min(1),
    headSha: z.string().min(1),
  }),
  diffHash: z.string().min(1),
  limits: z.object({
    maxPatchBytes: z.number().int().positive(),
    maxChunkBytes: z.number().int().positive(),
    excludePaths: z.array(z.string()),
  }),
  files: z.array(
    z.object({
      path: z.string().min(1),
      chunks: z.array(
        z.object({
          kind: z.enum(["metadata", "hunk"]),
          section: z.number().int().nonnegative(),
          part: z.number().int().positive(),
          text: z.string(),
        }),
      ),
    }),
  ),
});

export type QuizContext = z.infer<typeof contextSchema>;

export class QuizContextError extends Error {
  override readonly name = "QuizContextError";
}

export function parseQuizContext(input: unknown): QuizContext {
  const result = contextSchema.safeParse(input);
  if (!result.success) {
    throw new QuizContextError("Diff context document is invalid");
  }
  return result.data;
}

export function validateQuizAgainstContext(
  quiz: QuizDocument,
  context: QuizContext,
  current: QuizContext,
): void {
  if (
    current.comparison.headSha !== context.comparison.headSha ||
    current.diffHash !== context.diffHash ||
    current.comparison.baseRef !== context.comparison.baseRef ||
    JSON.stringify(current.repository) !== JSON.stringify(context.repository) ||
    current.limits.maxPatchBytes !== context.limits.maxPatchBytes ||
    current.limits.maxChunkBytes !== context.limits.maxChunkBytes ||
    JSON.stringify(current.limits.excludePaths) !==
      JSON.stringify(context.limits.excludePaths)
  ) {
    throw new QuizContextError(
      "Diff context is stale; collect context again before validating or publishing",
    );
  }
  if (
    JSON.stringify(quiz.repository) !== JSON.stringify(current.repository) ||
    quiz.baseRef !== current.comparison.baseRef ||
    quiz.headSha !== current.comparison.headSha ||
    quiz.diffHash !== current.diffHash
  ) {
    throw new QuizContextError(
      "Quiz metadata does not match the collected diff context",
    );
  }

  const changedLines = new Map(
    current.files.map((file) => [file.path, addedLines(file.chunks)]),
  );
  for (const question of quiz.questions) {
    for (const source of question.sources) {
      const lines = changedLines.get(source.path);
      if (
        lines === undefined ||
        !lines.some(
          (line) => line >= source.startLine && line <= source.endLine,
        )
      ) {
        throw new QuizContextError(
          `Question ${question.id} source is not an included changed line: ${source.path}:${source.startLine}-${source.endLine}`,
        );
      }
    }
  }
}

interface ContextChunk {
  kind: "metadata" | "hunk";
  section: number;
  part: number;
  text: string;
}

function addedLines(chunks: readonly ContextChunk[]): number[] {
  const patch = [...chunks]
    .sort(
      (left, right) => left.section - right.section || left.part - right.part,
    )
    .map((chunk) => chunk.text)
    .join("");
  const lines: number[] = [];
  let newLine: number | null = null;

  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header?.[1] !== undefined) {
      newLine = Number(header[1]);
      continue;
    }
    if (newLine === null || line.startsWith("\\")) {
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      lines.push(newLine);
      newLine += 1;
    } else if (!line.startsWith("-")) {
      newLine += 1;
    }
  }
  return lines;
}
