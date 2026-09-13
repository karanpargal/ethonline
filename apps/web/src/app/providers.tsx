"use client";

import { PrivyProvider } from "@privy-io/react-auth";

export const PRIVY_ENABLED = !!process.env.NEXT_PUBLIC_PRIVY_APP_ID;

export function Providers({ children }: { children: React.ReactNode }) {
  if (!PRIVY_ENABLED) return <>{children}</>;
  return (
    <PrivyProvider
      appId={process.env.NEXT_PUBLIC_PRIVY_APP_ID!}
      config={{
        loginMethods: ["email"],
        appearance: { theme: "light", accentColor: "#1a7ab8" },
        embeddedWallets: { ethereum: { createOnLogin: "off" } },
      }}
    >
      {children}
    </PrivyProvider>
  );
}
