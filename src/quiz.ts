import * as z from "zod";

const meaningfulString = z
  .string()
  .min(1)
  .regex(/\S/, "Must contain at least one non-whitespace character");

const repositoryRelativePath = meaningfulString.regex(
  /^(?!\/|\\|[A-Za-z][A-Za-z0-9+.-]*:)(?!.*(?:^|[\\/])\.{1,2}(?:[\\/]|$))(?!.*[\\/]$).+$/,
  "Must be a repository-relative path without parent traversal",
);

const sourceReferenceSchema = z
  .strictObject({
    path: repositoryRelativePath.meta({
      description: "Repository-relative file path",
    }),
    startLine: z.int().positive(),
    endLine: z.int().positive(),
  })
  .superRefine((source, context) => {
    if (source.endLine < source.startLine) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "End line must be greater than or equal to start line",
      });
    }
  });

const questionFields = {
  id: z
    .string()
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Use only letters, numbers, underscores, and hyphens",
    ),
  prompt: meaningfulString,
  required: z.boolean(),
  points: z.int32().positive(),
  sources: z.array(sourceReferenceSchema).min(1),
};

const choiceFeedbackSchema = z.strictObject({
  whenRight: meaningfulString,
  whenWrong: meaningfulString,
});

const shortAnswerFeedbackSchema = z.strictObject({
  general: meaningfulString,
});

interface ChoiceAnswerSet {
  options: readonly string[];
  correctAnswers: readonly string[];
}

function validateChoiceAnswers(
  question: ChoiceAnswerSet,
  context: z.RefinementCtx<ChoiceAnswerSet>,
): void {
  if (new Set(question.options).size !== question.options.length) {
    context.addIssue({
      code: "custom",
      path: ["options"],
      message: "Options must be unique",
    });
  }

  if (
    new Set(question.correctAnswers).size !== question.correctAnswers.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["correctAnswers"],
      message: "Correct answers must be unique",
    });
  }

  for (const answer of question.correctAnswers) {
    if (!question.options.includes(answer)) {
      context.addIssue({
        code: "custom",
        path: ["correctAnswers"],
        message: `Correct answer is not present in options: ${answer}`,
      });
    }
  }
}

const choiceFields = {
  ...questionFields,
  options: z.array(meaningfulString).min(2).meta({ uniqueItems: true }),
  feedback: choiceFeedbackSchema,
};

const multipleChoiceQuestionSchema = z
  .strictObject({
    type: z.literal("multiple_choice"),
    ...choiceFields,
    correctAnswers: z
      .array(meaningfulString)
      .min(1)
      .meta({ uniqueItems: true }),
  })
  .superRefine(validateChoiceAnswers);

const checkboxQuestionSchema = z
  .strictObject({
    type: z.literal("checkbox"),
    ...choiceFields,
    correctAnswers: z
      .array(meaningfulString)
      .min(1)
      .meta({ uniqueItems: true }),
  })
  .superRefine(validateChoiceAnswers);

const dropdownQuestionSchema = z
  .strictObject({
    type: z.literal("dropdown"),
    ...choiceFields,
    correctAnswers: z
      .array(meaningfulString)
      .min(1)
      .meta({ uniqueItems: true }),
  })
  .superRefine(validateChoiceAnswers);

const shortAnswerQuestionSchema = z.strictObject({
  type: z.literal("short_answer"),
  ...questionFields,
  correctAnswers: z.array(meaningfulString).min(1).meta({ uniqueItems: true }),
  feedback: shortAnswerFeedbackSchema,
});

const questionSchema = z.discriminatedUnion("type", [
  multipleChoiceQuestionSchema,
  checkboxQuestionSchema,
  dropdownQuestionSchema,
  shortAnswerQuestionSchema,
]);

export const quizDocumentSchema = z
  .strictObject({
    $schema: meaningfulString.optional(),
    schemaVersion: z.literal(1),
    repository: z.strictObject({
      name: meaningfulString,
      remote: meaningfulString.optional(),
    }),
    baseRef: meaningfulString,
    headSha: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "Must be a full Git object ID"),
    diffHash: z.string().regex(/^[0-9a-f]{64}$/, "Must be a SHA-256 hash"),
    title: meaningfulString,
    questions: z.array(questionSchema).min(1),
    closingRiddle: meaningfulString.optional(),
  })
  .superRefine((document, context) => {
    const questionIds = new Set<string>();

    document.questions.forEach((question, index) => {
      if (questionIds.has(question.id)) {
        context.addIssue({
          code: "custom",
          path: ["questions", index, "id"],
          message: `Question ID must be unique: ${question.id}`,
        });
      }
      questionIds.add(question.id);

      if (
        question.type === "short_answer" &&
        new Set(question.correctAnswers).size !== question.correctAnswers.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["questions", index, "correctAnswers"],
          message: "Correct answers must be unique",
        });
      }
    });
  })
  .meta({
    description: "A validated Diffler quiz document",
    "x-diffler-runtime-validations": [
      "Source endLine must be greater than or equal to startLine",
      "Every correct answer for a choice question must match an option",
      "Question IDs must be unique within the document",
    ],
  });

export type QuizDocument = z.infer<typeof quizDocumentSchema>;
export type QuizQuestion = QuizDocument["questions"][number];

export const quizDocumentJsonSchema = {
  $id: "https://raw.githubusercontent.com/jamestkelly/diffler/main/schemas/quiz-document.schema.json",
  ...z.toJSONSchema(quizDocumentSchema, { target: "draft-2020-12" }),
};

export interface QuizValidationIssue {
  path: string;
  message: string;
}

export class QuizValidationError extends Error {
  readonly issues: readonly QuizValidationIssue[];

  constructor(issues: readonly QuizValidationIssue[]) {
    const details = issues
      .map((issue) => `- ${issue.path}: ${issue.message}`)
      .join("\n");
    super(`Invalid quiz document:\n${details}`);
    this.name = "QuizValidationError";
    this.issues = issues;
  }
}

export function parseQuizDocument(input: unknown): QuizDocument {
  const result = quizDocumentSchema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  throw new QuizValidationError(
    result.error.issues.map((issue) => ({
      path: formatPath(issue.path),
      message: issue.message,
    })),
  );
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) {
    return "$";
  }

  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") {
      return `${formatted}[${segment}]`;
    }

    return formatted.length === 0
      ? String(segment)
      : `${formatted}.${String(segment)}`;
  }, "");
}
