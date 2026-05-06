import { useState, useEffect } from "react";
import { useParams, Link } from "wouter";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import {
  ArrowLeft, Send, Plus, Trash2, Mail, CheckCircle2,
  Clock, BellRing, Copy, Check, MousePointerClick, Save, FileText, Download,
} from "lucide-react";

import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogHeader,
  DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { PdfViewer } from "@/components/pdf-viewer";

import {
  useGetDocument,
  getGetDocumentQueryKey,
  useSetRecipients,
  useSendDocument,
  useRemindRecipient,
  useGetDocumentStatus,
  getGetDocumentStatusQueryKey,
  useSaveDocumentFields,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

const RECIPIENT_COLORS = [
  { bg: "rgba(59,130,246,0.15)", border: "#3b82f6", text: "#1d4ed8" },
  { bg: "rgba(16,185,129,0.15)", border: "#10b981", text: "#065f46" },
  { bg: "rgba(245,158,11,0.15)", border: "#f59e0b", text: "#78350f" },
  { bg: "rgba(239,68,68,0.15)", border: "#ef4444", text: "#991b1b" },
  { bg: "rgba(168,85,247,0.15)", border: "#a855f7", text: "#6b21a8" },
  { bg: "rgba(20,184,166,0.15)", border: "#14b8a6", text: "#0f766e" },
  { bg: "rgba(249,115,22,0.15)", border: "#f97316", text: "#9a3412" },
];

interface FieldItem {
  id: string;
  documentId: string;
  recipientId: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

const recipientsSchema = z.object({
  recipients: z
    .array(z.object({ teamName: z.string().min(1, "Name is required"), email: z.string().email("Valid email required") }))
    .min(1, "At least one recipient is required")
    .max(7, "Maximum 7 recipients allowed"),
});

const sendSchema = z.object({
  subject: z.string().optional(),
  message: z.string().optional(),
});

export function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: detailData, isLoading } = useGetDocument(id, {
    query: { enabled: !!id, queryKey: getGetDocumentQueryKey(id) },
  });

  const doc = detailData?.document;
  const recipients = detailData?.recipients ?? [];
  const isDraft = doc?.status === "draft";
  const isSent = doc?.status === "sent";

  useGetDocumentStatus(id, { query: { enabled: isSent, refetchInterval: 5000, queryKey: getGetDocumentStatusQueryKey(id) } });

  const setRecipientsMutation = useSetRecipients();
  const sendDocumentMutation = useSendDocument();
  const remindMutation = useRemindRecipient();
  const saveFieldsMutation = useSaveDocumentFields();

  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [selectedRecipientId, setSelectedRecipientId] = useState<string>("");
  const [localFields, setLocalFields] = useState<FieldItem[]>([]);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);

  const form = useForm<z.infer<typeof recipientsSchema>>({
    resolver: zodResolver(recipientsSchema),
    defaultValues: { recipients: [{ teamName: "", email: "" }] },
  });

  const sendForm = useForm<z.infer<typeof sendSchema>>({
    resolver: zodResolver(sendSchema),
    defaultValues: { subject: "", message: "" },
  });

  const { fields: formFields, append, remove } = useFieldArray({ control: form.control, name: "recipients" });

  useEffect(() => {
    if (detailData?.recipients && detailData.recipients.length > 0 && isDraft) {
      form.reset({ recipients: detailData.recipients.map((r) => ({ teamName: r.teamName, email: r.email })) });
    }
  }, [detailData, isDraft, form]);

  useEffect(() => {
    if (doc?.title) {
      sendForm.reset({
        subject: `Signature Request: ${doc.title}`,
        message: `Please review and sign the document "${doc.title}".`,
      });
    }
  }, [doc?.title, sendForm]);

  useEffect(() => {
    if (detailData?.fields) {
      setLocalFields(detailData.fields as FieldItem[]);
      setFieldsDirty(false);
    }
  }, [detailData?.fields]);

  useEffect(() => {
    if (recipients.length > 0 && !selectedRecipientId) {
      setSelectedRecipientId(recipients[0].id);
    }
  }, [recipients, selectedRecipientId]);

  const getRecipientColor = (recipientId: string) => {
    const idx = recipients.findIndex((r) => r.id === recipientId);
    return RECIPIENT_COLORS[idx >= 0 ? idx % RECIPIENT_COLORS.length : 0];
  };

  const handlePdfClick = (x: number, y: number) => {
    if (!isDraft || !selectedRecipientId) return;
    const newField: FieldItem = {
      id: `temp-${Date.now()}-${Math.random()}`,
      documentId: id,
      recipientId: selectedRecipientId,
      page: currentPage,
      x,
      y,
      width: 0.28,
      height: 0.065,
    };
    // One field per recipient — replace any existing field for this person
    setLocalFields((prev) => [
      ...prev.filter((f) => f.recipientId !== selectedRecipientId),
      newField,
    ]);
    setFieldsDirty(true);
  };

  const removeField = (fieldId: string) => {
    setLocalFields((prev) => prev.filter((f) => f.id !== fieldId));
    setFieldsDirty(true);
  };

  const handleSaveFields = () => {
    saveFieldsMutation.mutate(
      {
        id,
        data: {
          fields: localFields.map((f) => ({
            recipientId: f.recipientId,
            page: f.page,
            x: f.x,
            y: f.y,
            width: f.width,
            height: f.height,
          })),
        },
      },
      {
        onSuccess: () => {
          setFieldsDirty(false);
          queryClient.invalidateQueries({ queryKey: getGetDocumentQueryKey(id) });
          toast({ title: "Signature fields saved" });
        },
        onError: () => toast({ variant: "destructive", title: "Failed to save fields" }),
      }
    );
  };

  const onSaveRecipients = (values: z.infer<typeof recipientsSchema>) => {
    setRecipientsMutation.mutate(
      { id, data: values },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDocumentQueryKey(id) });
          toast({ title: "Recipients saved" });
        },
        onError: (err: unknown) => toast({ variant: "destructive", title: "Error saving recipients", description: (err as { error?: string })?.error }),
      }
    );
  };

  const onSendDocument = (values: z.infer<typeof sendSchema>) => {
    sendDocumentMutation.mutate(
      { id, data: values },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getGetDocumentQueryKey(id) });
          setSendDialogOpen(false);
          toast({ title: "Document sent successfully!" });
        },
        onError: (err: unknown) => toast({ variant: "destructive", title: "Failed to send", description: (err as { error?: string })?.error }),
      }
    );
  };

  const handleRemind = (recipientId: string) => {
    remindMutation.mutate(
      { recipientId },
      {
        onSuccess: () => toast({ title: "Reminder sent" }),
        onError: (err: unknown) => toast({ variant: "destructive", title: "Failed to send reminder", description: (err as { error?: string })?.error }),
      }
    );
  };

  const handleCopyLink = (token: string) => {
    const url = `${window.location.origin}/sign/${token}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopiedLink(token);
      toast({ title: "Link copied to clipboard" });
      setTimeout(() => setCopiedLink(null), 2000);
    });
  };

  const renderFieldOverlay = () => (
    <>
      {localFields
        .filter((f) => f.page === currentPage)
        .map((f) => {
          const color = getRecipientColor(f.recipientId);
          const recipient = recipients.find((r) => r.id === f.recipientId);
          return (
            <div
              key={f.id}
              className="absolute pointer-events-auto flex items-center justify-center rounded"
              style={{
                left: `${f.x * 100}%`,
                top: `${f.y * 100}%`,
                width: `${f.width * 100}%`,
                height: `${f.height * 100}%`,
                background: color.bg,
                border: `2px dashed ${color.border}`,
                cursor: isDraft ? "pointer" : "default",
              }}
              title={isDraft ? `Click to remove "${recipient?.teamName}" field` : recipient?.teamName}
              onClick={(e) => {
                if (isDraft) {
                  e.stopPropagation();
                  removeField(f.id);
                }
              }}
            >
              <span
                className="text-[10px] font-semibold truncate px-1 leading-none select-none"
                style={{ color: color.text }}
              >
                ✎ {recipient?.teamName || "?"}
              </span>
            </div>
          );
        })}
    </>
  );

  if (isLoading) {
    return (
      <div className="space-y-6 max-w-7xl mx-auto">
        <Skeleton className="h-8 w-1/3" />
        <div className="grid lg:grid-cols-[1fr_340px] gap-6">
          <Skeleton className="h-[600px] w-full" />
          <div className="space-y-4">
            <Skeleton className="h-48 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="text-center py-12">
        <h2 className="text-2xl font-bold">Document not found</h2>
        <Link href="/"><Button variant="link" className="mt-4">Return to dashboard</Button></Link>
      </div>
    );
  }

  const pdfUrl = { url: `/api/documents/${id}/file`, withCredentials: true };
  const isPdf = doc.filename.toLowerCase().endsWith(".pdf");

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <Link href="/" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary mb-4 transition-colors">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Dashboard
        </Link>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{doc.title}</h1>
            <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
              <span>{doc.filename}</span>
              <span>•</span>
              <span>{format(new Date(doc.createdAt), "MMM d, yyyy")}</span>
              <span>•</span>
              <span className="capitalize">{doc.signingOrder}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge status={doc.status} />
            {isPdf && (
              <a href={`/api/documents/${id}/file`} download={doc.filename}>
                <Button variant="outline" size="sm">
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Download
                </Button>
              </a>
            )}
            {isDraft && (
              <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
                <DialogTrigger asChild>
                  <Button disabled={!detailData?.recipients?.length}>
                    <Send className="mr-2 h-4 w-4" />
                    Send for Signature
                  </Button>
                </DialogTrigger>
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Send Document</DialogTitle>
                    <DialogDescription>
                      Each recipient will receive a unique email with their personal signing link.
                    </DialogDescription>
                  </DialogHeader>
                  <Form {...sendForm}>
                    <form onSubmit={sendForm.handleSubmit(onSendDocument)} className="space-y-4 py-4">
                      <FormField control={sendForm.control} name="subject" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Email Subject</FormLabel>
                          <FormControl><Input {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <FormField control={sendForm.control} name="message" render={({ field }) => (
                        <FormItem>
                          <FormLabel>Message (Optional)</FormLabel>
                          <FormControl><Textarea rows={4} {...field} /></FormControl>
                        </FormItem>
                      )} />
                      <DialogFooter>
                        <Button variant="outline" type="button" onClick={() => setSendDialogOpen(false)}>Cancel</Button>
                        <Button type="submit" disabled={sendDocumentMutation.isPending}>
                          {sendDocumentMutation.isPending ? "Sending…" : "Send Now"}
                        </Button>
                      </DialogFooter>
                    </form>
                  </Form>
                </DialogContent>
              </Dialog>
            )}
          </div>
        </div>
      </div>

      {/* Main Layout */}
      <div className="grid lg:grid-cols-[1fr_340px] gap-6 items-start">
        {/* Left: PDF Viewer */}
        <div className="space-y-3">
          {isPdf ? (
            <>
              {isDraft && selectedRecipientId && (
                <div className="flex items-center gap-2 p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm">
                  <MousePointerClick className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-muted-foreground">
                    Click anywhere on the PDF to place{" "}
                    <strong style={{ color: getRecipientColor(selectedRecipientId).text }}>
                      {recipients.find((r) => r.id === selectedRecipientId)?.teamName}
                    </strong>
                    's signature field. Each person gets one field — clicking moves it.
                  </span>
                </div>
              )}
              {isDraft && !selectedRecipientId && recipients.length === 0 && (
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg text-sm text-muted-foreground">
                  <MousePointerClick className="h-4 w-4 shrink-0" />
                  Add recipients first, then click the PDF to place their signature fields.
                </div>
              )}
              <PdfViewer
                fileUrl={pdfUrl}
                currentPage={currentPage}
                numPages={numPages}
                onLoadSuccess={setNumPages}
                onPageChange={setCurrentPage}
                onCanvasClick={handlePdfClick}
                renderOverlay={renderFieldOverlay}
                clickable={isDraft && !!selectedRecipientId}
              />
              {fieldsDirty && (
                <Button onClick={handleSaveFields} disabled={saveFieldsMutation.isPending} className="w-full" variant="secondary">
                  <Save className="mr-2 h-4 w-4" />
                  {saveFieldsMutation.isPending ? "Saving…" : "Save Signature Fields"}
                </Button>
              )}
            </>
          ) : (
            <Card>
              <CardContent className="flex flex-col items-center justify-center gap-4 p-12 text-center">
                <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center">
                  <FileText className="h-8 w-8 text-muted-foreground" />
                </div>
                <div className="space-y-1">
                  <p className="font-semibold text-foreground">{doc.filename}</p>
                  <p className="text-sm text-muted-foreground">
                    In-browser preview is only available for PDF files.
                  </p>
                </div>
                <a
                  href={`/api/documents/${id}/file`}
                  download={doc.filename}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <FileText className="h-4 w-4" />
                  Download to view
                </a>
                <p className="text-xs text-muted-foreground max-w-xs">
                  To use signature field placement, convert your document to PDF before uploading.
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right: Controls Panel */}
        <div className="space-y-5">
          {isDraft ? (
            <>
              {/* Field Placement Controls */}
              {recipients.length > 0 && isPdf && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Place Signature Fields</CardTitle>
                    <CardDescription className="text-xs">
                      Select a person, then click the PDF where they should sign.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {recipients.map((r, idx) => {
                      const color = RECIPIENT_COLORS[idx % RECIPIENT_COLORS.length];
                      const fieldCount = localFields.filter((f) => f.recipientId === r.id).length;
                      return (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedRecipientId(r.id)}
                          className={`w-full flex items-center justify-between p-3 rounded-lg border-2 text-left transition-colors ${
                            selectedRecipientId === r.id
                              ? "border-primary bg-primary/5"
                              : "border-border hover:border-primary/40"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <div
                              className="h-3 w-3 rounded-full shrink-0"
                              style={{ background: color.border }}
                            />
                            <span className="text-sm font-medium">{r.teamName}</span>
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {fieldCount} field{fieldCount !== 1 ? "s" : ""}
                          </span>
                        </button>
                      );
                    })}
                  </CardContent>
                </Card>
              )}

              {/* Recipients Form */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Recipients</CardTitle>
                  <CardDescription className="text-xs">Up to 7 people who need to sign.</CardDescription>
                </CardHeader>
                <CardContent>
                  <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSaveRecipients)} className="space-y-4">
                      <div className="space-y-3">
                        {formFields.map((field, index) => (
                          <div
                            key={field.id}
                            className="space-y-2 p-3 rounded-lg border bg-muted/20"
                          >
                            {doc.signingOrder === "sequential" && (
                              <div
                                className="h-5 w-5 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
                                style={{ background: RECIPIENT_COLORS[index % RECIPIENT_COLORS.length].border }}
                              >
                                {index + 1}
                              </div>
                            )}
                            <div className="flex gap-2">
                              <FormField
                                control={form.control}
                                name={`recipients.${index}.teamName`}
                                render={({ field }) => (
                                  <FormItem className="flex-1">
                                    <FormControl>
                                      <Input placeholder="Name / Role" {...field} className="text-sm h-8" />
                                    </FormControl>
                                    <FormMessage className="text-xs" />
                                  </FormItem>
                                )}
                              />
                              {formFields.length > 1 && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                                  onClick={() => remove(index)}
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </Button>
                              )}
                            </div>
                            <FormField
                              control={form.control}
                              name={`recipients.${index}.email`}
                              render={({ field }) => (
                                <FormItem>
                                  <FormControl>
                                    <Input type="email" placeholder="email@example.com" {...field} className="text-sm h-8" />
                                  </FormControl>
                                  <FormMessage className="text-xs" />
                                </FormItem>
                              )}
                            />
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center justify-between">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => append({ teamName: "", email: "" })}
                          disabled={formFields.length >= 7}
                        >
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          Add ({formFields.length}/7)
                        </Button>
                        <Button type="submit" size="sm" disabled={setRecipientsMutation.isPending}>
                          {setRecipientsMutation.isPending ? "Saving…" : "Save Recipients"}
                        </Button>
                      </div>
                    </form>
                  </Form>
                </CardContent>
              </Card>
            </>
          ) : (
            <>
              {/* Summary */}
              <Card>
                <CardHeader><CardTitle className="text-base">Progress</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Signatures</span>
                    <span className="font-semibold">{doc.signedCount} / {doc.totalRecipients}</span>
                  </div>
                  <div className="h-2 w-full bg-secondary rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all duration-500"
                      style={{ width: `${doc.totalRecipients > 0 ? (doc.signedCount / doc.totalRecipients) * 100 : 0}%` }}
                    />
                  </div>
                  <Separator />
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Uploaded by</span>
                      <span className="font-medium">{doc.uploaderName}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Created</span>
                      <span className="font-medium">{format(new Date(doc.createdAt), "MMM d, yyyy")}</span>
                    </div>
                    {doc.completedAt && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Completed</span>
                        <span className="font-medium">{format(new Date(doc.completedAt), "MMM d, yyyy")}</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>

              {/* Recipients Status */}
              <Card>
                <CardHeader><CardTitle className="text-base">Signers</CardTitle></CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {recipients.map((recipient, idx) => (
                      <div key={recipient.id} className="flex items-center justify-between gap-3 p-3 rounded-lg border">
                        <div className="flex items-center gap-2 min-w-0">
                          {doc.signingOrder === "sequential" && (
                            <div
                              className="h-5 w-5 shrink-0 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
                              style={{ background: RECIPIENT_COLORS[idx % RECIPIENT_COLORS.length].border }}
                            >
                              {idx + 1}
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="text-sm font-medium truncate">{recipient.teamName}</div>
                            <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
                              <Mail className="h-3 w-3 shrink-0" />{recipient.email}
                            </div>
                            {recipient.signerName && (
                              <div className="text-xs text-muted-foreground">Signed by {recipient.signerName}</div>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <RecipientStatusBadge status={recipient.status} date={recipient.signedAt ?? recipient.viewedAt} />
                          <Button
                            variant="outline"
                            size="icon"
                            className="h-7 w-7"
                            title="Copy signing link"
                            onClick={() => handleCopyLink(recipient.token)}
                          >
                            {copiedLink === recipient.token ? (
                              <Check className="h-3 w-3 text-green-500" />
                            ) : (
                              <Copy className="h-3 w-3" />
                            )}
                          </Button>
                          {recipient.status !== "signed" && (
                            <Button
                              variant="secondary"
                              size="icon"
                              className="h-7 w-7"
                              title="Send reminder"
                              onClick={() => handleRemind(recipient.id)}
                              disabled={remindMutation.isPending}
                            >
                              <BellRing className="h-3 w-3" />
                            </Button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <Badge className="bg-green-500 hover:bg-green-600 text-white border-transparent">
          <CheckCircle2 className="mr-1 h-3 w-3" /> Completed
        </Badge>
      );
    case "sent":
      return (
        <Badge variant="secondary" className="bg-blue-500/10 text-blue-600 border-transparent">
          <Send className="mr-1 h-3 w-3" /> Out for Signature
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <FileText className="mr-1 h-3 w-3" /> Draft
        </Badge>
      );
  }
}

function RecipientStatusBadge({ status, date }: { status: string; date?: string | null }) {
  const formatted = date ? format(new Date(date), "MMM d, h:mm a") : "";
  switch (status) {
    case "signed":
      return (
        <div className="text-right">
          <Badge className="bg-green-500/10 text-green-700 border-transparent text-[10px]">
            <CheckCircle2 className="mr-1 h-2.5 w-2.5" /> Signed
          </Badge>
          {formatted && <div className="text-[9px] text-muted-foreground mt-0.5">{formatted}</div>}
        </div>
      );
    case "viewed":
      return (
        <div className="text-right">
          <Badge variant="secondary" className="bg-amber-500/10 text-amber-700 border-transparent text-[10px]">
            <Clock className="mr-1 h-2.5 w-2.5" /> Viewed
          </Badge>
          {formatted && <div className="text-[9px] text-muted-foreground mt-0.5">{formatted}</div>}
        </div>
      );
    default:
      return (
        <Badge variant="outline" className="text-muted-foreground text-[10px]">
          <Clock className="mr-1 h-2.5 w-2.5" /> Pending
        </Badge>
      );
  }
}
