import { lazy, Suspense, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Switch, Route, Router as WouterRouter, Redirect, useLocation } from "wouter";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FileSignature, KeyRound } from "lucide-react";

import { useGetMe } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { Layout } from "@/components/layout";
import { AuthPage } from "@/pages/auth";
import { SignPage } from "@/pages/sign";
import { ReviewPage } from "@/pages/review";
import { ForgotPasswordPage } from "@/pages/forgot-password";
import { ResetPasswordPage } from "@/pages/reset-password";

const DashboardPage = lazy(() => import("@/pages/dashboard").then((m) => ({ default: m.DashboardPage })));
const UploadPage = lazy(() => import("@/pages/upload").then((m) => ({ default: m.UploadPage })));
const DocumentDetailPage = lazy(() => import("@/pages/document-detail").then((m) => ({ default: m.DocumentDetailPage })));
const AdminUsersPage = lazy(() => import("@/pages/admin-users").then((m) => ({ default: m.AdminUsersPage })));
const AdminAuditPage = lazy(() => import("@/pages/admin-audit").then((m) => ({ default: m.AdminAuditPage })));
const NotFound = lazy(() => import("@/pages/not-found"));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function LoadingScreen() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-background">
      <div className="h-10 w-10 rounded-xl bg-primary flex items-center justify-center">
        <FileSignature className="h-5 w-5 text-primary-foreground" />
      </div>
      <div className="h-1 w-24 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-primary rounded-full animate-[loading_1.2s_ease-in-out_infinite]" />
      </div>
    </div>
  );
}

function ForceChangePasswordModal({ open }: { open: boolean }) {
  const qc = useQueryClient();
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (newPassword.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}api/auth/change-password`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ newPassword }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !data.success) {
        setError(data.error ?? "Something went wrong.");
        return;
      }
      await qc.invalidateQueries({ queryKey: ["getMe"] });
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-md"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-primary" />
            <DialogTitle>Set your new password</DialogTitle>
          </div>
          <DialogDescription>
            Your password was reset by an administrator. You must choose a new password before continuing.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-1.5">
            <Label htmlFor="np">New password</Label>
            <Input
              id="np"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cp">Confirm new password</Label>
            <Input
              id="cp"
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <Button type="submit" className="w-full" disabled={saving}>
            {saving ? "Saving…" : "Save new password"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: me, isLoading } = useGetMe();
  const [location] = useLocation();

  if (isLoading) return <LoadingScreen />;

  if (!me?.user) {
    const redirect = encodeURIComponent(location);
    return <Redirect to={`/auth?redirect=${redirect}`} />;
  }

  const mustChange = (me.user as unknown as { mustChangePassword?: boolean }).mustChangePassword ?? false;

  return (
    <Layout>
      <ForceChangePasswordModal open={mustChange} />
      <Component />
    </Layout>
  );
}

function AdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: me, isLoading } = useGetMe();
  const [location] = useLocation();

  if (isLoading) return <LoadingScreen />;

  if (!me?.user) {
    const redirect = encodeURIComponent(location);
    return <Redirect to={`/auth?redirect=${redirect}`} />;
  }

  if (me.user.role !== "admin") {
    return <Redirect to="/" />;
  }

  const mustChange = (me.user as unknown as { mustChangePassword?: boolean }).mustChangePassword ?? false;

  return (
    <Layout>
      <ForceChangePasswordModal open={mustChange} />
      <Component />
    </Layout>
  );
}

function AuditRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: me, isLoading } = useGetMe();
  const [location] = useLocation();

  if (isLoading) return <LoadingScreen />;

  if (!me?.user) {
    const redirect = encodeURIComponent(location);
    return <Redirect to={`/auth?redirect=${redirect}`} />;
  }

  if (me.user.role !== "admin" && me.user.role !== "auditor") {
    return <Redirect to="/" />;
  }

  const mustChange = (me.user as unknown as { mustChangePassword?: boolean }).mustChangePassword ?? false;

  return (
    <Layout>
      <ForceChangePasswordModal open={mustChange} />
      <Component />
    </Layout>
  );
}

function Router() {
  return (
    <Suspense fallback={<LoadingScreen />}>
      <Switch>
        <Route path="/auth" component={AuthPage} />
        <Route path="/forgot-password" component={ForgotPasswordPage} />
        <Route path="/reset-password" component={ResetPasswordPage} />
        <Route path="/sign/:token" component={SignPage} />
        <Route path="/review/:token" component={ReviewPage} />
        <Route path="/">
          <ProtectedRoute component={DashboardPage} />
        </Route>
        <Route path="/documents/upload">
          <ProtectedRoute component={UploadPage} />
        </Route>
        <Route path="/documents/:id">
          <ProtectedRoute component={DocumentDetailPage} />
        </Route>
        <Route path="/admin/users">
          <AdminRoute component={AdminUsersPage} />
        </Route>
        <Route path="/admin/audit">
          <AuditRoute component={AdminAuditPage} />
        </Route>
        <Route component={NotFound} />
      </Switch>
    </Suspense>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
