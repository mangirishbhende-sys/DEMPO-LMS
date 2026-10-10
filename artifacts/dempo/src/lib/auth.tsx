import { ClerkProvider, useAuth, SignIn, SignUp } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { BRAND } from "@/lib/brand";
import { DEMO_MODE } from "@/lib/session";

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains.
const publishableKey = DEMO_MODE
  ? ""
  : publishableKeyFromHost(
      window.location.hostname,
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
    );

// Empty in dev (Clerk hits dev FAPI directly), auto-set in prod. Do NOT gate on
// PROD/NODE_ENV or add a fallback — the empty dev value is intentional.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!publishableKey && !DEMO_MODE) {
  throw new Error("Missing Publishable Key");
}

export function ClerkQueryClientCacheInvalidator() {
  const { sessionId } = useAuth();
  const queryClient = useQueryClient();

  useEffect(() => {
    queryClient.invalidateQueries();
  }, [sessionId, queryClient]);

  return null;
}

export function ClerkAuthProvider({ children }: { children: React.ReactNode }) {
  if (DEMO_MODE) {
    return (
      <>
        {children}
        <div className="fixed bottom-2 left-2 z-50 rounded-md border border-warning/30 bg-background px-2.5 py-1 text-xs font-medium text-warning shadow-sm">
          Local demo mode · sample data
        </div>
      </>
    );
  }
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      proxyUrl={clerkProxyUrl}
      appearance={{
        variables: {
          // Mandovi: river-teal actions (matches --primary in index.css).
          colorPrimary: 'hsl(186 75% 24%)',
          colorBackground: 'hsl(0 0% 100%)',
          fontFamily: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
          borderRadius: '0.375rem',
        },
        elements: {
          card: "shadow-sm border border-border",
          headerTitle: "text-xl font-semibold text-foreground",
          headerSubtitle: "text-muted-foreground",
          formButtonPrimary:
            "bg-primary text-primary-foreground hover:bg-primary/90 font-medium border-0 shadow-none normal-case",
          footerActionLink:
            "text-info hover:text-info/80 font-medium",
        }
      }}
      localization={{
        signIn: {
          start: {
            title: `Sign in to ${BRAND.name}`,
            subtitle: "Welcome back! Please sign in to continue",
          },
        },
        signUp: {
          start: {
            title: `Create your ${BRAND.name} account`,
            subtitle: "Use the email your college invited.",
          },
        },
      }}
    >
      <ClerkQueryClientCacheInvalidator />
      {children}
    </ClerkProvider>
  );
}
