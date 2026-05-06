import { useLogout, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { LogOut, FileSignature, LayoutDashboard, Plus, PenLine, Users } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SavedSignatureDialog } from "@/components/saved-signature-dialog";

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { data: me } = useGetMe();
  const logoutMutation = useLogout();
  const queryClient = useQueryClient();

  const handleLogout = () => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetMeQueryKey() });
      },
    });
  };

  const initials = me?.user?.name
    ? me.user.name.split(" ").map(n => n[0]).join("").toUpperCase().substring(0, 2)
    : "U";

  const isAdmin = me?.user?.role === "admin";

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-30 w-full border-b bg-card">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 font-semibold text-lg text-primary">
            <FileSignature className="h-6 w-6" />
            <span>WorkflowSign</span>
          </Link>

          <nav className="hidden md:flex items-center gap-6">
            <Link
              href="/"
              className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                location === "/" ? "text-primary" : "text-muted-foreground hover:text-primary"
              }`}
            >
              <LayoutDashboard className="h-4 w-4" />
              Dashboard
            </Link>
            <Link
              href="/documents/upload"
              className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                location === "/documents/upload" ? "text-primary" : "text-muted-foreground hover:text-primary"
              }`}
            >
              <Plus className="h-4 w-4" />
              New Document
            </Link>
            {isAdmin && (
              <Link
                href="/admin/users"
                className={`flex items-center gap-2 text-sm font-medium transition-colors ${
                  location === "/admin/users" ? "text-primary" : "text-muted-foreground hover:text-primary"
                }`}
              >
                <Users className="h-4 w-4" />
                Users
              </Link>
            )}
          </nav>

          <div className="flex items-center gap-4">
            <div className="hidden sm:flex items-center gap-2 text-sm text-muted-foreground">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-primary/10 text-primary">{initials}</AvatarFallback>
              </Avatar>
              <span className="font-medium text-foreground">{me?.user?.name}</span>
            </div>
            <SavedSignatureDialog>
              <Button variant="ghost" size="icon" title="My saved signature">
                <PenLine className="h-4 w-4" />
              </Button>
            </SavedSignatureDialog>
            <Button variant="ghost" size="icon" onClick={handleLogout} title="Log out">
              <LogOut className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
