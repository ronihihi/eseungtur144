import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  useListAdminUsers,
  useCreateAdminUser,
  useDeleteAdminUser,
  useUpdateAdminUserRole,
} from "@workspace/api-client-react";
import type { AdminUser, UpdateRoleRequestRole } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Plus, Trash2, Shield, ShieldOff, Users } from "lucide-react";
import { useGetMe } from "@workspace/api-client-react";

const createUserSchema = z.object({
  name: z.string().min(2, "Name must be at least 2 characters"),
  email: z.string().email("Please enter a valid email"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: z.enum(["admin", "auditor", "user"]).default("user"),
});

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function ProviderBadge({ provider }: { provider: string }) {
  if (provider === "azure") {
    return (
      <Badge variant="secondary" className="gap-1 font-normal">
        <span className="text-[10px]">M</span> Microsoft
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="font-normal">
      Password
    </Badge>
  );
}

function RoleBadge({ role }: { role: string }) {
  if (role === "admin") return <Badge className="bg-primary/10 text-primary border-primary/20 hover:bg-primary/10">Admin</Badge>;
  if (role === "auditor") return <Badge className="bg-teal-50 text-teal-700 border-teal-200 hover:bg-teal-50">Auditor</Badge>;
  return <Badge variant="secondary">User</Badge>;
}

export function AdminUsersPage() {
  const { toast } = useToast();
  const { data: me } = useGetMe();
  const { data, refetch, isLoading } = useListAdminUsers();
  const createMutation = useCreateAdminUser();
  const deleteMutation = useDeleteAdminUser();
  const roleMutation = useUpdateAdminUserRole();

  const [createOpen, setCreateOpen] = useState(false);

  const form = useForm<z.infer<typeof createUserSchema>>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { name: "", email: "", password: "", role: "user" },
  });

  const onCreateSubmit = (values: z.infer<typeof createUserSchema>) => {
    createMutation.mutate(
      { data: values },
      {
        onSuccess: () => {
          toast({ title: "User created successfully" });
          form.reset();
          setCreateOpen(false);
          void refetch();
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Failed to create user",
            description: (err as { error?: string })?.error ?? "An error occurred.",
          });
        },
      }
    );
  };

  const handleDelete = (user: AdminUser) => {
    deleteMutation.mutate(
      { id: user.id },
      {
        onSuccess: () => {
          toast({ title: `${user.name} has been removed` });
          void refetch();
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Failed to delete user",
            description: (err as { error?: string })?.error ?? "An error occurred.",
          });
        },
      }
    );
  };

  const handleToggleRole = (user: AdminUser) => {
    const roleMap: Record<string, UpdateRoleRequestRole> = { admin: "user", auditor: "admin", user: "admin" };
    const newRole: UpdateRoleRequestRole = roleMap[user.role] ?? "user";
    const roleLabel: Record<string, string> = { admin: "an Admin", auditor: "an Auditor", user: "a User" };
    roleMutation.mutate(
      { id: user.id, data: { role: newRole } },
      {
        onSuccess: () => {
          toast({ title: `${user.name} is now ${roleLabel[newRole] ?? newRole}` });
          void refetch();
        },
        onError: (err: unknown) => {
          toast({
            variant: "destructive",
            title: "Failed to update role",
            description: (err as { error?: string })?.error ?? "An error occurred.",
          });
        },
      }
    );
  };

  const users = data?.users ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Users className="h-6 w-6 text-primary" />
            User Management
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage who has access to WorkFlowSign SOS Village Palestine
          </p>
        </div>

        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              Create User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create New User</DialogTitle>
              <DialogDescription>
                Add a new team member with email and password login.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onCreateSubmit)} className="space-y-4 mt-2">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Full Name</FormLabel>
                      <FormControl>
                        <Input placeholder="Jane Smith" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input placeholder="jane@company.com" type="email" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="password"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Temporary Password</FormLabel>
                      <FormControl>
                        <Input type="password" placeholder="At least 6 characters" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="role"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Role</FormLabel>
                      <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="user">User</SelectItem>
                          <SelectItem value="auditor">Auditor</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex justify-end gap-2 pt-2">
                  <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createMutation.isPending}>
                    {createMutation.isPending ? "Creating..." : "Create User"}
                  </Button>
                </div>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-medium">
            {users.length} {users.length === 1 ? "user" : "users"}
          </CardTitle>
          <CardDescription>
            Users can sign in with email/password or Microsoft SSO
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading users…</div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground">No users yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Sign-in</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => {
                  const isSelf = user.id === me?.user?.id;
                  return (
                    <TableRow key={user.id}>
                      <TableCell className="font-medium">
                        {user.name}
                        {isSelf && (
                          <span className="ml-2 text-xs text-muted-foreground">(you)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{user.email}</TableCell>
                      <TableCell>
                        <RoleBadge role={user.role} />
                      </TableCell>
                      <TableCell>
                        <ProviderBadge provider={user.provider} />
                      </TableCell>
                      <TableCell className="text-muted-foreground text-sm">
                        {formatDate(user.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            title={user.role === "admin" ? "Demote to user" : "Promote to admin"}
                            onClick={() => handleToggleRole(user)}
                            disabled={isSelf || roleMutation.isPending}
                          >
                            {user.role === "admin" ? (
                              <ShieldOff className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <Shield className="h-4 w-4 text-muted-foreground" />
                            )}
                          </Button>
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="sm"
                                disabled={isSelf || deleteMutation.isPending}
                                title="Delete user"
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Delete {user.name}?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  This will permanently remove their account and they will no longer be able to sign in. This cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancel</AlertDialogCancel>
                                <AlertDialogAction
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  onClick={() => handleDelete(user)}
                                >
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
