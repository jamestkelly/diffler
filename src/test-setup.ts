import { devNull } from "node:os";

// Test fixtures build throwaway repositories with `git init`, which otherwise
// reads the developer's global and system config. A global `commit.gpgsign`
// signs every fixture commit, and a global `core.excludesfile` changes which
// files `git add` stages, so fixtures behave differently per machine.
process.env.GIT_CONFIG_GLOBAL = devNull;
process.env.GIT_CONFIG_SYSTEM = devNull;
