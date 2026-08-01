import type { OAuth2Client } from "google-auth-library";
import { z } from "zod";

import { GoogleAuthService, providerErrorCode } from "./auth.js";
import type { QuizDocument, QuizQuestion } from "./quiz.js";

const FORMS_API = "https://forms.googleapis.com/v1/forms";

const createdFormIdentitySchema = z.object({
  formId: z.string().min(1),
});

const createdFormSchema = createdFormIdentitySchema.extend({
  responderUri: z.url(),
});

export interface FormsRequest {
  method: "POST";
  url: string;
  data: Readonly<Record<string, unknown>>;
  params?: Readonly<Record<string, string | boolean>>;
}

export interface FormsTransport {
  request(options: FormsRequest): Promise<unknown>;
}

export interface PublishedForm {
  formId: string;
  editUrl: string;
  responderUrl: string;
}

export interface QuizPublisher {
  publish(document: QuizDocument): Promise<PublishedForm>;
}

export class FormsPublishError extends Error {
  override readonly name = "FormsPublishError";

  constructor(
    message: string,
    readonly formId?: string,
    readonly editUrl?: string,
  ) {
    super(message);
  }
}

export class GoogleFormsPublisher implements QuizPublisher {
  constructor(private readonly transport: FormsTransport) {}

  async publish(document: QuizDocument): Promise<PublishedForm> {
    let response: unknown;
    try {
      response = await this.transport.request({
        method: "POST",
        url: FORMS_API,
        params: { unpublished: true },
        data: {
          info: {
            title: document.title,
            documentTitle: document.title,
          },
        },
      });
    } catch (error) {
      const actionable = actionableRequestError(error);
      if (actionable !== null) {
        throw actionable;
      }
      throw new FormsPublishError(
        "Unable to confirm Google Form creation. Check Google Forms before retrying to avoid a duplicate",
      );
    }

    const identity = createdFormIdentitySchema.safeParse(response);
    if (!identity.success) {
      throw new FormsPublishError(
        "Unable to confirm Google Form creation. Check Google Forms before retrying to avoid a duplicate",
      );
    }
    const editUrl = editorUrl(identity.data.formId);
    const created = createdFormSchema.safeParse(response);
    if (!created.success) {
      throw new FormsPublishError(
        `Google Form ${identity.data.formId} was created but its responder URL was missing. Recover it at ${editUrl}; do not rerun publish unless you want a duplicate form`,
        identity.data.formId,
        editUrl,
      );
    }

    try {
      await this.transport.request({
        method: "POST",
        url: `${FORMS_API}/${encodeURIComponent(created.data.formId)}:batchUpdate`,
        data: {
          requests: [
            {
              updateSettings: {
                settings: { quizSettings: { isQuiz: true } },
                updateMask: "quizSettings.isQuiz",
              },
            },
            ...document.questions.map((question, index) =>
              createItemRequest(question, index),
            ),
            ...(document.closingRiddle === undefined
              ? []
              : [
                  createRiddleItemRequest(
                    document.closingRiddle,
                    document.questions.length,
                  ),
                ]),
          ],
        },
      });
    } catch (error) {
      const actionable = actionableRequestError(
        error,
        created.data.formId,
        editUrl,
      );
      if (actionable !== null) {
        throw actionable;
      }
      throw partialFailure("configure", created.data.formId, editUrl);
    }

    try {
      await this.transport.request({
        method: "POST",
        url: `${FORMS_API}/${encodeURIComponent(created.data.formId)}:setPublishSettings`,
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
    } catch (error) {
      const actionable = actionableRequestError(
        error,
        created.data.formId,
        editUrl,
      );
      if (actionable !== null) {
        throw actionable;
      }
      throw partialFailure("publish", created.data.formId, editUrl);
    }

    return {
      formId: created.data.formId,
      editUrl,
      responderUrl: created.data.responderUri,
    };
  }
}

export async function publishWithStoredAuth(
  document: QuizDocument,
): Promise<PublishedForm> {
  const client = await new GoogleAuthService().getClient();
  return new GoogleFormsPublisher(new OAuthFormsTransport(client)).publish(
    document,
  );
}

function createItemRequest(question: QuizQuestion, index: number): unknown {
  return {
    createItem: {
      item: {
        title: question.prompt,
        questionItem: {
          question: {
            required: question.required,
            grading: grading(question),
            ...questionKind(question),
          },
        },
      },
      location: { index },
    },
  };
}

function createRiddleItemRequest(riddle: string, index: number): unknown {
  return {
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
      location: { index },
    },
  };
}

function grading(question: QuizQuestion): Readonly<Record<string, unknown>> {
  const answerKey = {
    pointValue: question.points,
    correctAnswers: {
      answers: question.correctAnswers.map((value) => ({ value })),
    },
  };
  if (question.type === "short_answer") {
    return {
      ...answerKey,
      generalFeedback: { text: question.feedback.general },
    };
  }
  return {
    ...answerKey,
    whenRight: { text: question.feedback.whenRight },
    whenWrong: { text: question.feedback.whenWrong },
  };
}

function questionKind(
  question: QuizQuestion,
): Readonly<Record<string, unknown>> {
  if (question.type === "short_answer") {
    return { textQuestion: { paragraph: false } };
  }

  const types = {
    multiple_choice: "RADIO",
    checkbox: "CHECKBOX",
    dropdown: "DROP_DOWN",
  } as const;
  return {
    choiceQuestion: {
      type: types[question.type],
      options: question.options.map((value) => ({ value })),
      shuffle: false,
    },
  };
}

class OAuthFormsTransport implements FormsTransport {
  constructor(private readonly client: OAuth2Client) {}

  async request(options: FormsRequest): Promise<unknown> {
    const response = await this.client.request(options);
    return response.data;
  }
}

function partialFailure(
  operation: "configure" | "publish",
  formId: string,
  editUrl: string,
): FormsPublishError {
  return new FormsPublishError(
    `Google Form ${formId} was created but could not be ${operation === "configure" ? "configured" : "published"}. Recover it at ${editUrl}; do not rerun publish unless you want a duplicate form`,
    formId,
    editUrl,
  );
}

function actionableRequestError(
  error: unknown,
  formId?: string,
  editUrl?: string,
): FormsPublishError | null {
  const code = providerErrorCode(error);
  const recovery =
    formId === undefined || editUrl === undefined
      ? ""
      : ` Google Form ${formId} was already created; recover it at ${editUrl} and do not rerun publish unless you want a duplicate.`;
  if (code === "invalid_grant") {
    return new FormsPublishError(
      `Google authorization was revoked or expired; run diffler auth login again.${recovery}`,
      formId,
      editUrl,
    );
  }
  if (
    code === "RESOURCE_EXHAUSTED" ||
    code === "quotaExceeded" ||
    code === "rateLimitExceeded" ||
    code === "userRateLimitExceeded"
  ) {
    return new FormsPublishError(
      `Diffler's Google API quota is temporarily exhausted; try again later or contact the maintainer.${recovery}`,
      formId,
      editUrl,
    );
  }
  return null;
}

function editorUrl(formId: string): string {
  return `https://docs.google.com/forms/d/${encodeURIComponent(formId)}/edit`;
}
