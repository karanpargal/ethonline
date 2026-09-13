// Privy end-user auth: verifies access tokens issued by Privy's client SDK
// (email OTP login) so onboarding gets a VERIFIED email and returning users
// can log back in without their AutoCFO access token.
import { createRemoteJWKSet } from "jose";
import { verifyAccessToken } from "@privy-io/node";
import { requiredEnv } from "./privy.js";

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

export async function verifyPrivyUser(accessToken: string): Promise<string> {
  const appId = requiredEnv("PRIVY_APP_ID");
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`),
    );
  }
  const { user_id } = await verifyAccessToken({
    access_token: accessToken,
    app_id: appId,
    verification_key: jwks,
  });
  return user_id;
}

/** Fetch the user's verified email from Privy (best-effort, REST). */
export async function privyUserEmail(userId: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://api.privy.io/v1/users/${encodeURIComponent(userId)}`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${requiredEnv("PRIVY_APP_ID")}:${requiredEnv("PRIVY_APP_SECRET")}`,
          ).toString("base64")}`,
          "privy-app-id": requiredEnv("PRIVY_APP_ID"),
        },
      },
    );
    if (!res.ok) return null;
    const user = (await res.json()) as {
      linked_accounts?: Array<{ type?: string; address?: string }>;
    };
    return user.linked_accounts?.find((a) => a.type === "email")?.address ?? null;
  } catch {
    return null;
  }
}
