import { z } from "zod";

import type { ClientCredentials } from "./auth.js";

const generatedClientSchema = z
  .object({
    generatedFirstPartyGoogleClient: z
      .object({
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
      })
      .strict(),
  })
  .passthrough();

const GENERATED_CLIENT_MODULE = "./google-oauth-client.generated.js";

export async function loadFirstPartyGoogleClient(): Promise<ClientCredentials> {
  try {
    const generatedModule: unknown = await import(GENERATED_CLIENT_MODULE);
    return generatedClientSchema.parse(generatedModule)
      .generatedFirstPartyGoogleClient;
  } catch {
    throw new Error(
      "Diffler's first-party Google client is unavailable; use --credentials with your own Desktop client or contact the maintainer",
    );
  }
}
