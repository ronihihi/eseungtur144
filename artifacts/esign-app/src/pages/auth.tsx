import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useLogin, useRegister, useGetAzureEnabled, getGetMeQueryKey } from "@workspace/api-client-react";
import type { MeResponse } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { FileSignature, ShieldCheck, Zap, Users } from "lucide-react";

const loginSchema = z.object({
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(1, "Password is required"),
});

const registerSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

function MicrosoftIcon() {
  return (
    <svg className="h-4 w-4 mr-2" viewBox="0 0 21 21" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}

const FEATURES = [
  { icon: FileSignature, text: "Collect legally binding e-signatures" },
  { icon: Users, text: "Invite up to 7 recipients per document" },
  { icon: Zap, text: "Sequential or simultaneous signing flows" },
  { icon: ShieldCheck, text: "Full audit trail with timestamps & IPs" },
];

export function AuthPage() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const redirectTo = params.get("redirect") || "/";
  const urlError = params.get("error");
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isLogin, setIsLogin] = useState(true);

  const loginMutation = useLogin();
  const registerMutation = useRegister();
  const { data: azureConfig } = useGetAzureEnabled();

  useEffect(() => {
    if (urlError) {
      const messages: Record<string, string> = {
        invalid_state: "Sign-in session expired. Please try again.",
        azure_failed: "Microsoft sign-in failed. Please try again.",
        access_denied: "Access was denied. Please contact your administrator.",
      };
      toast({
        variant: "destructive",
        title: "Sign-in error",
        description: messages[urlError] ?? "An error occurred during sign-in.",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loginForm = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  const registerForm = useForm<z.infer<typeof registerSchema>>({
    resolver: zodResolver(registerSchema),
    defaultValues: { name: "", email: "", password: "" },
  });

  const onLoginSubmit = (values: z.infer<typeof loginSchema>) => {
    loginMutation.mutate(
      { data: values },
      {
        onSuccess: (data) => {
          queryClient.setQueryData<MeResponse>(getGetMeQueryKey(), { user: data.user });
          setLocation(redirectTo);
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Login failed",
            description: (err as { error?: string })?.error || "Please check your credentials and try again.",
          });
        },
      }
    );
  };

  const onRegisterSubmit = (values: z.infer<typeof registerSchema>) => {
    registerMutation.mutate(
      { data: values },
      {
        onSuccess: (data) => {
          queryClient.setQueryData<MeResponse>(getGetMeQueryKey(), { user: data.user });
          setLocation(redirectTo);
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Registration failed",
            description: (err as { error?: string })?.error || "An error occurred during registration.",
          });
        },
      }
    );
  };

  const handleMicrosoftSignIn = () => {
    window.location.href = "/api/auth/azure";
  };

  return (
    <div className="min-h-[100dvh] flex">
      {/* Left brand panel */}
      <div className="hidden lg:flex lg:w-[46%] flex-col justify-between p-12 relative overflow-hidden"
        style={{ background: "linear-gradient(145deg, hsl(207 100% 9%), hsl(203 100% 16%))" }}>
        <div className="absolute inset-0 opacity-[0.06]"
          style={{ backgroundImage: "radial-gradient(circle at 60% 40%, hsl(198 100% 44%), transparent 60%)" }} />

        <div className="relative z-10 flex items-center gap-2.5">
          <div className="h-9 w-9 rounded-xl bg-primary flex items-center justify-center shadow-lg">
            <FileSignature className="h-5 w-5 text-white" />
          </div>
          <span className="text-white font-bold text-lg tracking-tight">WorkflowSign</span>
        </div>

        <div className="relative z-10 space-y-8">
          <div className="space-y-3">
            <h2 className="text-white text-3xl font-bold leading-tight">
              Signatures your whole team can trust
            </h2>
            <p className="text-white/60 text-base leading-relaxed">
              Send, sign, and track documents from anywhere — no printing, no faxing, no waiting.
            </p>
          </div>

          <ul className="space-y-4">
            {FEATURES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-center gap-3">
                <div className="h-8 w-8 rounded-lg bg-white/10 flex items-center justify-center shrink-0">
                  <Icon className="h-4 w-4 text-primary" />
                </div>
                <span className="text-white/80 text-sm">{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-white/30 text-xs">
          © {new Date().getFullYear()} WorkflowSign
        </p>
      </div>

      {/* Right form panel */}
      <div className="flex-1 flex items-center justify-center bg-muted/30 p-6 lg:p-12">
        <div className="w-full max-w-sm space-y-7">

          {/* Mobile logo */}
          <div className="flex flex-col items-center gap-2 text-center lg:hidden">
            <div className="h-11 w-11 rounded-xl bg-primary flex items-center justify-center shadow">
              <FileSignature className="h-6 w-6 text-primary-foreground" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">WorkflowSign</h1>
            <p className="text-muted-foreground text-sm">Professional document signing for teams</p>
          </div>

          <div className="space-y-1">
            <h2 className="text-2xl font-bold tracking-tight text-foreground">
              {isLogin ? "Welcome back" : "Create an account"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {isLogin ? "Sign in to continue to your workspace" : "Enter your details to get started"}
            </p>
          </div>

          <div className="space-y-4">
            {azureConfig?.enabled && (
              <>
                <Button type="button" variant="outline" className="w-full h-10" onClick={handleMicrosoftSignIn}>
                  <MicrosoftIcon />
                  Sign in with Microsoft
                </Button>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-muted/30 px-2 text-muted-foreground">Or continue with email</span>
                  </div>
                </div>
              </>
            )}

            {isLogin ? (
              <Form {...loginForm} key="login">
                <form onSubmit={loginForm.handleSubmit(onLoginSubmit)} className="space-y-4">
                  <FormField
                    control={loginForm.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input placeholder="name@example.com" type="email" autoComplete="email" className="h-10" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={loginForm.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="current-password" className="h-10" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full h-10" disabled={loginMutation.isPending}>
                    {loginMutation.isPending ? "Signing in…" : "Sign in"}
                  </Button>
                </form>
              </Form>
            ) : (
              <Form {...registerForm} key="register">
                <form onSubmit={registerForm.handleSubmit(onRegisterSubmit)} className="space-y-4">
                  <FormField
                    control={registerForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Full name</FormLabel>
                        <FormControl>
                          <Input placeholder="Jane Smith" autoComplete="name" className="h-10" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={registerForm.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Email</FormLabel>
                        <FormControl>
                          <Input placeholder="name@example.com" type="email" autoComplete="email" className="h-10" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={registerForm.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Password</FormLabel>
                        <FormControl>
                          <Input type="password" autoComplete="new-password" className="h-10" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" className="w-full h-10" disabled={registerMutation.isPending}>
                    {registerMutation.isPending ? "Creating account…" : "Create account"}
                  </Button>
                </form>
              </Form>
            )}
          </div>

          <p className="text-center text-sm text-muted-foreground">
            {isLogin ? "Don't have an account? " : "Already have an account? "}
            <button
              type="button"
              onClick={() => setIsLogin(!isLogin)}
              className="font-semibold text-primary hover:underline focus:outline-none"
            >
              {isLogin ? "Sign up" : "Sign in"}
            </button>
          </p>
        </div>
      </div>
    </div>
  );
}
