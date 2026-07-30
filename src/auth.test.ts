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
  type OAuthFlow,
  parseClientCredentials,
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
      clientId: "client-id.apps.googleusercontent.com",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
    });
    expect(store.value).not.toContain("access_token");
  });

  it("Scenario: a later run validates its refresh credential", async () => {
    // Given
    const authorization: StoredAuthorization = {
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

  async authorize(credentials: ClientCredentials): Promise<string> {
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
