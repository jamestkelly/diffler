import { createInterface } from "node:readline/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalQuizError, QuizCancelledError } from "./local-quiz.js";
import {
  createTerminalQuizPrompt,
  TerminalQuizPrompt,
  type TerminalQuizIO,
} from "./terminal-quiz-prompt.js";

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(),
}));

const baseRequest = {
  number: 1,
  total: 3,
  message: "Which behavior applies?",
  points: 2,
  required: true,
};
const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const stdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

function terminal(lines: readonly (string | Error)[]): {
  io: TerminalQuizIO;
  questions: string[];
  writes: string[];
  close: ReturnType<typeof vi.fn>;
} {
  const questions: string[] = [];
  const writes: string[] = [];
  const close = vi.fn();
  let index = 0;
  return {
    io: {
      question: async (query) => {
        questions.push(query);
        const line = lines[index++];
        if (line instanceof Error) {
          throw line;
        }
        if (line === undefined) {
          throw new Error("EOF");
        }
        return line;
      },
      write: (text) => writes.push(text),
      close,
    },
    questions,
    writes,
    close,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  restoreProperty(process.stdin, "isTTY", stdinIsTTY);
  restoreProperty(process.stdout, "isTTY", stdoutIsTTY);
});

describe("Feature: terminal quiz prompt", () => {
  it("Scenario: noninteractive input is rejected before readline creation", () => {
    // Given
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });

    // When
    const create = () => createTerminalQuizPrompt();

    // Then
    expect(create).toThrowError(LocalQuizError);
    expect(create).toThrowError(
      "Interactive quiz requires a TTY on stdin and stdout",
    );
    expect(createInterface).not.toHaveBeenCalled();
  });

  it("Scenario: Ctrl-C aborts the pending readline question", async () => {
    // Given
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: true,
    });
    vi.spyOn(process.stdout, "write").mockReturnValue(true);
    let interrupt: (() => void) | undefined;
    const close = vi.fn();
    const readline = {
      on: vi.fn((event: string, handler: () => void) => {
        if (event === "SIGINT") interrupt = handler;
        return readline;
      }),
      question: vi.fn(
        (_query: string, options: { signal: AbortSignal }) =>
          new Promise<string>((_resolve, reject) => {
            options.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
      close,
    };
    vi.mocked(createInterface).mockReturnValue(
      readline as unknown as ReturnType<typeof createInterface>,
    );
    const prompt = createTerminalQuizPrompt();
    const answer = prompt.ask({ kind: "text", ...baseRequest });

    // When
    interrupt?.();

    // Then
    await expect(answer).rejects.toThrowError(QuizCancelledError);
    prompt.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("Scenario: a numbered single choice maps to its option", async () => {
    // Given
    const fake = terminal(["2"]);
    const prompt = new TerminalQuizPrompt(fake.io);

    // When
    const answer = await prompt.ask({
      kind: "select",
      ...baseRequest,
      options: ["Alpha", "Beta", "Gamma"],
    });

    // Then
    expect(answer).toEqual({ kind: "answer", values: ["Beta"] });
    expect(fake.writes).toContain("1. Alpha\n");
    expect(fake.writes).toContain("2. Beta\n");
    expect(fake.questions).toEqual(["Select one: "]);
  });

  it("Scenario: comma-separated selections preserve input order", async () => {
    // Given
    const fake = terminal([" 3, 1 "]);
    const prompt = new TerminalQuizPrompt(fake.io);

    // When
    const answer = await prompt.ask({
      kind: "multiselect",
      ...baseRequest,
      options: ["Alpha", "Beta", "Gamma"],
    });

    // Then
    expect(answer).toEqual({ kind: "answer", values: ["Gamma", "Alpha"] });
  });

  it("Scenario: text is returned without trimming", async () => {
    // Given
    const fake = terminal(["  Exact answer  "]);
    const prompt = new TerminalQuizPrompt(fake.io);

    // When
    const answer = await prompt.ask({ kind: "text", ...baseRequest });

    // Then
    expect(answer).toEqual({
      kind: "answer",
      values: ["  Exact answer  "],
    });
  });

  it("Scenario: an optional blank answer is skipped", async () => {
    // Given
    const fake = terminal([""]);
    const prompt = new TerminalQuizPrompt(fake.io);

    // When
    const answer = await prompt.ask({
      kind: "text",
      ...baseRequest,
      required: false,
    });

    // Then
    expect(answer).toEqual({ kind: "skip" });
    expect(fake.writes.join("")).toContain("optional; press Enter to skip");
  });

  it("Scenario: prompt text and options cannot emit terminal controls", async () => {
    // Given
    const fake = terminal(["1"]);
    const prompt = new TerminalQuizPrompt(fake.io);

    // When
    await prompt.ask({
      kind: "select",
      ...baseRequest,
      message: "Prompt\u001b[2J\nspoofed",
      options: ["Option\u001b]52;c;clipboard\u0007", "Other"],
    });

    // Then
    const output = fake.writes.join("");
    expect(output).toContain("Prompt [2J spoofed");
    expect(output).toContain("1. Option ]52;c;clipboard");
  });

  it("Scenario: a required blank answer is requested again", async () => {
    // Given
    const fake = terminal(["", "response"]);
    const prompt = new TerminalQuizPrompt(fake.io);

    // When
    const answer = await prompt.ask({ kind: "text", ...baseRequest });

    // Then
    expect(answer).toEqual({ kind: "answer", values: ["response"] });
    expect(fake.questions).toHaveLength(2);
    expect(fake.writes).toContain("Enter a response.\n");
  });

  it.each(["word", "0", "4", "1,1"])(
    "Scenario: invalid selection %s is rejected without echoing it",
    async (invalid) => {
      // Given
      const fake = terminal([invalid, "2"]);
      const prompt = new TerminalQuizPrompt(fake.io);

      // When
      const answer = await prompt.ask({
        kind: "multiselect",
        ...baseRequest,
        options: ["Alpha", "Beta", "Gamma"],
      });

      // Then
      expect(answer).toEqual({ kind: "answer", values: ["Beta"] });
      expect(fake.questions).toHaveLength(2);
      expect(fake.writes).toContain(
        "Enter valid option numbers separated by commas.\n",
      );
      expect(fake.writes.join("")).not.toContain(invalid);
    },
  );

  it("Scenario: question rejection is converted to quiz cancellation", async () => {
    // Given
    const fake = terminal([new Error("readline closed")]);
    const prompt = new TerminalQuizPrompt(fake.io);

    // When
    const ask = prompt.ask({ kind: "text", ...baseRequest });

    // Then
    await expect(ask).rejects.toThrowError(QuizCancelledError);
    await expect(ask).rejects.toThrowError(
      "Quiz cancelled; no responses were saved.",
    );
  });

  it("Scenario: EOF is converted to quiz cancellation", async () => {
    // Given
    const fake = terminal([]);
    const prompt = new TerminalQuizPrompt(fake.io);

    // When
    const ask = prompt.ask({ kind: "text", ...baseRequest });

    // Then
    await expect(ask).rejects.toThrowError(QuizCancelledError);
  });

  it("Scenario: closing the prompt more than once closes readline once", () => {
    // Given
    const fake = terminal([]);
    const prompt = new TerminalQuizPrompt(fake.io);

    // When
    prompt.close();
    prompt.close();

    // Then
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it("Scenario: asking after close is converted to quiz cancellation", async () => {
    // Given
    const fake = terminal(["unreachable"]);
    const prompt = new TerminalQuizPrompt(fake.io);
    prompt.close();

    // When
    const ask = prompt.ask({ kind: "text", ...baseRequest });

    // Then
    await expect(ask).rejects.toThrowError(QuizCancelledError);
    expect(fake.questions).toHaveLength(0);
  });
});

function restoreProperty(
  target: NodeJS.ReadStream | NodeJS.WriteStream,
  property: "isTTY",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor === undefined) {
    Reflect.deleteProperty(target, property);
  } else {
    Object.defineProperty(target, property, descriptor);
  }
}
