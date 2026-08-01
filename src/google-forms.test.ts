import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  FormsPublishError,
  type FormsRequest,
  type FormsTransport,
  GoogleFormsPublisher,
} from "./google-forms.js";
import { parseQuizDocument, type QuizDocument } from "./quiz.js";

describe("Feature: graded Google Forms publication", () => {
  it("Scenario: a validated quiz is created, configured, and published", async () => {
    // Given
    const transport = successfulTransport();
    const publisher = new GoogleFormsPublisher(transport);

    // When
    const result = await publisher.publish(quizDocument());

    // Then
    expect(result).toEqual({
      formId: "form-123",
      editUrl: "https://docs.google.com/forms/d/form-123/edit",
      responderUrl: "https://docs.google.com/forms/d/e/responder/viewform",
    });
    expect(transport.requests).toHaveLength(3);
    expect(transport.requests[0]).toEqual({
      method: "POST",
      url: "https://forms.googleapis.com/v1/forms",
      params: { unpublished: true },
      data: {
        info: {
          title: "Diffler quiz document changes",
          documentTitle: "Diffler quiz document changes",
        },
      },
    });
    expect(transport.requests[2]).toEqual({
      method: "POST",
      url: "https://forms.googleapis.com/v1/forms/form-123:setPublishSettings",
      data: {
        publishSettings: {
          publishState: {
            isPublished: true,
            isAcceptingResponses: true,
          },
        },
        updateMask: "publishState",
      },
    });
  });

  it("Scenario: quiz settings and all supported questions share one atomic update", async () => {
    // Given
    const transport = successfulTransport();
    const publisher = new GoogleFormsPublisher(transport);

    // When
    await publisher.publish(quizDocument());

    // Then
    expect(transport.requests[1]).toEqual({
      method: "POST",
      url: "https://forms.googleapis.com/v1/forms/form-123:batchUpdate",
      data: {
        requests: [
          {
            updateSettings: {
              settings: { quizSettings: { isQuiz: true } },
              updateMask: "quizSettings.isQuiz",
            },
          },
          createChoiceItem({
            index: 0,
            title: "Why does the quiz document include a schema version?",
            required: true,
            points: 2,
            type: "RADIO",
            options: [
              "To support explicit contract evolution",
              "To identify the package-manager version",
              "To count the generated questions",
            ],
            answers: ["To support explicit contract evolution"],
            whenRight: "Correct. The version identifies the document contract.",
            whenWrong: "Review the top-level quiz document fields.",
          }),
          createChoiceItem({
            index: 1,
            title: "Which fields participate directly in automatic grading?",
            required: true,
            points: 2,
            type: "CHECKBOX",
            options: ["options", "correctAnswers", "baseRef", "points"],
            answers: ["options", "correctAnswers", "points"],
            whenRight:
              "Correct. These fields define the choices, key, and score.",
            whenWrong:
              "The base ref identifies the diff but does not grade a response.",
          }),
          createChoiceItem({
            index: 2,
            title: "Which algorithm is required for diffHash?",
            required: true,
            points: 1,
            type: "DROP_DOWN",
            options: ["SHA-1", "SHA-256", "MD5"],
            answers: ["SHA-256"],
            whenRight: "Correct. diffHash is a 64-character SHA-256 value.",
            whenWrong: "Review the diffHash validation pattern.",
          }),
          {
            createItem: {
              item: {
                title: "What type is accepted at the quiz parsing boundary?",
                questionItem: {
                  question: {
                    required: true,
                    grading: {
                      pointValue: 1,
                      correctAnswers: { answers: [{ value: "unknown" }] },
                      generalFeedback: {
                        text: "Untrusted model or file data enters the parser as unknown.",
                      },
                    },
                    textQuestion: { paragraph: false },
                  },
                },
              },
              location: { index: 3 },
            },
          },
        ],
      },
    });
  });

  it("Scenario: an optional closing riddle is the final ungraded item", async () => {
    // Given
    const transport = successfulTransport();
    const publisher = new GoogleFormsPublisher(transport);
    const document = quizDocument();
    const riddle = "What ref dances through a branch without moving?";

    // When
    await publisher.publish({ ...document, closingRiddle: riddle });

    // Then
    expect(transport.requests[1]?.data.requests).toContainEqual({
      createItem: {
        item: {
          title: riddle,
          questionItem: {
            question: {
              required: false,
              textQuestion: { paragraph: false },
            },
          },
        },
        location: { index: 4 },
      },
    });
  });

  it("Scenario: the Forms API fails before creating a form", async () => {
    // Given
    const transport = new RecordingTransport([
      new Error("request failed with access_token=secret"),
    ]);

    // When
    const publish = () =>
      new GoogleFormsPublisher(transport).publish(quizDocument());

    // Then
    const error = await publish().catch((caught: unknown) => caught);
    expect(String(error)).toContain("Unable to confirm Google Form creation");
    expect(String(error)).not.toContain("secret");
    expect(transport.requests).toHaveLength(1);
  });

  it("Scenario: configuration fails after the form is created", async () => {
    // Given
    const transport = new RecordingTransport([
      createdForm(),
      new Error("batch failed with refresh-token-secret"),
    ]);

    // When
    const publish = () =>
      new GoogleFormsPublisher(transport).publish(quizDocument());

    // Then
    const error = await publish().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FormsPublishError);
    expect(error).toMatchObject({
      formId: "form-123",
      editUrl: "https://docs.google.com/forms/d/form-123/edit",
    });
    expect(String(error)).toContain("do not rerun publish");
    expect(String(error)).not.toContain("refresh-token-secret");
    expect(transport.requests).toHaveLength(2);
  });

  it("Scenario: authorization is revoked after creating a form", async () => {
    // Given
    const transport = new RecordingTransport([
      createdForm(),
      providerError("invalid_grant"),
    ]);

    // When
    const publish = () =>
      new GoogleFormsPublisher(transport).publish(quizDocument());

    // Then
    const error = await publish().catch((caught: unknown) => caught);
    expect(String(error)).toContain("run diffler auth login again");
    expect(String(error)).toContain("form-123 was already created");
    expect(error).toMatchObject({ formId: "form-123" });
  });

  it("Scenario: the Forms API quota is exhausted", async () => {
    // Given
    const transport = new RecordingTransport([
      providerError("rateLimitExceeded"),
    ]);

    // When
    const publish = () =>
      new GoogleFormsPublisher(transport).publish(quizDocument());

    // Then
    await expect(publish).rejects.toThrowError(
      "Diffler's Google API quota is temporarily exhausted; try again later or contact the maintainer.",
    );
  });

  it("Scenario: explicit publication fails after configuration", async () => {
    // Given
    const transport = new RecordingTransport([
      createdForm(),
      {},
      new Error("publish failed"),
    ]);

    // When
    const publish = () =>
      new GoogleFormsPublisher(transport).publish(quizDocument());

    // Then
    await expect(publish).rejects.toThrowError(
      /form-123 was created but could not be published/,
    );
    expect(transport.requests).toHaveLength(3);
  });

  it("Scenario: Google returns an incomplete create response", async () => {
    // Given
    const transport = new RecordingTransport([{ formId: "form-123" }]);

    // When
    const publish = () =>
      new GoogleFormsPublisher(transport).publish(quizDocument());

    // Then
    const error = await publish().catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      formId: "form-123",
      editUrl: "https://docs.google.com/forms/d/form-123/edit",
    });
    expect(String(error)).toContain("responder URL was missing");
    expect(transport.requests).toHaveLength(1);
  });
});

class RecordingTransport implements FormsTransport {
  readonly requests: FormsRequest[] = [];

  constructor(private readonly responses: unknown[]) {}

  async request(options: FormsRequest): Promise<unknown> {
    this.requests.push(options);
    const response = this.responses.shift();
    if (response instanceof Error) {
      throw response;
    }
    return response;
  }
}

function successfulTransport(): RecordingTransport {
  return new RecordingTransport([createdForm(), {}, {}]);
}

function createdForm(): unknown {
  return {
    formId: "form-123",
    responderUri: "https://docs.google.com/forms/d/e/responder/viewform",
  };
}

function providerError(reason: string): Error {
  return Object.assign(new Error("provider request failed"), {
    response: {
      data: {
        error: { status: "RESOURCE_EXHAUSTED", errors: [{ reason }] },
      },
    },
  });
}

function quizDocument(): QuizDocument {
  return parseQuizDocument(
    JSON.parse(
      readFileSync(new URL("../examples/quiz.json", import.meta.url), "utf8"),
    ),
  );
}

interface ChoiceItemInput {
  index: number;
  title: string;
  required: boolean;
  points: number;
  type: "RADIO" | "CHECKBOX" | "DROP_DOWN";
  options: string[];
  answers: string[];
  whenRight: string;
  whenWrong: string;
}

function createChoiceItem(input: ChoiceItemInput): unknown {
  return {
    createItem: {
      item: {
        title: input.title,
        questionItem: {
          question: {
            required: input.required,
            grading: {
              pointValue: input.points,
              correctAnswers: {
                answers: input.answers.map((value) => ({ value })),
              },
              whenRight: { text: input.whenRight },
              whenWrong: { text: input.whenWrong },
            },
            choiceQuestion: {
              type: input.type,
              options: input.options.map((value) => ({ value })),
              shuffle: false,
            },
          },
        },
      },
      location: { index: input.index },
    },
  };
}
