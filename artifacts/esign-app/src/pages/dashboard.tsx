import { useListDocuments, useGetMySigningRequests } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format, formatDistanceToNow } from "date-fns";
import { Plus, FileText, CheckCircle2, Clock, Send, FileSignature, Trash2, PenLine, Eye, Download, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeleteDocument, getListDocumentsQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
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

export function DashboardPage() {
  const { data, isLoading } = useListDocuments();
  const { data: signingData, isLoading: signingLoading } = useGetMySigningRequests();
  const documents = data?.documents || [];
  const signingRequests = signingData?.requests || [];
  const deleteMutation = useDeleteDocument();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const handleDelete = (id: string) => {
    deleteMutation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
          toast({ title: "Document deleted successfully" });
        },
        onError: (err: unknown) => {
          toast({ variant: "destructive", title: "Error deleting document", description: (err as { error?: string })?.error });
        },
      }
    );
  };

  const totalDocuments = documents.length;
  const completedDocuments = documents.filter((d) => d.status === "completed").length;
  const pendingDocuments = documents.filter((d) => d.status === "sent").length;
  const draftDocuments = documents.filter((d) => d.status === "draft").length;
  const pendingSignatures = signingRequests.filter((r) => r.recipientStatus !== "signed").length;

  const STATS = [
    {
      label: "Total Documents",
      value: totalDocuments,
      icon: FileText,
      color: "text-primary",
      bg: "bg-primary/10",
      loading: isLoading,
    },
    {
      label: "Completed",
      value: completedDocuments,
      icon: CheckCircle2,
      color: "text-green-600",
      bg: "bg-green-500/10",
      loading: isLoading,
    },
    {
      label: "Pending Signatures",
      value: pendingDocuments,
      icon: Clock,
      color: "text-orange-500",
      bg: "bg-orange-500/10",
      loading: isLoading,
    },
    {
      label: "Awaiting My Signature",
      value: pendingSignatures,
      icon: PenLine,
      color: "text-violet-600",
      bg: "bg-violet-500/10",
      loading: signingLoading,
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-0.5">Manage your documents and signature requests.</p>
        </div>
        <Link href="/documents/upload">
          <Button className="gap-2 shadow-sm">
            <Plus className="h-4 w-4" />
            Upload Document
          </Button>
        </Link>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {STATS.map(({ label, value, icon: Icon, color, bg, loading }) => (
          <div
            key={label}
            className="rounded-xl border bg-card p-5 space-y-3 shadow-sm hover:shadow-md transition-shadow"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</span>
              <div className={`h-8 w-8 rounded-lg ${bg} flex items-center justify-center`}>
                <Icon className={`h-4 w-4 ${color}`} />
              </div>
            </div>
            {loading ? (
              <Skeleton className="h-8 w-12" />
            ) : (
              <p className={`text-3xl font-bold ${color}`}>{value}</p>
            )}
          </div>
        ))}
      </div>

      {/* Documents sent to me to sign */}
      {(signingLoading || signingRequests.length > 0) && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold tracking-tight">Needs My Signature</h2>
            {pendingSignatures > 0 && (
              <Badge className="bg-orange-500 hover:bg-orange-600 text-white border-transparent text-xs">
                {pendingSignatures} pending
              </Badge>
            )}
          </div>

          {signingLoading ? (
            <div className="space-y-2">
              {[1, 2].map((i) => (
                <div key={i} className="rounded-xl border bg-card p-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-44" />
                      <Skeleton className="h-3 w-28" />
                    </div>
                    <Skeleton className="h-8 w-20" />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-2">
              {signingRequests.map((req) => {
                const isPending = req.recipientStatus !== "signed";
                return (
                  <div
                    key={req.token}
                    className={`rounded-xl border flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3 transition-colors ${
                      isPending
                        ? "border-orange-200 bg-orange-50/40 dark:border-orange-900/40 dark:bg-orange-950/10"
                        : "bg-card"
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <div className={`h-8 w-8 rounded-lg flex items-center justify-center shrink-0 ${
                        isPending ? "bg-orange-100 dark:bg-orange-900/30" : "bg-green-100 dark:bg-green-900/30"
                      }`}>
                        {isPending
                          ? <PenLine className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                          : <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                        }
                      </div>
                      <div className="space-y-0.5 min-w-0">
                        <p className="font-semibold text-sm leading-snug truncate">{req.documentTitle}</p>
                        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-muted-foreground">
                          <span>From {req.senderName}</span>
                          {req.sentAt && (
                            <>
                              <span>·</span>
                              <span>{formatDistanceToNow(new Date(req.sentAt), { addSuffix: true })}</span>
                            </>
                          )}
                          {req.signedAt && (
                            <>
                              <span>·</span>
                              <span>Signed {format(new Date(req.signedAt), "MMM d, yyyy")}</span>
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 sm:ml-auto shrink-0">
                      <SigningStatusBadge status={req.recipientStatus} />
                      {isPending ? (
                        <Link href={`/sign/${req.token}`}>
                          <Button size="sm" className="bg-orange-500 hover:bg-orange-600 text-white gap-1.5 h-8">
                            <PenLine className="h-3.5 w-3.5" />
                            Sign Now
                          </Button>
                        </Link>
                      ) : (
                        <Link href={`/sign/${req.token}`}>
                          <Button size="sm" variant="outline" className="gap-1.5 h-8">
                            <Eye className="h-3.5 w-3.5" />
                            View
                          </Button>
                        </Link>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* My documents */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-tight">My Documents</h2>
          {!isLoading && draftDocuments > 0 && (
            <span className="text-xs text-muted-foreground">{draftDocuments} draft{draftDocuments !== 1 ? "s" : ""}</span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="rounded-xl border bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-48" />
                    <Skeleton className="h-3 w-32" />
                  </div>
                  <Skeleton className="h-8 w-20" />
                </div>
              </div>
            ))}
          </div>
        ) : documents.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed bg-muted/30 flex flex-col items-center justify-center p-14 text-center">
            <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
              <FileText className="h-7 w-7 text-primary" />
            </div>
            <h3 className="text-base font-semibold mb-1">No documents yet</h3>
            <p className="text-muted-foreground text-sm max-w-xs mb-5">
              Upload a PDF or Word document to start collecting signatures from your team or clients.
            </p>
            <Link href="/documents/upload">
              <Button className="gap-2">
                <Plus className="h-4 w-4" />
                Upload First Document
              </Button>
            </Link>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => {
              const pct = doc.totalRecipients > 0 ? Math.round((doc.signedCount / doc.totalRecipients) * 100) : 0;
              return (
                <div
                  key={doc.id}
                  className="rounded-xl border bg-card hover:border-primary/40 hover:shadow-sm transition-all"
                >
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                        <FileText className="h-4.5 w-4.5 text-primary" />
                      </div>
                      <div className="space-y-1 min-w-0">
                        <Link
                          href={`/documents/${doc.id}`}
                          className="font-semibold text-sm hover:text-primary transition-colors truncate block focus:outline-none focus-visible:underline"
                        >
                          {doc.title}
                        </Link>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                          <span className="truncate max-w-[14rem]">{doc.filename}</span>
                          <span>·</span>
                          <span>{format(new Date(doc.createdAt), "MMM d, yyyy")}</span>
                        </div>
                        {doc.totalRecipients > 0 && doc.status !== "draft" && (
                          <div className="flex items-center gap-2 pt-0.5">
                            <div className="h-1.5 w-28 rounded-full bg-muted overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${pct === 100 ? "bg-green-500" : "bg-primary"}`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {doc.signedCount}/{doc.totalRecipients} signed
                            </span>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 sm:ml-auto shrink-0">
                      <StatusBadge status={doc.status} />

                      <Link href={`/documents/${doc.id}`}>
                        <Button variant="ghost" size="sm" className="gap-1.5 h-8 text-muted-foreground hover:text-foreground">
                          <ArrowRight className="h-3.5 w-3.5" />
                          Open
                        </Button>
                      </Link>

                      {(doc.status === "completed" || doc.status === "sent") && (
                        <a href={`/api/documents/${doc.id}/download`} download={doc.filename}>
                          <Button variant="outline" size="sm" className="gap-1.5 h-8">
                            <Download className="h-3.5 w-3.5" />
                            Download
                          </Button>
                        </a>
                      )}

                      {doc.status === "draft" && (
                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete Document</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete "{doc.title}"? This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel>Cancel</AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => handleDelete(doc.id)}
                                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              >
                                Delete
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function SigningStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "signed":
      return (
        <Badge className="bg-green-500/10 text-green-700 dark:text-green-400 border-green-200 dark:border-green-900/40 gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Signed
        </Badge>
      );
    case "viewed":
      return (
        <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-900/40 gap-1">
          <Eye className="h-3 w-3" />
          Viewed
        </Badge>
      );
    default:
      return (
        <Badge className="bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-200 dark:border-orange-900/40 gap-1">
          <Clock className="h-3 w-3" />
          Pending
        </Badge>
      );
  }
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge className="bg-green-500/10 text-green-700 dark:text-green-400 border-green-200 dark:border-green-900/40 gap-1">
          <CheckCircle2 className="h-3 w-3" />
          Completed
        </Badge>
      );
    case "sent":
      return (
        <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-900/40 gap-1">
          <Send className="h-3 w-3" />
          Sent
        </Badge>
      );
    case "draft":
    default:
      return (
        <Badge className="bg-muted text-muted-foreground border-border gap-1">
          <FileSignature className="h-3 w-3" />
          Draft
        </Badge>
      );
  }
}
