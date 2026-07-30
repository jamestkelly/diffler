# AGENTS.md

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

## Code Style & Repository Standards

### Git Conventional Commits

All commits must follow the Conventional Commits v1.0.0 format: `<type>(<scope>): <description>`.

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`.

### Idiomatic Rules

- Naming Casing: `PascalCase` for classes, interfaces, and type aliases (e.g., `QuizDocument`, `GoogleFormsClient`, `DiffContext`). `camelCase` for functions, variables, and properties. Acronyms are treated as words (e.g., `formId`, `oauthClient`).
- Type Safety: Keep TypeScript strict. Do not use `any`, unchecked type assertions, or non-null assertions to bypass the type system. Parse untrusted file, process, model, and API data from `unknown` at the boundary.
- Error Hygiene: Never throw strings or silently swallow errors. Throw `Error` instances with actionable context, preserve causes where useful, and handle expected failures explicitly.
- Test Style: Prefer behavior-driven tests organized around observable features and scenarios. Make Given, When, and Then phases clear, and avoid coupling tests to implementation details.
- Package Manager: Use pnpm for dependency and script operations. Commit `pnpm-lock.yaml` whenever dependencies change; do not generate npm or Yarn lockfiles.
