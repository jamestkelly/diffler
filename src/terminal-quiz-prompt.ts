import { createInterface } from "node:readline/promises";

import {
  LocalQuizError,
  QuizCancelledError,
  type QuizPrompt,
  type QuizPromptAnswer,
  type QuizPromptRequest,
  sanitizeQuizDisplayText,
} from "./local-quiz.js";

export interface TerminalQuizIO {
  question(query: string): Promise<string>;
  write(text: string): void;
  close(): void;
}

const INVALID_SELECTION = "Enter valid option numbers separated by commas.\n";
const REQUIRED_RESPONSE = "Enter a response.\n";

export class TerminalQuizPrompt implements QuizPrompt {
  private closed = false;

  constructor(private readonly io: TerminalQuizIO) {}

  async ask(request: QuizPromptRequest): Promise<QuizPromptAnswer> {
    this.writeRequest(request);

    while (true) {
      const line = await this.readLine(this.queryFor(request));

      if (line === "") {
        if (!request.required) {
          return { kind: "skip" };
        }
        this.io.write(REQUIRED_RESPONSE);
        continue;
      }

      if (request.kind === "text") {
        return { kind: "answer", values: [line] };
      }

      const selections = parseSelections(line, request);
      if (selections !== undefined) {
        return { kind: "answer", values: selections };
      }
      this.io.write(INVALID_SELECTION);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.io.close();
  }

  private async readLine(query: string): Promise<string> {
    if (this.closed) {
      throw new QuizCancelledError();
    }

    try {
      return await this.io.question(query);
    } catch {
      throw new QuizCancelledError();
    }
  }

  private writeRequest(request: QuizPromptRequest): void {
    this.io.write(
      `Question ${request.number} of ${request.total} (${request.points} ${request.points === 1 ? "point" : "points"})${request.required ? "" : " - optional; press Enter to skip"}\n${sanitizeQuizDisplayText(request.message)}\n`,
    );
    if (request.kind !== "text") {
      request.options.forEach((option, index) => {
        this.io.write(`${index + 1}. ${sanitizeQuizDisplayText(option)}\n`);
      });
    }
  }

  private queryFor(request: QuizPromptRequest): string {
    switch (request.kind) {
      case "select":
        return "Select one: ";
      case "multiselect":
        return "Select one or more (comma-separated): ";
      case "text":
        return "Answer: ";
    }
  }
}

export function createTerminalQuizPrompt(): QuizPrompt {
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
    throw new LocalQuizError(
      "Interactive quiz requires a TTY on stdin and stdout",
    );
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const cancellation = new AbortController();
  readline.on("SIGINT", () => cancellation.abort());
  return new TerminalQuizPrompt({
    question: (query) =>
      readline.question(query, { signal: cancellation.signal }),
    write: (text) => process.stdout.write(text),
    close: () => {
      cancellation.abort();
      readline.close();
    },
  });
}

function parseSelections(
  line: string,
  request: Extract<QuizPromptRequest, { kind: "select" | "multiselect" }>,
): readonly string[] | undefined {
  const tokens = line.split(",").map((token) => token.trim());
  if (
    (request.kind === "select" && tokens.length !== 1) ||
    tokens.some((token) => !/^[1-9]\d*$/.test(token))
  ) {
    return undefined;
  }

  const indexes = tokens.map(Number);
  if (
    new Set(indexes).size !== indexes.length ||
    indexes.some((index) => index > request.options.length)
  ) {
    return undefined;
  }

  return indexes.map((index) => request.options[index - 1] as string);
}
