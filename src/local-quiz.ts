import type { QuizDocument, QuizQuestion } from "./quiz.js";

interface QuizPromptBaseRequest {
  number: number;
  total: number;
  message: string;
  points: number;
  required: boolean;
}

export type QuizPromptRequest =
  | (QuizPromptBaseRequest & {
      kind: "select";
      options: readonly string[];
    })
  | (QuizPromptBaseRequest & {
      kind: "multiselect";
      options: readonly string[];
    })
  | (QuizPromptBaseRequest & {
      kind: "text";
    });

export type QuizPromptAnswer =
  | { kind: "answer"; values: readonly string[] }
  | { kind: "skip" };

export interface QuizPrompt {
  ask(request: QuizPromptRequest): Promise<QuizPromptAnswer>;
  close(): void;
}

export class QuizCancelledError extends Error {
  constructor() {
    super("Quiz cancelled; no responses were saved.");
    this.name = "QuizCancelledError";
  }
}

export class LocalQuizError extends Error {
  constructor(message = "Invalid local quiz response.") {
    super(message);
    this.name = "LocalQuizError";
  }
}

export interface QuizQuestionScore {
  correct: boolean;
  skipped: boolean;
  earnedPoints: number;
  possiblePoints: number;
}

export interface LocalQuizResult {
  earnedPoints: number;
  totalPoints: number;
  correctCount: number;
  totalQuestions: number;
  questionScores: readonly QuizQuestionScore[];
}

export function sanitizeQuizDisplayText(value: string): string {
  return [...value]
    .map((character) =>
      isUnsafeDisplayCharacter(character.codePointAt(0) ?? 0) ? " " : character,
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function isUnsafeDisplayCharacter(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x61c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff
  );
}

export function scoreQuizAnswer(
  question: QuizQuestion,
  answer: QuizPromptAnswer,
): QuizQuestionScore {
  if (!isPromptAnswer(answer)) {
    throw new LocalQuizError();
  }

  if (answer.kind === "skip") {
    if (question.required) {
      throw new LocalQuizError();
    }

    return score(question.points, false, true);
  }

  const { values } = answer;
  let correct: boolean;

  switch (question.type) {
    case "multiple_choice":
    case "dropdown": {
      if (values.length !== 1 || !question.options.includes(values[0] ?? "")) {
        throw new LocalQuizError();
      }
      correct = question.correctAnswers.includes(values[0] ?? "");
      break;
    }
    case "checkbox": {
      const selections = new Set(values);
      if (
        selections.size !== values.length ||
        values.some((value) => !question.options.includes(value))
      ) {
        throw new LocalQuizError();
      }
      correct =
        selections.size === question.correctAnswers.length &&
        question.correctAnswers.every((value) => selections.has(value));
      break;
    }
    case "short_answer":
      if (values.length !== 1) {
        throw new LocalQuizError();
      }
      correct = question.correctAnswers.includes(values[0] ?? "");
      break;
  }

  return score(question.points, correct, false);
}

export async function conductLocalQuiz(
  document: QuizDocument,
  prompt: QuizPrompt,
  write: (output: string) => void,
): Promise<LocalQuizResult> {
  const questionScores: QuizQuestionScore[] = [];

  try {
    validateLocalQuizDisplay(document);
    write(`Quiz: ${sanitizeQuizDisplayText(document.title)}`);

    for (const [index, question] of document.questions.entries()) {
      const number = index + 1;
      const answer = await prompt.ask(
        promptRequest(question, number, document.questions.length),
      );
      const questionScore = scoreQuizAnswer(question, answer);
      questionScores.push(questionScore);

      if (!questionScore.skipped) {
        write(
          `${questionScore.correct ? "Correct" : "Incorrect"}. ${questionScore.earnedPoints}/${questionScore.possiblePoints} points.`,
        );
        const feedback =
          question.type === "short_answer"
            ? question.feedback.general
            : questionScore.correct
              ? question.feedback.whenRight
              : question.feedback.whenWrong;
        write(sanitizeQuizDisplayText(feedback));
      }
    }

    const result = summarize(questionScores);
    write(
      `Score: ${result.earnedPoints}/${result.totalPoints} points (${result.correctCount}/${result.totalQuestions} correct).`,
    );
    if (document.closingRiddle !== undefined) {
      write(`Riddle: ${sanitizeQuizDisplayText(document.closingRiddle)}`);
    }
    return result;
  } finally {
    prompt.close();
  }
}

export function validateLocalQuizDisplay(document: QuizDocument): void {
  const displayValues = [document.title];
  if (document.closingRiddle !== undefined) {
    displayValues.push(document.closingRiddle);
  }

  for (const question of document.questions) {
    displayValues.push(question.prompt);
    if (question.type === "short_answer") {
      displayValues.push(question.feedback.general);
    } else {
      displayValues.push(
        question.feedback.whenRight,
        question.feedback.whenWrong,
      );
      validateDisplayOptions(question.options);
    }
  }

  if (
    displayValues.some((value) => sanitizeQuizDisplayText(value).length === 0)
  ) {
    throw new LocalQuizError("Quiz cannot be displayed safely.");
  }
}

function isPromptAnswer(answer: unknown): answer is QuizPromptAnswer {
  if (typeof answer !== "object" || answer === null || !("kind" in answer)) {
    return false;
  }
  if (answer.kind === "skip") {
    return true;
  }
  return (
    answer.kind === "answer" &&
    "values" in answer &&
    Array.isArray(answer.values) &&
    answer.values.every((value) => typeof value === "string")
  );
}

function score(
  possiblePoints: number,
  correct: boolean,
  skipped: boolean,
): QuizQuestionScore {
  return {
    correct,
    skipped,
    earnedPoints: correct ? possiblePoints : 0,
    possiblePoints,
  };
}

function promptRequest(
  question: QuizQuestion,
  number: number,
  total: number,
): QuizPromptRequest {
  const common = {
    number,
    total,
    message: question.prompt,
    points: question.points,
    required: question.required,
  };

  switch (question.type) {
    case "multiple_choice":
    case "dropdown":
      return { kind: "select", ...common, options: question.options };
    case "checkbox":
      return { kind: "multiselect", ...common, options: question.options };
    case "short_answer":
      return { kind: "text", ...common };
  }
}

function validateDisplayOptions(options: readonly string[]): void {
  const labels = options.map(sanitizeQuizDisplayText);
  if (
    labels.some((label) => label.length === 0) ||
    new Set(labels).size !== labels.length
  ) {
    throw new LocalQuizError("Quiz cannot be displayed safely.");
  }
}

function summarize(scores: readonly QuizQuestionScore[]): LocalQuizResult {
  return {
    earnedPoints: scores.reduce(
      (total, question) => total + question.earnedPoints,
      0,
    ),
    totalPoints: scores.reduce(
      (total, question) => total + question.possiblePoints,
      0,
    ),
    correctCount: scores.filter((question) => question.correct).length,
    totalQuestions: scores.length,
    questionScores: scores,
  };
}
