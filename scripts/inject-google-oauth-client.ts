import { access, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { z } from "zod";

const releaseClientSchema = z
  .object({
    clientId: z
      .string()
      .regex(
        /^543831196078-[a-z0-9]+\.apps\.googleusercontent\.com$/,
        "Production Google Desktop client ID has an unexpected format",
      ),
    clientSecret: z.string().min(1),
  })
  .strict();

const defaultOutput = fileURLToPath(
  new URL("../dist/google-oauth-client.generated.js", import.meta.url),
);

export async function injectGoogleOAuthClient(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  output: string = defaultOutput,
): Promise<void> {
  try {
    await access(dirname(output));
  } catch {
    throw new Error(
      "Build Diffler before injecting the first-party OAuth client",
    );
  }

  await rm(output, { force: true });
  if (
    environment.DIFFLER_GOOGLE_CLIENT_ID === undefined &&
    environment.DIFFLER_GOOGLE_CLIENT_SECRET === undefined
  ) {
    return;
  }
  const client = releaseClientSchema.parse({
    clientId: environment.DIFFLER_GOOGLE_CLIENT_ID,
    clientSecret: environment.DIFFLER_GOOGLE_CLIENT_SECRET,
  });
  const temporaryOutput = `${output}.${process.pid}.tmp`;
  try {
    await writeFile(
      temporaryOutput,
      `export const generatedFirstPartyGoogleClient = Object.freeze(${JSON.stringify(client)});\n`,
      { mode: 0o600 },
    );
    await rename(temporaryOutput, output);
  } finally {
    await rm(temporaryOutput, { force: true });
  }
}

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  await injectGoogleOAuthClient();
}
