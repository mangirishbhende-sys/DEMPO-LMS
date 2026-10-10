import { cloneElement, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from "react";
import * as Clerk from "@clerk/react";
import { Button } from "@/components/ui/button";
import { Loader2, UserRound } from "lucide-react";

/*
 * Auth facade. Screens import useAuth / SignIn / SignUp / SignOutButton from
 * here instead of "@clerk/react", so the same UI runs either on Clerk (normal)
 * or on the LOCAL DEMO login (VITE_LOCAL_DEMO_AUTH=true: offline preview with
 * seeded demo users, no accounts, no internet). DEMO_MODE is a build-time
 * constant, so each build always takes the same branch.
 */
export const DEMO_MODE = import.meta.env.VITE_LOCAL_DEMO_AUTH === "true";

const DEMO_COOKIE = "mandovi_demo_user";

function readDemoUser(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${DEMO_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

export function useAuth(): {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  sessionId: string | null | undefined;
} {
  if (DEMO_MODE) {
    const id = readDemoUser();
    return { isLoaded: true, isSignedIn: !!id, sessionId: id };
  }
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return Clerk.useAuth();
}

export function SignOutButton({ children }: { children: ReactNode }) {
  if (!DEMO_MODE) return <Clerk.SignOutButton>{children}</Clerk.SignOutButton>;
  const signOut = () => {
    document.cookie = `${DEMO_COOKIE}=; path=/; max-age=0`;
    window.location.href = import.meta.env.BASE_URL;
  };
  return isValidElement(children)
    ? cloneElement(children as ReactElement<{ onClick?: () => void }>, { onClick: signOut })
    : <button type="button" onClick={signOut}>{children}</button>;
}

type DemoUser = { id: string; name: string | null; email: string; role: string; isAdmin: boolean };

function DemoSignIn() {
  const [users, setUsers] = useState<DemoUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/demo/users")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setUsers)
      .catch(() => setError("Could not reach the local API. Is it running on port 8080?"));
  }, []);

  const signIn = (id: string) => {
    document.cookie = `${DEMO_COOKIE}=${encodeURIComponent(id)}; path=/; SameSite=Lax`;
    window.location.href = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/dashboard`;
  };

  return (
    <div className="w-full rounded-lg border bg-card p-5 space-y-4">
      <div>
        <div className="font-semibold">Local demo — choose who to be</div>
        <p className="text-sm text-muted-foreground">
          Offline preview with sample data. No password: this only works on this computer.
        </p>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {!users && !error && <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />}
      {users && users.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No demo users yet. Run <code>pnpm --filter @workspace/scripts run seed-demo</code> and reload.
        </p>
      )}
      <div className="space-y-2">
        {users?.map((u) => (
          <Button key={u.id} variant="outline" className="w-full justify-start h-auto py-3" onClick={() => signIn(u.id)}>
            <UserRound className="w-4 h-4 mr-3 shrink-0" aria-hidden />
            <span className="text-left">
              <span className="block font-medium">{u.name ?? u.email}</span>
              <span className="block text-xs text-muted-foreground capitalize">
                {u.role.replace("_", " ")}{u.isAdmin ? " · admin" : ""}
              </span>
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}

export function SignIn(props: Parameters<typeof Clerk.SignIn>[0]) {
  return DEMO_MODE ? <DemoSignIn /> : <Clerk.SignIn {...props} />;
}

export function SignUp(props: Parameters<typeof Clerk.SignUp>[0]) {
  return DEMO_MODE ? <DemoSignIn /> : <Clerk.SignUp {...props} />;
}
