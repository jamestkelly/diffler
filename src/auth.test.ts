import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  AuthError,
  type AuthorizationStore,
  type ClientCredentials,
  GOOGLE_FORMS_SCOPE,
  GoogleAuthService,
  oauthErrorMessage,
  type OAuthFlow,
  parseClientCredentials,
  providerErrorCode,
  type StoredAuthorization,
} from "./auth.js";

describe("Feature: Google OAuth client credentials", () => {
  it("Scenario: a user provides downloaded Desktop app credentials", () => {
    // Given
    const document = JSON.stringify({
      installed: {
        client_id: "client-id.apps.googleusercontent.com",
        project_id: "diffler-project",
        auth_uri: "https://accounts.google.com/o/oauth2/auth",
        token_uri: "https://oauth2.googleapis.com/token",
        client_secret: "client-secret",
        redirect_uris: ["http://localhost"],
      },
    });

    // When
    const credentials = parseClientCredentials(document);

    // Then
    expect(credentials).toEqual({
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
    });
  });

  it("Scenario: a user provides Web application credentials", () => {
    // Given
    const document = JSON.stringify({
      web: { client_id: "client-id", client_secret: "client-secret" },
    });

    // When
    const parse = () => parseClientCredentials(document);

    // Then
    expect(parse).toThrowError(/Desktop app/);
  });

  it("Scenario: malformed credentials include a secret", () => {
    // Given
    const secret = "do-not-print-this-secret";

    // When
    const parse = () => parseClientCredentials(`{${secret}`);

    // Then
    expect(parse).toThrowError(AuthError);
    expect(parse).toThrowError(
      /^Google OAuth credentials must contain valid JSON$/,
    );
  });
});

describe("Feature: persisted Google authorization", () => {
  it("Scenario: first-party configuration stays out of keychain storage", async () => {
    // Given
    const store = new MemoryAuthorizationStore();
    const oauth = new StubOAuthFlow();
    const auth = new GoogleAuthService(store, oauth, async () => ({
      clientId: "production-client.apps.googleusercontent.com",
      clientSecret: "public-desktop-client-secret",
    }));

    // When
    await auth.login();
    const authenticated = await auth.status();

    // Then
    expect(oauth.authorizedWith).toEqual({
      clientId: "production-client.apps.googleusercontent.com",
      clientSecret: "public-desktop-client-secret",
    });
    expect(JSON.parse(store.value ?? "")).toEqual({
      client: "first-party",
      refreshToken: "refresh-token",
    });
    expect(store.value).not.toContain("clientSecret");
    expect(store.value).not.toContain("public-desktop-client-secret");
    expect(authenticated).toBe(true);
    expect(oauth.validatedWith).toEqual({
      client: "first-party",
      clientId: "production-client.apps.googleusercontent.com",
      clientSecret: "public-desktop-client-secret",
      refreshToken: "refresh-token",
    });
  });

  it("Scenario: first login stores only durable authorization", async () => {
    // Given
    const credentialsPath = writeCredentials();
    const store = new MemoryAuthorizationStore();
    const oauth = new StubOAuthFlow();
    const auth = new GoogleAuthService(store, oauth);

    // When
    await auth.login(credentialsPath);

    // Then
    expect(oauth.authorizedWith).toEqual({
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
    });
    expect(JSON.parse(store.value ?? "")).toEqual({
      client: "bring-your-own",
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
    expect(store.value).not.toContain("access_token");
  });

  it("Scenario: a later run validates its refresh credential", async () => {
    // Given
    const authorization: StoredAuthorization = {
      client: "bring-your-own",
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    };
    const store = new MemoryAuthorizationStore(JSON.stringify(authorization));
    const oauth = new StubOAuthFlow();
    const auth = new GoogleAuthService(store, oauth);

    // When
    const authenticated = await auth.status();

    // Then
    expect(authenticated).toBe(true);
    expect(oauth.validatedWith).toEqual(authorization);
  });

  it("Scenario: a prior release stored untagged authorization", async () => {
    // Given
    const legacyAuthorization = {
      clientId: "legacy-client-id",
      clientSecret: "legacy-client-secret",
      refreshToken: "legacy-refresh-token",
    };
    const oauth = new StubOAuthFlow();
    const auth = new GoogleAuthService(
      new MemoryAuthorizationStore(JSON.stringify(legacyAuthorization)),
      oauth,
    );

    // When
    const authenticated = await auth.status();

    // Then
    expect(authenticated).toBe(true);
    expect(oauth.validatedWith).toEqual({
      client: "bring-your-own",
      ...legacyAuthorization,
    });
  });

  it("Scenario: no authorization has been stored", async () => {
    // Given
    const oauth = new StubOAuthFlow();
    const auth = new GoogleAuthService(new MemoryAuthorizationStore(), oauth);

    // When
    const authenticated = await auth.status();

    // Then
    expect(authenticated).toBe(false);
    expect(oauth.validatedWith).toBeNull();
  });

  it("Scenario: a Google API client is requested before login", async () => {
    // Given
    const auth = new GoogleAuthService(
      new MemoryAuthorizationStore(),
      new StubOAuthFlow(),
    );

    // When
    const getClient = () => auth.getClient();

    // Then
    await expect(getClient).rejects.toThrowError(
      "Not authenticated with Google; run diffler auth login",
    );
  });

  it("Scenario: a user logs out", async () => {
    // Given
    const store = new MemoryAuthorizationStore("stored-authorization");
    const auth = new GoogleAuthService(store, new StubOAuthFlow());

    // When
    const removed = await auth.logout();

    // Then
    expect(removed).toBe(true);
    expect(store.value).toBeNull();
  });

  it("Scenario: the keychain cannot remove stored authorization", async () => {
    // Given
    const store = new MemoryAuthorizationStore("stored-authorization");
    store.allowDelete = false;
    const auth = new GoogleAuthService(store, new StubOAuthFlow());

    // When
    const logout = () => auth.logout();

    // Then
    await expect(logout).rejects.toThrowError(
      "Unable to remove Google authorization from the operating-system keychain",
    );
    expect(store.value).toBe("stored-authorization");
  });

  it("Scenario: stored authorization is malformed", async () => {
    // Given
    const auth = new GoogleAuthService(
      new MemoryAuthorizationStore("not-json"),
      new StubOAuthFlow(),
    );

    // When
    const status = () => auth.status();

    // Then
    await expect(status).rejects.toThrowError(
      "Stored Google authorization is invalid; run auth logout",
    );
  });
});

describe("Feature: Google authorization scope", () => {
  it("Scenario: Diffler requests only form body access", () => {
    // Given / When / Then
    expect(GOOGLE_FORMS_SCOPE).toBe(
      "https://www.googleapis.com/auth/forms.body",
    );
  });
});

describe("Feature: actionable Google authorization errors", () => {
  it.each([
    [
      "access_denied",
      "Google authorization was denied; if Google shows an unverified-app warning, continue only if you trust Diffler",
    ],
    [
      "admin_policy_enforced",
      "Your Google Workspace administrator blocked Diffler; ask an administrator to allow the Diffler OAuth client",
    ],
    [
      "invalid_client",
      "Diffler's first-party Google client is unavailable; use --credentials with your own Desktop client or contact the maintainer",
    ],
    [
      "invalid_grant",
      "Google authorization was revoked or expired; run diffler auth login again",
    ],
    [
      "quota_exceeded",
      "Diffler's Google API quota is temporarily exhausted; try again later or contact the maintainer",
    ],
  ])("Scenario: Google returns %s", (code, expected) => {
    // Given / When / Then
    expect(oauthErrorMessage(code)).toBe(expected);
  });

  it("Scenario: a provider error contains sensitive diagnostic details", () => {
    // Given
    const secret = "do-not-print-this-refresh-token";
    const error = {
      response: {
        data: {
          error: "invalid_grant",
          error_description: secret,
        },
      },
    };

    // When
    const message = oauthErrorMessage(providerErrorCode(error), true);

    // Then
    expect(message).toBe(
      "Google authorization was revoked or expired; run diffler auth login again",
    );
    expect(message).not.toContain(secret);
  });

  it("Scenario: a bring-your-own client is rejected", () => {
    // Given / When / Then
    expect(oauthErrorMessage("invalid_client", false, false)).toBe(
      "Google rejected the supplied Desktop client; download valid credentials or use Diffler's first-party login",
    );
  });
});

class MemoryAuthorizationStore implements AuthorizationStore {
  allowDelete = true;

  constructor(public value: string | null = null) {}

  async get(): Promise<string | null> {
    return this.value;
  }

  async set(value: string): Promise<void> {
    this.value = value;
  }

  async delete(): Promise<boolean> {
    if (!this.allowDelete) {
      return false;
    }
    const existed = this.value !== null;
    this.value = null;
    return existed;
  }
}

class StubOAuthFlow implements OAuthFlow {
  authorizedWith: ClientCredentials | null = null;
  validatedWith: StoredAuthorization | null = null;

  async authorize(
    credentials: ClientCredentials,
    _client: StoredAuthorization["client"],
  ): Promise<string> {
    this.authorizedWith = credentials;
    return "refresh-token";
  }

  async validate(authorization: StoredAuthorization): Promise<void> {
    this.validatedWith = authorization;
  }
}

function writeCredentials(): string {
  const directory = mkdtempSync(join(tmpdir(), "diffler-auth-"));
  const path = join(directory, "credentials.json");
  writeFileSync(
    path,
    JSON.stringify({
      installed: {
        client_id: "client-id.apps.googleusercontent.com",
        client_secret: "client-secret",
      },
    }),
  );
  return path;
}
