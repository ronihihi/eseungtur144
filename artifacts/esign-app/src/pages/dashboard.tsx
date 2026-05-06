import { useListDocuments, useGetMySigningRequests } from "@workspace/api-client-react";
import { Link } from "wouter";
import { format, formatDistanceToNow } from "date-fns";
import { Plus, FileText, CheckCircle2, Clock, Send, FileSignature, Trash2, PenLine, Eye, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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

  return (
    <div className="space-y-8">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">Manage your documents and signature requests.</p>
        </div>
        <Link href="/documents/upload">
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Upload Document
          </Button>
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Documents</CardTitle>
            <FileText className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-12" /> : <div className="text-2xl font-bold">{totalDocuments}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completed</CardTitle>
            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-12" /> : <div className="text-2xl font-bold">{completedDocuments}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pending Signatures</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-7 w-12" /> : <div className="text-2xl font-bold">{pendingDocuments}</div>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Awaiting My Signature</CardTitle>
            <PenLine className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {signingLoading ? <Skeleton className="h-7 w-12" /> : <div className="text-2xl font-bold">{pendingSignatures}</div>}
          </CardContent>
        </Card>
      </div>

      {/* Documents sent to me to sign */}
      {(signingLoading || signingRequests.length > 0) && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight">Documents to Sign</h2>
            {pendingSignatures > 0 && (
              <Badge variant="default" className="bg-orange-500 hover:bg-orange-600 text-white border-transparent">
                {pendingSignatures} pending
              </Badge>
            )}
          </div>

          {signingLoading ? (
            <div className="space-y-3">
              {[1, 2].map((i) => (
                <Card key={i}>
                  <CardContent className="p-5">
                    <div className="flex items-center justify-between">
                      <div className="space-y-2">
                        <Skeleton className="h-5 w-48" />
                        <Skeleton className="h-4 w-32" />
                      </div>
                      <Skeleton className="h-9 w-24" />
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <div className="grid gap-3">
              {signingRequests.map((req) => {
                const isPending = req.recipientStatus !== "signed";
                return (
                  <Card
                    key={req.token}
                    className={`transition-colors ${isPending ? "border-orange-200 bg-orange-50/30 dark:border-orange-900/40 dark:bg-orange-950/10" : ""}`}
                  >
                    <CardContent className="p-0">
                      <div className="flex flex-col sm:flex-row sm:items-center justify-between p-5 gap-3">
                        <div className="flex items-start gap-3">
                          <div
                            className={`h-9 w-9 rounded-lg flex items-center justify-center shrink-0 ${
                              isPending ? "bg-orange-100 dark:bg-orange-900/30" : "bg-green-100 dark:bg-green-900/30"
                            }`}
                          >
                            {isPending ? (
                              <PenLine className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                            ) : (
                              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                            )}
                          </div>
                          <div className="space-y-0.5">
                            <p className="font-semibold leading-snug">{req.documentTitle}</p>
                            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted-foreground">
                              <span>From {req.senderName}</span>
                              {req.sentAt && (
                                <>
                                  <span>•</span>
                                  <span>{formatDistanceToNow(new Date(req.sentAt), { addSuffix: true })}</span>
                                </>
                              )}
                              {req.signedAt && (
                                <>
                                  <span>•</span>
                                  <span>Signed {format(new Date(req.signedAt), "MMM d, yyyy")}</span>
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-3 sm:ml-auto shrink-0">
                          <SigningStatusBadge status={req.recipientStatus} />
                          {isPending ? (
                            <Link href={`/sign/${req.token}`}>
                              <Button size="sm" className="bg-orange-500 hover:bg-orange-600 text-white">
                                <PenLine className="mr-1.5 h-3.5 w-3.5" />
                                Sign Now
                              </Button>
                            </Link>
                          ) : (
                            <Link href={`/sign/${req.token}`}>
                              <Button size="sm" variant="outline">
                                <Eye className="mr-1.5 h-3.5 w-3.5" />
                                View
                              </Button>
                            </Link>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Documents I uploaded */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold tracking-tight">My Documents</h2>

        {isLoading ? (
          <div className="space-y-4">
            {[1, 2, 3].map((i) => (
              <Card key={i}>
                <CardContent className="p-6">
                  <div className="flex items-center justify-between">
                    <div className="space-y-2">
                      <Skeleton className="h-5 w-48" />
                      <Skeleton className="h-4 w-32" />
                    </div>
                    <Skeleton className="h-9 w-24" />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : documents.length === 0 ? (
          <Card className="border-dashed bg-muted/50">
            <CardContent className="flex flex-col items-center justify-center p-12 text-center">
              <div className="h-12 w-12 rounded-full bg-primary/10 flex items-center justify-center mb-4">
                <FileText className="h-6 w-6 text-primary" />
              </div>
              <h3 className="text-lg font-semibold mb-2">No documents yet</h3>
              <p className="text-muted-foreground max-w-sm mb-6">
                Upload a document to start collecting signatures from your team or clients.
              </p>
              <Link href="/documents/upload">
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  Upload First Document
                </Button>
              </Link>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {documents.map((doc) => (
              <Card key={doc.id} className="group hover:border-primary/50 transition-colors">
                <CardContent className="p-0">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between p-6 gap-4">
                    <div className="flex items-start gap-4">
                      <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                        <FileText className="h-5 w-5 text-primary" />
                      </div>
                      <div className="space-y-1">
                        <Link href={`/documents/${doc.id}`} className="font-semibold hover:underline focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 rounded-sm">
                          {doc.title}
                        </Link>
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                          <span>{doc.filename}</span>
                          <span>•</span>
                          <span>Created {format(new Date(doc.createdAt), "MMM d, yyyy")}</span>
                          <span>•</span>
                          <span>
                            {doc.signedCount} / {doc.totalRecipients} signed
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-4 sm:ml-auto shrink-0">
                      <StatusBadge status={doc.status} />

                      <div className="flex items-center gap-2">
                        <Link href={`/documents/${doc.id}`}>
                          <Button variant="secondary" size="sm">
                            View
                          </Button>
                        </Link>

                        {(doc.status === "completed" || doc.status === "sent") && (
                          <a href={`/api/documents/${doc.id}/download`} download={doc.filename}>
                            <Button variant="outline" size="sm">
                              <Download className="mr-1.5 h-3.5 w-3.5" />
                              Download
                            </Button>
                          </a>
                        )}

                        <AlertDialog>
                          <AlertDialogTrigger asChild>
                            <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive">
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </AlertDialogTrigger>
                          <AlertDialogContent>
                            <AlertDialogHeader>
                              <AlertDialogTitle>Delete Document</AlertDialogTitle>
                              <AlertDialogDescription>
                                Are you sure you want to delete "{doc.title}"? This action cannot be undone and will cancel any pending signature requests.
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
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function SigningStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "signed":
      return (
        <Badge variant="default" className="bg-green-500 hover:bg-green-600 text-white border-transparent">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Signed
        </Badge>
      );
    case "viewed":
      return (
        <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 border-transparent">
          <Eye className="mr-1 h-3 w-3" />
          Viewed
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-orange-600 border-orange-300 bg-orange-50 dark:bg-orange-950/20">
          <Clock className="mr-1 h-3 w-3" />
          Pending
        </Badge>
      );
  }
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge variant="default" className="bg-green-500 hover:bg-green-600 text-white border-transparent">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Completed
        </Badge>
      );
    case "sent":
      return (
        <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 hover:bg-blue-500/20 border-transparent">
          <Send className="mr-1 h-3 w-3" />
          Sent
        </Badge>
      );
    case "draft":
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <FileSignature className="mr-1 h-3 w-3" />
          Draft
        </Badge>
      );
  }
}
