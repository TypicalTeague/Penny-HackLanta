import { createRemoteJWKSet, jwtVerify } from "jose";

export interface PendingVerification {
  action:
    | "approve_plan"
    | "change_mandate"
    | "change_risk"
    | "increase_contribution"
    | "withdraw"
    | "pause"
    | "resume"
    | "reset";
  resourceId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresAt: number;
  intervalSeconds: number;
}

export interface VerifiedIdentity {
  subject: string;
  verifiedAt: string;
}

export interface VerificationProvider {
  start(
    action: PendingVerification["action"],
    resourceId: string,
  ): Promise<PendingVerification>;
  waitForVerification(
    challenge: PendingVerification,
  ): Promise<VerifiedIdentity>;
}

export interface Auth0Dependencies {
  fetch?: typeof fetch;
  delay?: (milliseconds: number) => Promise<void>;
  verifyToken?: (token: string) => Promise<string>;
  requestTimeoutMs?: number;
}

export class Auth0DeviceAuthorization implements VerificationProvider {
  private readonly issuer: string;
  private readonly fetcher: typeof fetch;
  private readonly wait: (milliseconds: number) => Promise<void>;
  private readonly verifyAccessToken: (token: string) => Promise<string>;
  private readonly requestTimeoutMs: number;
  constructor(
    private readonly domain: string,
    private readonly clientId: string,
    private readonly audience: string,
    dependencies: Auth0Dependencies = {},
  ) {
    this.issuer = `https://${domain}/`;
    this.fetcher = dependencies.fetch ?? fetch;
    this.wait = dependencies.delay ?? delay;
    this.requestTimeoutMs = dependencies.requestTimeoutMs ?? 12_000;
    this.verifyAccessToken =
      dependencies.verifyToken ??
      (async (token) => {
        const jwks = createRemoteJWKSet(
          new URL(`${this.issuer}.well-known/jwks.json`),
        );
        const { payload } = await jwtVerify(token, jwks, {
          issuer: this.issuer,
          audience: this.audience,
        });
        if (!payload.sub) throw new Error("Verified token has no subject");
        return payload.sub;
      });
  }

  async start(
    action: PendingVerification["action"],
    resourceId: string,
  ): Promise<PendingVerification> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      scope: "openid profile",
      audience: this.audience,
    });
    const response = await this.fetcher(`${this.issuer}oauth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok)
      throw new Error(`Auth0 device authorization failed (${response.status})`);
    const data = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete?: string;
      expires_in: number;
      interval: number;
    };
    return {
      action,
      resourceId,
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUri: data.verification_uri,
      ...(data.verification_uri_complete
        ? { verificationUriComplete: data.verification_uri_complete }
        : {}),
      expiresAt: Date.now() + data.expires_in * 1000,
      intervalSeconds: data.interval,
    };
  }

  async waitForVerification(
    challenge: PendingVerification,
  ): Promise<VerifiedIdentity> {
    let interval = challenge.intervalSeconds;
    while (Date.now() < challenge.expiresAt) {
      await this.wait(interval * 1000);
      const body = new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: challenge.deviceCode,
        client_id: this.clientId,
      });
      const response = await this.fetcher(`${this.issuer}oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
      const data = (await response.json()) as {
        error?: string;
        id_token?: string;
        access_token?: string;
      };
      if (data.error === "authorization_pending") continue;
      if (data.error === "slow_down") {
        interval += 5;
        continue;
      }
      if (!response.ok)
        throw new Error(
          `Auth0 verification failed: ${data.error ?? response.status}`,
        );
      // The API access token is audience-bound to Penny's configured API.
      const token = data.access_token;
      if (!token) throw new Error("Auth0 returned no token");
      const subject = await this.verifyAccessToken(token);
      return { subject, verifiedAt: new Date().toISOString() };
    }
    throw new Error("Auth0 device authorization expired");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
