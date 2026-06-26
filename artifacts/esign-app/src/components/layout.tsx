import { useState } from "react";
import { useLogout, useGetMe, getGetMeQueryKey } from "@workspace/api-client-react";
import { Link, useLocation } from "wouter";
import { LogOut, FileSignature, LayoutDashboard, Plus, PenLine, Users, ClipboardList, ChevronDown, Menu, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SavedSignatureDialog } from "@/components/saved-signature-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

interface LayoutProps {
  children: React.ReactNode;
}

function NavLink({ href, icon: Icon, label, active, onClick }: { href: string; icon: React.ElementType; label: string; active: boolean; onClick?: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-full transition-all ${
        active
          ? "bg-primary/10 text-primary"
          : "text-muted-foreground hover:text-foreground hover:bg-muted"
      }`}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </Link>
  );
}

function MobileNavLink({ href, icon: Icon, label, active, onClick }: { href: string; icon: React.ElementType; label: string; active: boolean; onClick: () => void }) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-3 text-base font-medium px-3 py-3 rounded-lg transition-all ${
        active
          ? "bg-primary/10 text-primary"
          : "text-foreground hover:bg-muted"
      }`}
    >
      <Icon className="h-5 w-5" />
      {label}
    </Link>
  );
}

export function Layout({ children }: LayoutProps) {
  const [location] = useLocation();
  const { data: me } = useGetMe();
  const logoutMutation = useLogout();
  const queryClient = useQueryClient();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
  const canSeeAudit = me?.user?.role === "admin" || me?.user?.role === "auditor";

  const navLinks = [
    { href: "/", icon: LayoutDashboard, label: "Dashboard", show: true },
    { href: "/documents/upload", icon: Plus, label: "New Document", show: true },
    { href: "/admin/users", icon: Users, label: "Users", show: isAdmin },
    { href: "/admin/audit", icon: ClipboardList, label: "Audit Log", show: canSeeAudit },
  ].filter(l => l.show);

  return (
    <div className="min-h-[100dvh] flex flex-col bg-background">
      <header className="sticky top-0 z-30 w-full border-b bg-card/80 backdrop-blur-sm">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center shrink-0">
            <div className="rounded-lg bg-[#1c325d] px-3 py-1.5">
              <img src="/sos-logo.png" alt="SOS Children's Villages Palestine" className="h-7 w-auto object-contain" />
            </div>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden md:flex items-center gap-1">
            {navLinks.map(l => (
              <NavLink key={l.href} href={l.href} icon={l.icon} label={l.label} active={location === l.href} />
            ))}
          </nav>

          <div className="flex items-center gap-2 ml-auto">
            <SavedSignatureDialog>
              <Button variant="ghost" size="sm" className="hidden sm:flex gap-1.5 text-muted-foreground hover:text-foreground" title="My saved signature">
                <PenLine className="h-4 w-4" />
                <span className="text-xs font-medium">Signature</span>
              </Button>
            </SavedSignatureDialog>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-2 rounded-full pl-1 pr-2 py-1 hover:bg-muted transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-7 w-7">
                    <AvatarFallback className="bg-primary text-primary-foreground text-xs font-semibold">{initials}</AvatarFallback>
                  </Avatar>
                  <span className="hidden sm:inline text-sm font-medium text-foreground max-w-28 truncate">{me?.user?.name}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <div className="px-2 py-1.5 space-y-1">
                  <p className="text-xs font-medium text-foreground truncate">{me?.user?.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{me?.user?.email}</p>
                  <div className="pt-0.5">
                    {me?.user?.role === "admin" && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-primary/10 text-primary border border-primary/20">Admin</span>
                    )}
                    {me?.user?.role === "auditor" && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-teal-50 text-teal-700 border border-teal-200">Auditor</span>
                    )}
                    {me?.user?.role === "user" && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-muted text-muted-foreground border">User</span>
                    )}
                  </div>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="text-destructive focus:text-destructive gap-2">
                  <LogOut className="h-3.5 w-3.5" />
                  Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Mobile hamburger */}
            <Sheet open={mobileMenuOpen} onOpenChange={setMobileMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden h-8 w-8" aria-label="Open navigation menu">
                  {mobileMenuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-72 pt-12">
                <nav className="flex flex-col gap-1">
                  {navLinks.map(l => (
                    <MobileNavLink
                      key={l.href}
                      href={l.href}
                      icon={l.icon}
                      label={l.label}
                      active={location === l.href}
                      onClick={() => setMobileMenuOpen(false)}
                    />
                  ))}
                  <div className="mt-4 pt-4 border-t">
                    <SavedSignatureDialog>
                      <button
                        className="flex items-center gap-3 text-base font-medium px-3 py-3 rounded-lg w-full text-foreground hover:bg-muted transition-all"
                        onClick={() => setMobileMenuOpen(false)}
                      >
                        <PenLine className="h-5 w-5" />
                        My Signature
                      </button>
                    </SavedSignatureDialog>
                    <button
                      onClick={() => { handleLogout(); setMobileMenuOpen(false); }}
                      className="flex items-center gap-3 text-base font-medium px-3 py-3 rounded-lg w-full text-destructive hover:bg-destructive/10 transition-all"
                    >
                      <LogOut className="h-5 w-5" />
                      Sign out
                    </button>
                  </div>
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-4 md:py-8">
        {children}
      </main>
    </div>
  );
}
