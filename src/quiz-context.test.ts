import { describe, expect, it } from "vitest";

import {
  parseQuizContext,
  validateQuizAgainstContext,
} from "./quiz-context.js";
import { parseQuizDocument } from "./quiz.js";

describe("Feature: quiz binding to diff context", () => {
  it("Scenario: every source cites an included changed head-side line", () => {
    // Given
    const quiz = quizDocument();
    const context = diffContext();

    // When
    const validate = () => validateQuizAgainstContext(quiz, context, context);

    // Then
    expect(validate).not.toThrow();
  });

  it("Scenario: the branch changed after context collection", () => {
    // Given
    const quiz = quizDocument();
    const context = diffContext();
    const current = parseQuizContext({
      ...context,
      comparison: { ...context.comparison, headSha: "b".repeat(40) },
      diffHash: "c".repeat(64),
    });

    // When
    const validate = () => validateQuizAgainstContext(quiz, context, current);

    // Then
    expect(validate).toThrowError(/context is stale/);
  });

  it("Scenario: quiz metadata belongs to another diff", () => {
    // Given
    const quiz = parseQuizDocument({
      ...quizDocument(),
      diffHash: "d".repeat(64),
    });
    const context = diffContext();

    // When
    const validate = () => validateQuizAgainstContext(quiz, context, context);

    // Then
    expect(validate).toThrowError(/metadata does not match/);
  });

  it("Scenario: a question cites an unchanged line", () => {
    // Given
    const original = quizDocument();
    const quiz = parseQuizDocument({
      ...original,
      questions: [
        {
          ...original.questions[0],
          sources: [{ path: "source.ts", startLine: 11, endLine: 11 }],
        },
      ],
    });
    const context = diffContext();

    // When
    const validate = () => validateQuizAgainstContext(quiz, context, context);

    // Then
    expect(validate).toThrowError(/not an included changed line/);
  });

  it("Scenario: stored context chunks are modified", () => {
    // Given
    const original = quizDocument();
    const quiz = parseQuizDocument({
      ...original,
      questions: [
        {
          ...original.questions[0],
          sources: [{ path: "source.ts", startLine: 99, endLine: 99 }],
        },
      ],
    });
    const current = diffContext();
    const context = parseQuizContext({
      ...current,
      files: [
        {
          path: "source.ts",
          chunks: [
            {
              kind: "hunk",
              section: 1,
              part: 1,
              text: "@@ -99 +99 @@\n-old\n+forged\n",
            },
          ],
        },
      ],
    });

    // When
    const validate = () => validateQuizAgainstContext(quiz, context, current);

    // Then
    expect(validate).toThrowError(/not an included changed line/);
  });
});

function quizDocument() {
  return parseQuizDocument({
    schemaVersion: 1,
    repository: { name: "fixture" },
    baseRef: "main",
    headSha: "a".repeat(40),
    diffHash: "b".repeat(64),
    title: "Fixture quiz",
    questions: [
      {
        type: "short_answer",
        id: "changed-line",
        prompt: "Which behavior changed?",
        required: true,
        points: 1,
        sources: [{ path: "source.ts", startLine: 12, endLine: 12 }],
        correctAnswers: ["guardrail"],
        feedback: { general: "The guardrail is new." },
      },
    ],
  });
}

function diffContext() {
  return parseQuizContext({
    schemaVersion: 1,
    repository: { name: "fixture" },
    comparison: { baseRef: "main", headSha: "a".repeat(40) },
    diffHash: "b".repeat(64),
    limits: {
      maxPatchBytes: 200_000,
      maxChunkBytes: 32_000,
      excludePaths: [],
    },
    files: [
      {
        path: "source.ts",
        chunks: [
          {
            kind: "hunk",
            section: 1,
            part: 1,
            text: "@@ -10,3 +10,4 @@\n unchanged\n unchanged again\n+guardrail\n unchanged\n",
          },
        ],
      },
    ],
  });
}
