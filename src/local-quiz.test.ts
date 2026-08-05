import { describe, expect, it } from "vitest";

import {
  conductLocalQuiz,
  LocalQuizError,
  QuizCancelledError,
  type QuizPrompt,
  type QuizPromptAnswer,
  type QuizPromptRequest,
  scoreQuizAnswer,
} from "./local-quiz.js";
import { parseQuizDocument, type QuizDocument } from "./quiz.js";

const source = { path: "src/example.ts", startLine: 1, endLine: 2 };
const choiceFeedback = { whenRight: "Choice right", whenWrong: "Choice wrong" };

function choice(
  type: "multiple_choice" | "dropdown" | "checkbox",
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type,
    id: `${type}-id-secret`,
    prompt: `${type} prompt`,
    required: true,
    points: 2,
    sources: [source],
    options: ["Alpha", "Beta", "Gamma"],
    correctAnswers: type === "checkbox" ? ["Alpha", "Beta"] : ["Alpha"],
    feedback: choiceFeedback,
    ...overrides,
  };
}

function shortAnswer(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "short_answer",
    id: "short-id-secret",
    prompt: "Type the exact token",
    required: true,
    points: 3,
    sources: [source],
    correctAnswers: ["Exact Answer"],
    feedback: { general: "Short answer feedback" },
    ...overrides,
  };
}

function quiz(
  questions: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): QuizDocument {
  return parseQuizDocument({
    schemaVersion: 1,
    repository: { name: "example/project" },
    baseRef: "origin/main",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    diffHash:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    title: "Local knowledge check",
    questions,
    ...overrides,
  });
}

function question(
  value: Record<string, unknown>,
): QuizDocument["questions"][number] {
  const parsed = quiz([value]).questions[0];
  if (parsed === undefined) {
    throw new Error("Missing test question");
  }
  return parsed;
}

class StubPrompt implements QuizPrompt {
  readonly requests: QuizPromptRequest[] = [];
  closeCount = 0;

  constructor(private readonly answers: readonly QuizPromptAnswer[]) {}

  async ask(request: QuizPromptRequest): Promise<QuizPromptAnswer> {
    this.requests.push(request);
    const answer = this.answers[this.requests.length - 1];
    if (answer === undefined) {
      throw new Error("Missing stub answer");
    }
    return answer;
  }

  close(): void {
    this.closeCount += 1;
  }
}

describe("Feature: pure local quiz scoring", () => {
  it("Scenario: either alternative multiple-choice answer is correct", () => {
    // Given
    const item = question(
      choice("multiple_choice", { correctAnswers: ["Alpha", "Beta"] }),
    );

    // When
    const first = scoreQuizAnswer(item, { kind: "answer", values: ["Alpha"] });
    const alternative = scoreQuizAnswer(item, {
      kind: "answer",
      values: ["Beta"],
    });

    // Then
    expect(first).toMatchObject({ correct: true, earnedPoints: 2 });
    expect(alternative).toMatchObject({ correct: true, earnedPoints: 2 });
  });

  it("Scenario: a wrong multiple-choice answer earns no points", () => {
    // Given
    const item = question(choice("multiple_choice"));

    // When
    const result = scoreQuizAnswer(item, { kind: "answer", values: ["Beta"] });

    // Then
    expect(result).toEqual({
      correct: false,
      skipped: false,
      earnedPoints: 0,
      possiblePoints: 2,
    });
  });

  it("Scenario: a dropdown answer is scored as a single selection", () => {
    // Given
    const item = question(choice("dropdown", { correctAnswers: ["Gamma"] }));

    // When
    const result = scoreQuizAnswer(item, { kind: "answer", values: ["Gamma"] });

    // Then
    expect(result).toMatchObject({ correct: true, earnedPoints: 2 });
  });

  it("Scenario: an exact checkbox set is correct independent of order", () => {
    // Given
    const item = question(choice("checkbox"));

    // When
    const result = scoreQuizAnswer(item, {
      kind: "answer",
      values: ["Beta", "Alpha"],
    });

    // Then
    expect(result).toMatchObject({ correct: true, earnedPoints: 2 });
  });

  it.each([
    ["subset", ["Alpha"]],
    ["superset", ["Alpha", "Beta", "Gamma"]],
    ["wrong set", ["Beta", "Gamma"]],
  ])("Scenario: a checkbox %s earns no points", (_case, values) => {
    // Given
    const item = question(choice("checkbox"));

    // When
    const result = scoreQuizAnswer(item, { kind: "answer", values });

    // Then
    expect(result).toMatchObject({ correct: false, earnedPoints: 0 });
  });

  it.each([
    ["duplicate", ["Alpha", "Alpha"]],
    ["unknown", ["Alpha", "injected-secret"]],
  ])(
    "Scenario: a checkbox %s selection is rejected safely",
    (_case, values) => {
      // Given
      const item = question(choice("checkbox"));

      // When
      const score = () => scoreQuizAnswer(item, { kind: "answer", values });

      // Then
      expect(score).toThrowError(
        expect.objectContaining({
          name: "LocalQuizError",
          message: "Invalid local quiz response.",
        }),
      );
      expect(score).not.toThrowError(/injected-secret/);
    },
  );

  it.each([
    ["different case", "exact Answer"],
    ["leading whitespace", " Exact Answer"],
    ["trailing whitespace", "Exact Answer "],
  ])("Scenario: a short answer with %s is not normalized", (_case, value) => {
    // Given
    const item = question(shortAnswer());

    // When
    const result = scoreQuizAnswer(item, { kind: "answer", values: [value] });

    // Then
    expect(result).toMatchObject({ correct: false, earnedPoints: 0 });
  });

  it("Scenario: an exact short answer earns full points", () => {
    // Given
    const item = question(shortAnswer());

    // When
    const result = scoreQuizAnswer(item, {
      kind: "answer",
      values: ["Exact Answer"],
    });

    // Then
    expect(result).toMatchObject({ correct: true, earnedPoints: 3 });
  });

  it("Scenario: an optional question is skipped", () => {
    // Given
    const item = question(choice("dropdown", { required: false }));

    // When
    const result = scoreQuizAnswer(item, { kind: "skip" });

    // Then
    expect(result).toEqual({
      correct: false,
      skipped: true,
      earnedPoints: 0,
      possiblePoints: 2,
    });
  });

  it("Scenario: a required question cannot be skipped", () => {
    // Given
    const item = question(choice("dropdown"));

    // When
    const score = () => scoreQuizAnswer(item, { kind: "skip" });

    // Then
    expect(score).toThrowError(new LocalQuizError());
  });
});

describe("Feature: deterministic local quiz orchestration", () => {
  it("Scenario: weighted scores and feedback are shown after each submission", async () => {
    // Given
    const document = quiz([
      choice("multiple_choice", { points: 2 }),
      choice("dropdown", { points: 4 }),
      shortAnswer({ points: 5 }),
    ]);
    const events: string[] = [];
    const answers: QuizPromptAnswer[] = [
      { kind: "answer", values: ["Alpha"] },
      { kind: "answer", values: ["Beta"] },
      { kind: "answer", values: ["wrong"] },
    ];
    const prompt: QuizPrompt = {
      async ask(request) {
        events.push(`ask:${request.number}`);
        const answer = answers[request.number - 1];
        if (answer === undefined) throw new Error("Missing answer");
        return answer;
      },
      close() {
        events.push("close");
      },
    };

    // When
    const result = await conductLocalQuiz(document, prompt, (output) =>
      events.push(`write:${output}`),
    );

    // Then
    expect(result).toEqual({
      earnedPoints: 2,
      totalPoints: 11,
      correctCount: 1,
      totalQuestions: 3,
      questionScores: [
        { correct: true, skipped: false, earnedPoints: 2, possiblePoints: 2 },
        { correct: false, skipped: false, earnedPoints: 0, possiblePoints: 4 },
        { correct: false, skipped: false, earnedPoints: 0, possiblePoints: 5 },
      ],
    });
    expect(events.indexOf("ask:1")).toBeLessThan(
      events.indexOf("write:Choice right"),
    );
    expect(events.indexOf("ask:2")).toBeLessThan(
      events.indexOf("write:Choice wrong"),
    );
    expect(events.indexOf("ask:3")).toBeLessThan(
      events.indexOf("write:Short answer feedback"),
    );
    expect(events).toContain("write:Quiz: Local knowledge check");
    expect(events).toContain("write:Score: 2/11 points (1/3 correct).");
  });

  it("Scenario: questions are prompted in document order with safe requests", async () => {
    // Given
    const document = quiz([
      choice("dropdown"),
      choice("checkbox"),
      shortAnswer(),
    ]);
    const prompt = new StubPrompt([
      { kind: "answer", values: ["Alpha"] },
      { kind: "answer", values: ["Alpha", "Beta"] },
      { kind: "answer", values: ["Exact Answer"] },
    ]);

    // When
    await conductLocalQuiz(document, prompt, () => undefined);

    // Then
    expect(prompt.requests.map(({ kind, message }) => [kind, message])).toEqual(
      [
        ["select", "dropdown prompt"],
        ["multiselect", "checkbox prompt"],
        ["text", "Type the exact token"],
      ],
    );
    expect(Object.keys(prompt.requests[0] ?? {}).sort()).toEqual([
      "kind",
      "message",
      "number",
      "options",
      "points",
      "required",
      "total",
    ]);
    expect(Object.keys(prompt.requests[2] ?? {}).sort()).toEqual([
      "kind",
      "message",
      "number",
      "points",
      "required",
      "total",
    ]);
  });

  it("Scenario: skipping an optional question emits no feedback", async () => {
    // Given
    const document = quiz([choice("multiple_choice", { required: false })]);
    const prompt = new StubPrompt([{ kind: "skip" }]);
    const output: string[] = [];

    // When
    const result = await conductLocalQuiz(document, prompt, (line) =>
      output.push(line),
    );

    // Then
    expect(result.questionScores[0]).toMatchObject({ skipped: true });
    expect(output).not.toContain("Choice right");
    expect(output).not.toContain("Choice wrong");
  });

  it("Scenario: cancellation stops future prompts and closes exactly once", async () => {
    // Given
    const document = quiz([choice("dropdown"), shortAnswer()]);
    const requests: QuizPromptRequest[] = [];
    let closeCount = 0;
    const prompt: QuizPrompt = {
      async ask(request) {
        requests.push(request);
        throw new QuizCancelledError();
      },
      close() {
        closeCount += 1;
      },
    };

    // When
    const conduct = conductLocalQuiz(document, prompt, () => undefined);

    // Then
    await expect(conduct).rejects.toBeInstanceOf(QuizCancelledError);
    expect(requests).toHaveLength(1);
    expect(closeCount).toBe(1);
  });

  it("Scenario: a successful quiz closes exactly once", async () => {
    // Given
    const prompt = new StubPrompt([{ kind: "answer", values: ["Alpha"] }]);

    // When
    await conductLocalQuiz(
      quiz([choice("multiple_choice")]),
      prompt,
      () => undefined,
    );

    // Then
    expect(prompt.closeCount).toBe(1);
  });

  it("Scenario: a closing riddle appears last and remains ungraded", async () => {
    // Given
    const document = quiz([choice("dropdown")], {
      closingRiddle: "What has branches but no leaves?",
    });
    const prompt = new StubPrompt([{ kind: "answer", values: ["Alpha"] }]);
    const output: string[] = [];

    // When
    const result = await conductLocalQuiz(document, prompt, (line) =>
      output.push(line),
    );

    // Then
    expect(output.at(-1)).toBe("Riddle: What has branches but no leaves?");
    expect(result.totalQuestions).toBe(1);
    expect(result.totalPoints).toBe(2);
  });

  it("Scenario: untrusted display text cannot emit terminal controls", async () => {
    // Given
    const document = quiz(
      [
        shortAnswer({
          feedback: { general: "Feedback\u001b]52;c;clipboard\u0007done" },
        }),
      ],
      {
        title: "Title\u001b[2J\nspoofed",
        closingRiddle: "Riddle\u202ehidden",
      },
    );
    const prompt = new StubPrompt([
      { kind: "answer", values: ["Exact Answer"] },
    ]);
    const output: string[] = [];

    // When
    await conductLocalQuiz(document, prompt, (line) => output.push(line));

    // Then
    expect(output).toContain("Quiz: Title [2J spoofed");
    expect(output).toContain("Feedback ]52;c;clipboard done");
    expect(output).toContain("Riddle: Riddle hidden");
  });

  it("Scenario: visually identical sanitized options are rejected", async () => {
    // Given
    const document = quiz([
      choice("dropdown"),
      choice("multiple_choice", {
        id: "unsafe-options",
        options: ["Alpha", "\u200bAlpha"],
        correctAnswers: ["Alpha"],
      }),
    ]);
    const prompt = new StubPrompt([
      { kind: "answer", values: ["Alpha"] },
      { kind: "answer", values: ["Alpha"] },
    ]);
    const output: string[] = [];

    // When
    const conduct = conductLocalQuiz(document, prompt, (line) =>
      output.push(line),
    );

    // Then
    await expect(conduct).rejects.toThrowError(LocalQuizError);
    expect(prompt.requests).toHaveLength(0);
    expect(output).toEqual([]);
    expect(prompt.closeCount).toBe(1);
  });

  it.each([
    ["prompt", { prompt: "\u001b" }],
    ["feedback", { feedback: { general: "\u200b" } }],
  ])(
    "Scenario: %s text that sanitizes to blank is rejected",
    async (_case, overrides) => {
      // Given
      const document = quiz([shortAnswer(overrides)]);
      const prompt = new StubPrompt([
        { kind: "answer", values: ["Exact Answer"] },
      ]);

      // When
      const conduct = conductLocalQuiz(document, prompt, () => undefined);

      // Then
      await expect(conduct).rejects.toThrowError(LocalQuizError);
      expect(prompt.requests).toHaveLength(0);
      expect(prompt.closeCount).toBe(1);
    },
  );

  it("Scenario: prompts, output, and results do not expose answer secrets", async () => {
    // Given
    const answerKey = "answer-key-secret";
    const response = "response-secret";
    const document = quiz([
      shortAnswer({
        id: "question-id-secret",
        correctAnswers: [answerKey],
        sources: [{ path: "src/source-secret.ts", startLine: 1, endLine: 1 }],
      }),
    ]);
    const prompt = new StubPrompt([{ kind: "answer", values: [response] }]);
    const output: string[] = [];

    // When
    const result = await conductLocalQuiz(document, prompt, (line) =>
      output.push(line),
    );
    const exposed = JSON.stringify({
      requests: prompt.requests,
      output,
      result,
    });

    // Then
    expect(exposed).not.toContain(answerKey);
    expect(exposed).not.toContain(response);
    expect(exposed).not.toContain("question-id-secret");
    expect(exposed).not.toContain("source-secret");
    expect(exposed).not.toContain("correctAnswers");
  });

  it("Scenario: an injected malformed response closes with a fixed safe error", async () => {
    // Given
    const injected = "malformed-value-secret";
    let closeCount = 0;
    const prompt: QuizPrompt = {
      async ask() {
        return { kind: "answer", values: [injected, injected] };
      },
      close() {
        closeCount += 1;
      },
    };

    // When
    const conduct = conductLocalQuiz(
      quiz([choice("dropdown")]),
      prompt,
      () => undefined,
    );

    // Then
    await expect(conduct).rejects.toEqual(
      expect.objectContaining({
        name: "LocalQuizError",
        message: "Invalid local quiz response.",
      }),
    );
    await expect(conduct).rejects.not.toThrowError(injected);
    expect(closeCount).toBe(1);
  });
});
