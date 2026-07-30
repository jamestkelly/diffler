import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

import type { Entry } from "@napi-rs/keyring";
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library";
import open from "open";
import { z } from "zod";

export const GOOGLE_FORMS_SCOPE = "https://www.googleapis.com/auth/forms.body";

const KEYCHAIN_SERVICE = "diffler";
const KEYCHAIN_ACCOUNT = "google-oauth";
const CALLBACK_PATH = "/oauth2/callback";
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const clientCredentialsSchema = z
  .object({
    installed: z.object({
      client_id: z.string().min(1),
      client_secret: z.string().min(1),
    }),
  })
  .strict();

const storedAuthorizationSchema = z
  .object({
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    refreshToken: z.string().min(1),
  })
  .strict();

export interface ClientCredentials {
  clientId: string;
  clientSecret: string;
}

export interface StoredAuthorization extends ClientCredentials {
  refreshToken: string;
}

export interface AuthorizationStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  delete(): Promise<boolean>;
}

export interface OAuthFlow {
  authorize(credentials: ClientCredentials): Promise<string>;
  validate(authorization: StoredAuthorization): Promise<void>;
}

export interface AuthService {
  login(credentialsPath: string): Promise<void>;
  status(): Promise<boolean>;
  logout(): Promise<boolean>;
}

export class AuthError extends Error {
  override readonly name = "AuthError";
}

export function parseClientCredentials(input: string): ClientCredentials {
  let document: unknown;
  try {
    document = JSON.parse(input);
  } catch {
    throw new AuthError("Google OAuth credentials must contain valid JSON");
  }

  const result = clientCredentialsSchema.safeParse(document);
  if (!result.success) {
    throw new AuthError(
      "Google OAuth credentials must be for a Desktop app and contain client_id and client_secret",
    );
  }

  return {
    clientId: result.data.installed.client_id,
    clientSecret: result.data.installed.client_secret,
  };
}

export class GoogleAuthService implements AuthService {
  constructor(
    private readonly store: AuthorizationStore = new KeychainAuthorizationStore(),
    private readonly oauth: OAuthFlow = new GoogleOAuthFlow(),
  ) {}

  async login(credentialsPath: string): Promise<void> {
    let input: string;
    try {
      input = await readFile(credentialsPath, "utf8");
    } catch {
      throw new AuthError(
        `Unable to read OAuth credentials: ${credentialsPath}`,
      );
    }

    const credentials = parseClientCredentials(input);
    const refreshToken = await this.oauth.authorize(credentials);
    await this.store.set(
      JSON.stringify({
        ...credentials,
        refreshToken,
      } satisfies StoredAuthorization),
    );
  }

  async status(): Promise<boolean> {
    const authorization = await this.loadAuthorization();
    if (authorization === null) {
      return false;
    }
    await this.oauth.validate(authorization);
    return true;
  }

  async logout(): Promise<boolean> {
    if ((await this.store.get()) === null) {
      return false;
    }
    if (!(await this.store.delete())) {
      throw new AuthError(
        "Unable to remove Google authorization from the operating-system keychain",
      );
    }
    return true;
  }

  private async loadAuthorization(): Promise<StoredAuthorization | null> {
    const stored = await this.store.get();
    if (stored === null) {
      return null;
    }

    let document: unknown;
    try {
      document = JSON.parse(stored);
    } catch {
      throw new AuthError(
        "Stored Google authorization is invalid; run auth logout",
      );
    }
    const result = storedAuthorizationSchema.safeParse(document);
    if (!result.success) {
      throw new AuthError(
        "Stored Google authorization is invalid; run auth logout",
      );
    }
    return result.data;
  }
}

class KeychainAuthorizationStore implements AuthorizationStore {
  private entry: Promise<Entry> | null = null;

  async get(): Promise<string | null> {
    try {
      return (await this.getEntry()).getPassword();
    } catch {
      throw keychainError();
    }
  }

  async set(value: string): Promise<void> {
    try {
      (await this.getEntry()).setPassword(value);
    } catch {
      throw keychainError();
    }
  }

  async delete(): Promise<boolean> {
    try {
      return (await this.getEntry()).deletePassword();
    } catch {
      throw keychainError();
    }
  }

  private getEntry(): Promise<Entry> {
    this.entry ??= import("@napi-rs/keyring").then(
      ({ Entry: KeychainEntry }) =>
        new KeychainEntry(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT),
    );
    return this.entry;
  }
}

class GoogleOAuthFlow implements OAuthFlow {
  async authorize(credentials: ClientCredentials): Promise<string> {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(64).toString("base64url");
    const codeChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");
    const callback = await listenForCallback(state);

    try {
      const client = new OAuth2Client(
        credentials.clientId,
        credentials.clientSecret,
        callback.redirectUri,
      );
      const authorizationUrl = client.generateAuthUrl({
        access_type: "offline",
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        prompt: "consent",
        scope: [GOOGLE_FORMS_SCOPE],
        state,
      });
      console.error(
        `Open this URL if your browser does not open:\n${authorizationUrl}`,
      );
      try {
        await open(authorizationUrl, { wait: false });
      } catch {
        // The printed URL keeps authorization usable on headless systems.
      }
      const code = await callback.code;
      const response = await client.getToken({
        code,
        codeVerifier,
        redirect_uri: callback.redirectUri,
      });
      if (response.tokens.refresh_token == null) {
        throw new AuthError(
          "Google did not return a refresh token; revoke Diffler access and try again",
        );
      }
      return response.tokens.refresh_token;
    } catch (error) {
      if (error instanceof AuthError) {
        throw error;
      }
      throw new AuthError(
        "Google authorization failed; no credentials were stored",
      );
    } finally {
      callback.close();
    }
  }

  async validate(authorization: StoredAuthorization): Promise<void> {
    const client = authorizedClient(authorization);
    try {
      await client.getAccessToken();
    } catch {
      throw new AuthError(
        "Google authorization is no longer valid; log in again",
      );
    }
  }
}

export function authorizedClient(
  authorization: StoredAuthorization,
): OAuth2Client {
  const client = new OAuth2Client(
    authorization.clientId,
    authorization.clientSecret,
  );
  client.setCredentials({ refresh_token: authorization.refreshToken });
  return client;
}

interface PendingCallback {
  redirectUri: string;
  code: Promise<string>;
  close(): void;
}

async function listenForCallback(
  expectedState: string,
): Promise<PendingCallback> {
  let resolveCode: (code: string) => void = () => undefined;
  let rejectCode: (error: Error) => void = () => undefined;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end("Not found");
      return;
    }
    if (requestUrl.searchParams.get("state") !== expectedState) {
      response.writeHead(400).end("Authorization state did not match.");
      return;
    }
    const oauthError = requestUrl.searchParams.get("error");
    const authorizationCode = requestUrl.searchParams.get("code");
    if (oauthError !== null || authorizationCode === null) {
      response.writeHead(400).end("Authorization was not completed.");
      rejectCode(new AuthError("Google authorization was denied"));
      return;
    }
    response
      .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
      .end("Diffler is authorized. You can close this window.");
    resolveCode(authorizationCode);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new AuthError("Unable to start the local OAuth callback");
  }
  const timeout = setTimeout(() => {
    rejectCode(new AuthError("Google authorization timed out"));
    server.close();
  }, CALLBACK_TIMEOUT_MS);
  timeout.unref();

  return {
    redirectUri: `http://127.0.0.1:${address.port}${CALLBACK_PATH}`,
    code,
    close: () => {
      clearTimeout(timeout);
      server.close();
      server.closeAllConnections();
    },
  };
}

function keychainError(): AuthError {
  return new AuthError(
    "Unable to access the operating-system keychain; ensure a keychain service is available",
  );
}
