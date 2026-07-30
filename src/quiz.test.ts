import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  parseQuizDocument,
  quizDocumentJsonSchema,
  QuizValidationError,
} from "./quiz.js";

const source = { path: "src/example.ts", startLine: 10, endLine: 12 };
const feedback = { whenRight: "Correct", whenWrong: "Try again" };
const metadata = {
  schemaVersion: 1,
  repository: { name: "example/project" },
  baseRef: "origin/main",
  headSha: "0123456789abcdef0123456789abcdef01234567",
  diffHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  title: "Example quiz",
};

function documentWithQuestion(question: unknown): unknown {
  return { ...metadata, questions: [question] };
}

function multipleChoice(overrides: Record<string, unknown> = {}): unknown {
  return {
    type: "multiple_choice",
    id: "question-one",
    prompt: "What changed?",
    required: true,
    points: 1,
    sources: [source],
    options: ["First", "Second"],
    correctAnswers: ["First"],
    feedback,
    ...overrides,
  };
}

describe("Feature: quiz document validation", () => {
  it("Scenario: an agent supplies every supported question type", () => {
    // Given
    const fixture = JSON.parse(
      readFileSync(new URL("../examples/quiz.json", import.meta.url), "utf8"),
    );

    // When
    const document = parseQuizDocument(fixture);

    // Then
    expect(document.questions.map((question) => question.type)).toEqual([
      "multiple_choice",
      "checkbox",
      "dropdown",
      "short_answer",
    ]);
  });

  it("Scenario: an agent supplies an unsupported question type", () => {
    // Given
    const input = documentWithQuestion(multipleChoice({ type: "essay" }));

    // When
    const parse = () => parseQuizDocument(input);

    // Then
    expect(parse).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("questions[0].type"),
      }),
    );
  });

  it("Scenario: an agent supplies a choice question without options", () => {
    // Given
    const input = documentWithQuestion(multipleChoice({ options: [] }));

    // When
    const parse = () => parseQuizDocument(input);

    // Then
    expect(parse).toThrowError(QuizValidationError);
  });

  it("Scenario: an answer is not one of the available options", () => {
    // Given
    const input = documentWithQuestion(
      multipleChoice({ correctAnswers: ["Missing"] }),
    );

    // When
    const parse = () => parseQuizDocument(input);

    // Then
    expect(parse).toThrowError(
      /Correct answer is not present in options: Missing/,
    );
  });

  it("Scenario: a choice question repeats an option", () => {
    // Given
    const input = documentWithQuestion(
      multipleChoice({ options: ["First", "First"] }),
    );

    // When
    const parse = () => parseQuizDocument(input);

    // Then
    expect(parse).toThrowError(/Options must be unique/);
  });

  it("Scenario: a single-valued question accepts alternative correct answers", () => {
    // Given
    const input = documentWithQuestion(
      multipleChoice({ correctAnswers: ["First", "Second"] }),
    );

    // When
    const document = parseQuizDocument(input);

    // Then
    expect(document.questions[0]?.correctAnswers).toEqual(["First", "Second"]);
  });

  it("Scenario: an agent assigns no points to a question", () => {
    // Given
    const input = documentWithQuestion(multipleChoice({ points: 0 }));

    // When
    const parse = () => parseQuizDocument(input);

    // Then
    expect(parse).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("questions[0].points"),
      }),
    );
  });

  it("Scenario: points exceed the Google Forms integer limit", () => {
    // Given
    const input = documentWithQuestion(
      multipleChoice({ points: 2_147_483_648 }),
    );

    // When
    const parse = () => parseQuizDocument(input);

    // Then
    expect(parse).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("questions[0].points"),
      }),
    );
  });

  it("Scenario: two questions share an ID", () => {
    // Given
    const question = multipleChoice();
    const input = { ...metadata, questions: [question, question] };

    // When
    const parse = () => parseQuizDocument(input);

    // Then
    expect(parse).toThrowError(/Question ID must be unique: question-one/);
  });

  it("Scenario: a source range ends before it starts", () => {
    // Given
    const input = documentWithQuestion(
      multipleChoice({
        sources: [{ path: "src/example.ts", startLine: 12, endLine: 10 }],
      }),
    );

    // When
    const parse = () => parseQuizDocument(input);

    // Then
    expect(parse).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("questions[0].sources[0].endLine"),
      }),
    );
  });

  it.each([
    "/etc/passwd",
    "../secret.ts",
    "C:\\secret.ts",
    "file:///etc/passwd",
    "https://example.com/source.ts",
    ".",
    "./",
    "src/.",
    "src\\.",
  ])(
    "Scenario: a source path does not identify a repository file: %s",
    (path) => {
      // Given
      const input = documentWithQuestion(
        multipleChoice({ sources: [{ path, startLine: 1, endLine: 1 }] }),
      );

      // When
      const parse = () => parseQuizDocument(input);

      // Then
      expect(parse).toThrowError(
        /Must be a repository-relative path without parent traversal/,
      );
    },
  );
});

describe("Feature: machine-readable quiz contract", () => {
  it("Scenario: a consumer reads the committed JSON Schema", () => {
    // Given
    const committedSchema = JSON.parse(
      readFileSync(
        new URL("../schemas/quiz-document.schema.json", import.meta.url),
        "utf8",
      ),
    );

    // When
    const generatedSchema = quizDocumentJsonSchema;

    // Then
    expect(committedSchema).toEqual(generatedSchema);
  });
});
