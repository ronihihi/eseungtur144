import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { format } from "date-fns";
import {
  ArrowLeft, Send, Plus, Trash2, Mail, CheckCircle2,
  Clock, BellRing, Copy, Check, Save, FileText, Download, RefreshCw,
  PenLine, Pen, CalendarDays, Type, Grip, ShieldCheck, ShieldX, Activity, MessageSquare,
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
  useDeleteDocument,
  getListDocumentsQueryKey,
} from "@workspace/api-client-react";
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
import { useQueryClient, useQuery, useMutation } from "@tanstack/react-query";

const RECIPIENT_COLORS = [
  { bg: "rgba(59,130,246,0.15)",  border: "#3b82f6", text: "#1d4ed8" },
  { bg: "rgba(16,185,129,0.15)",  border: "#10b981", text: "#065f46" },
  { bg: "rgba(245,158,11,0.15)",  border: "#f59e0b", text: "#78350f" },
  { bg: "rgba(239,68,68,0.15)",   border: "#ef4444", text: "#991b1b" },
  { bg: "rgba(168,85,247,0.15)",  border: "#a855f7", text: "#6b21a8" },
  { bg: "rgba(20,184,166,0.15)",  border: "#14b8a6", text: "#0f766e" },
  { bg: "rgba(249,115,22,0.15)",  border: "#f97316", text: "#9a3412" },
  { bg: "rgba(236,72,153,0.15)",  border: "#ec4899", text: "#9d174d" },
  { bg: "rgba(99,102,241,0.15)",  border: "#6366f1", text: "#3730a3" },
  { bg: "rgba(234,179,8,0.15)",   border: "#eab308", text: "#713f12" },
  { bg: "rgba(20,184,166,0.15)",  border: "#0d9488", text: "#134e4a" },
  { bg: "rgba(239,68,68,0.15)",   border: "#dc2626", text: "#7f1d1d" },
  { bg: "rgba(37,99,235,0.15)",   border: "#2563eb", text: "#1e3a8a" },
  { bg: "rgba(5,150,105,0.15)",   border: "#059669", text: "#064e3b" },
  { bg: "rgba(217,119,6,0.15)",   border: "#d97706", text: "#78350f" },
  { bg: "rgba(124,58,237,0.15)",  border: "#7c3aed", text: "#4c1d95" },
  { bg: "rgba(6,182,212,0.15)",   border: "#06b6d4", text: "#164e63" },
  { bg: "rgba(251,146,60,0.15)",  border: "#fb923c", text: "#7c2d12" },
  { bg: "rgba(52,211,153,0.15)",  border: "#34d399", text: "#064e3b" },
  { bg: "rgba(167,139,250,0.15)", border: "#a78bfa", text: "#4c1d95" },
];

type FieldType = "signature" | "initials" | "date" | "text";

interface FieldItem {
  id: string;
  documentId: string;
  recipientId: string;
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fieldType: FieldType;
  fieldValue?: string | null;
}

const FIELD_TYPES: { type: FieldType; label: string; icon: React.ElementType; defaultW: number; defaultH: number }[] = [
  { type: "signature", label: "Signature", icon: PenLine, defaultW: 0.22, defaultH: 0.06 },
  { type: "initials", label: "Initials", icon: Pen, defaultW: 0.08, defaultH: 0.038 },
  { type: "date", label: "Date Signed", icon: CalendarDays, defaultW: 0.13, defaultH: 0.032 },
  { type: "text", label: "Text", icon: Type, defaultW: 0.16, defaultH: 0.032 },
];

const FIELD_TYPE_LABEL: Record<FieldType, string> = {
  signature: "Sign", initials: "Init", date: "Date", text: "Text",
};

const recipientsSchema = z.object({
  recipients: z
    .array(z.object({
      teamName: z.string().min(1, "Name is required"),
      email: z.string().email("Valid email required"),
      requiresReview: z.boolean().optional(),
      requiresSignature: z.boolean().optional(),
    }))
    .min(1, "At least one recipient is required")
    .max(20, "Maximum 20 recipients allowed"),
});

const sendSchema = z.object({
  subject: z.string().optional(),
  message: z.string().optional(),
});

function DownloadButton({ docId, filename, variant = "outline", label = "Download" }: {
  docId: string;
  filename: string;
  variant?: "outline" | "default";
  label?: string;
}) {
  const [isDownloading, setIsDownloading] = useState(false);
  const { toast } = useToast();

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const res = await fetch(`/api/documents/${docId}/download`, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error ?? "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ variant: "destructive", title: "Download failed", description: (err as Error).message });
    } finally {
      setIsDownloading(false);
    }
  };

  return (
    <Button variant={variant} size="sm" onClick={() => void handleDownload()} disabled={isDownloading}>
      {isDownloading
        ? <><RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />Generating…</>
        : <><Download className="mr-1.5 h-3.5 w-3.5" />{label}</>
      }
    </Button>
  );
}

export function DocumentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  const deleteMutation = useDeleteDocument();

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

  const remindAllMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/documents/${id}/remind-all`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? "Failed to send reminders");
      }
      return res.json() as Promise<{ sent: number; errors: string[] }>;
    },
    onSuccess: (data) => {
      if (data.sent === 0) {
        toast({ title: "No reminders sent", description: "All recipients have already completed their action." });
      } else {
        toast({
          title: `Reminder${data.sent !== 1 ? "s" : ""} sent`,
          description: `Notified ${data.sent} recipient${data.sent !== 1 ? "s" : ""}${data.errors.length > 0 ? ` (${data.errors.length} failed)` : ""}.`,
        });
      }
    },
    onError: (err: Error) => toast({ variant: "destructive", title: "Failed to send reminders", description: err.message }),
  });
  const saveFieldsMutation = useSaveDocumentFields();

  const [sendDialogOpen, setSendDialogOpen] = useState(false);
  const [selectedRecipientId, setSelectedRecipientId] = useState<string>("");
  const [localFields, setLocalFields] = useState<FieldItem[]>([]);
  const [fieldsDirty, setFieldsDirty] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [draggingFieldType, setDraggingFieldType] = useState<FieldType | null>(null);
  const [activeFieldType, setActiveFieldType] = useState<FieldType | null>(null);

  const form = useForm<z.infer<typeof recipientsSchema>>({
    resolver: zodResolver(recipientsSchema),
    defaultValues: { recipients: [{ teamName: "", email: "" }] },
  });

  const sendForm = useForm<z.infer<typeof sendSchema>>({
    resolver: zodResolver(sendSchema),
    defaultValues: { subject: "", message: "" },
  });

  const { fields: formFields, append, remove } = useFieldArray({ control: form.control, name: "recipients" });

  const recipientsInitialized = useRef(false);
  useEffect(() => {
    if (detailData?.recipients && detailData.recipients.length > 0 && isDraft && !recipientsInitialized.current) {
      recipientsInitialized.current = true;
      form.reset({
        recipients: detailData.recipients.map((r) => ({
          teamName: r.teamName,
          email: r.email,
          requiresReview: (r as { requiresReview?: boolean }).requiresReview ?? false,
          requiresSignature: (r as { requiresSignature?: boolean }).requiresSignature ?? true,
        })),
      });
    }
  }, [detailData, isDraft, form]);

  const sendFormInitialized = useRef(false);
  useEffect(() => {
    if (doc?.title && !sendFormInitialized.current) {
      sendFormInitialized.current = true;
      sendForm.reset({
        subject: `Signature Request: ${doc.title}`,
        message: `Please review and sign the document "${doc.title}".`,
      });
    }
  }, [doc?.title, sendForm]);

  useEffect(() => {
    if (detailData?.fields) {
      setLocalFields(
        (detailData.fields as FieldItem[]).map((f) => ({
          ...f,
          fieldType: (f.fieldType as FieldType) ?? "signature",
          fieldValue: (f as { fieldValue?: string | null }).fieldValue ?? null,
        }))
      );
      setFieldsDirty(false);
    }
  }, [detailData?.fields]);

  useEffect(() => {
    if (recipients.length > 0) {
      const isValid = recipients.some((r) => r.id === selectedRecipientId);
      if (!isValid) {
        setSelectedRecipientId(recipients[0].id);
      }
    }
  }, [recipients]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === "Escape") setActiveFieldType(null);
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const pdfUrl = useMemo(() => ({ url: `/api/documents/${id}/file`, withCredentials: true }), [id]);

  const getRecipientColor = (recipientId: string) => {
    const idx = recipients.findIndex((r) => r.id === recipientId);
    return RECIPIENT_COLORS[idx >= 0 ? idx % RECIPIENT_COLORS.length : 0];
  };

  const placeField = (fieldType: FieldType, rawX: number, rawY: number) => {
    if (!isDraft || !selectedRecipientId) return;
    const config = FIELD_TYPES.find((ft) => ft.type === fieldType);
    if (!config) return;
    const x = Math.max(0, Math.min(1 - config.defaultW, rawX - config.defaultW / 2));
    const y = Math.max(0, Math.min(1 - config.defaultH, rawY - config.defaultH / 2));
    setLocalFields((prev) => [
      ...prev,
      {
        id: `temp-${Date.now()}-${Math.random()}`,
        documentId: id,
        recipientId: selectedRecipientId,
        page: currentPage,
        x, y,
        width: config.defaultW,
        height: config.defaultH,
        fieldType,
      },
    ]);
    setFieldsDirty(true);
  };

  const handleFieldDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!isDraft || !selectedRecipientId) return;
    const fieldType = (e.dataTransfer.getData("fieldType") || draggingFieldType) as FieldType | null;
    if (!fieldType) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const rawX = (e.clientX - rect.left) / rect.width;
    const rawY = (e.clientY - rect.top) / rect.height;
    placeField(fieldType, rawX, rawY);
    setDraggingFieldType(null);
  };

  const handlePdfClick = (rawX: number, rawY: number) => {
    if (!activeFieldType) return;
    placeField(activeFieldType, rawX, rawY);
    setActiveFieldType(null);
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
            fieldType: f.fieldType,
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
      {
        id,
        data: {
          recipients: values.recipients.map((r) => ({
            teamName: r.teamName,
            email: r.email,
            requiresReview: r.requiresReview ?? false,
            requiresSignature: r.requiresSignature ?? true,
          })),
        },
      },
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
          const typeLabel = FIELD_TYPE_LABEL[f.fieldType] ?? "Sign";
          const isSigned = !!f.fieldValue;
          const isSignImg = isSigned && (f.fieldType === "signature" || f.fieldType === "initials") && f.fieldValue!.startsWith("data:image");
          const isText = isSigned && (f.fieldType === "text" || f.fieldType === "date");

          return (
            <div
              key={f.id}
              className="absolute pointer-events-auto flex items-center justify-center rounded overflow-hidden group"
              style={{
                left: `${f.x * 100}%`,
                top: `${f.y * 100}%`,
                width: `${f.width * 100}%`,
                height: `${f.height * 100}%`,
                background: isSigned ? "rgba(34,197,94,0.10)" : color.bg,
                border: `2px ${isSigned ? "solid #22c55e" : `dashed ${color.border}`}`,
                cursor: isDraft ? "pointer" : "default",
              }}
              title={isDraft ? `Click to remove (${typeLabel} for ${recipient?.teamName})` : `${recipient?.teamName}${isSigned ? " – Signed" : ""}`}
              onClick={(e) => {
                if (isDraft) { e.stopPropagation(); removeField(f.id); }
              }}
            >
              {isSignImg ? (
                <img src={f.fieldValue!} alt="Signature" className="max-h-full max-w-full object-contain p-0.5" />
              ) : isText ? (
                <span className="text-[9px] font-semibold truncate px-1 select-none text-green-800">
                  {f.fieldValue}
                </span>
              ) : (
                <span
                  className="text-[10px] font-semibold truncate px-1 leading-none select-none"
                  style={{ color: color.text }}
                >
                  {typeLabel} · {recipient?.teamName || "?"}
                </span>
              )}
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

  const isPdf = doc.filename.toLowerCase().endsWith(".pdf");

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <Link href="/">
          <Button variant="outline" size="sm" className="mb-4 gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Home
          </Button>
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
              <DownloadButton docId={id} filename={doc.filename} />
            )}
            {isDraft && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1.5">
                    <Trash2 className="h-3.5 w-3.5" />
                    Delete
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
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      onClick={() => {
                        deleteMutation.mutate(
                          { id },
                          {
                            onSuccess: () => {
                              queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
                              toast({ title: "Document deleted" });
                              navigate("/");
                            },
                            onError: (err: unknown) => {
                              toast({ variant: "destructive", title: "Failed to delete", description: (err as { error?: string })?.error });
                            },
                          }
                        );
                      }}
                    >
                      Delete
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {isDraft && (
              <Dialog open={sendDialogOpen} onOpenChange={setSendDialogOpen}>
                <DialogTrigger asChild>
                  <Button
                    disabled={!detailData?.recipients?.length}
                    onClick={(e) => {
                      if (fieldsDirty && localFields.length > 0) {
                        e.preventDefault();
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
                                fieldType: f.fieldType,
                              })),
                            },
                          },
                          {
                            onSuccess: () => { setFieldsDirty(false); setSendDialogOpen(true); },
                            onError: () => setSendDialogOpen(true),
                          }
                        );
                      }
                    }}
                  >
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
              {isDraft && selectedRecipientId && activeFieldType && (
                <div className="flex items-center justify-between gap-2 p-3 bg-primary/10 border-2 border-primary/40 rounded-lg text-sm animate-pulse-slow">
                  <span className="text-primary font-medium flex items-center gap-2">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
                    Click anywhere on the PDF to place a <strong>{FIELD_TYPES.find(f=>f.type===activeFieldType)?.label}</strong> field for{" "}
                    <strong style={{ color: getRecipientColor(selectedRecipientId).text }}>
                      {recipients.find((r) => r.id === selectedRecipientId)?.teamName}
                    </strong>
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveFieldType(null)}
                    className="text-xs text-muted-foreground hover:text-foreground underline shrink-0"
                  >
                    Cancel (Esc)
                  </button>
                </div>
              )}
              {isDraft && selectedRecipientId && draggingFieldType && !activeFieldType && (
                <div className="flex items-center gap-2 p-3 bg-primary/5 border border-primary/20 rounded-lg text-sm">
                  <Grip className="h-4 w-4 text-primary shrink-0" />
                  <span className="text-muted-foreground">
                    Drop the field anywhere on the PDF for{" "}
                    <strong style={{ color: getRecipientColor(selectedRecipientId).text }}>
                      {recipients.find((r) => r.id === selectedRecipientId)?.teamName}
                    </strong>.
                  </span>
                </div>
              )}
              {isDraft && !selectedRecipientId && recipients.length === 0 && (
                <div className="flex items-center gap-2 p-3 bg-muted rounded-lg text-sm text-muted-foreground">
                  <Grip className="h-4 w-4 shrink-0" />
                  Add recipients first, then click or drag field types onto the PDF.
                </div>
              )}
              <PdfViewer
                fileUrl={pdfUrl}
                currentPage={currentPage}
                numPages={numPages}
                onLoadSuccess={setNumPages}
                onPageChange={setCurrentPage}
                renderOverlay={renderFieldOverlay}
                onDrop={handleFieldDrop}
                onDragOver={(e) => e.preventDefault()}
                onCanvasClick={isDraft && selectedRecipientId && activeFieldType ? handlePdfClick : undefined}
                clickable={!!(isDraft && selectedRecipientId && activeFieldType)}
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
                <DownloadButton docId={id} filename={doc.filename} variant="default" label="Download to view" />
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
                    <CardTitle className="text-base">Place Fields</CardTitle>
                    <CardDescription className="text-xs">
                      Select a recipient, then drag a field type onto the document.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {/* Recipient selector */}
                    <div className="space-y-2">
                      {recipients.map((r, idx) => {
                        const color = RECIPIENT_COLORS[idx % RECIPIENT_COLORS.length];
                        const fieldCount = localFields.filter((f) => f.recipientId === r.id).length;
                        return (
                          <button
                            key={r.id}
                            type="button"
                            onClick={() => setSelectedRecipientId(r.id)}
                            className={`w-full flex items-center justify-between p-2.5 rounded-lg border-2 text-left transition-colors ${
                              selectedRecipientId === r.id
                                ? "border-primary bg-primary/5"
                                : "border-border hover:border-primary/40"
                            }`}
                          >
                            <div className="flex items-center gap-2">
                              <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: color.border }} />
                              <span className="text-sm font-medium">{r.teamName}</span>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {fieldCount} field{fieldCount !== 1 ? "s" : ""}
                            </span>
                          </button>
                        );
                      })}
                    </div>

                    {/* Field type palette */}
                    {selectedRecipientId ? (
                      <>
                        <p className="text-xs font-medium text-muted-foreground">Click a field type, then click the PDF to place it:</p>
                        <div className="grid grid-cols-2 gap-2">
                          {FIELD_TYPES.map((ft) => {
                            const Icon = ft.icon;
                            const isActive = activeFieldType === ft.type;
                            return (
                              <div
                                key={ft.type}
                                draggable
                                role="button"
                                tabIndex={0}
                                onClick={() => setActiveFieldType(isActive ? null : ft.type)}
                                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setActiveFieldType(isActive ? null : ft.type); }}}
                                onDragStart={(e) => {
                                  setDraggingFieldType(ft.type);
                                  setActiveFieldType(null);
                                  e.dataTransfer.setData("fieldType", ft.type);
                                  e.dataTransfer.effectAllowed = "copy";
                                }}
                                onDragEnd={() => setDraggingFieldType(null)}
                                className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 cursor-pointer active:scale-95 transition-all select-none ${
                                  isActive
                                    ? "border-primary bg-primary/10 shadow-sm ring-2 ring-primary/30"
                                    : "border-dashed border-border hover:border-primary/60 hover:bg-primary/5 cursor-grab active:cursor-grabbing"
                                }`}
                              >
                                <Icon className={`h-4 w-4 ${isActive ? "text-primary" : "text-muted-foreground"}`} />
                                <span className={`text-[11px] font-medium text-center leading-tight ${isActive ? "text-primary" : "text-foreground"}`}>{ft.label}</span>
                                {isActive && <span className="text-[9px] text-primary font-semibold uppercase tracking-wide">Active</span>}
                              </div>
                            );
                          })}
                        </div>
                        <p className="text-[11px] text-muted-foreground text-center">
                          Or drag a field onto the PDF. Click a placed field to remove it.
                        </p>
                      </>
                    ) : (
                      <p className="text-xs text-muted-foreground text-center py-1">
                        Select a recipient above to add fields.
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Recipients Form */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Recipients</CardTitle>
                  <CardDescription className="text-xs">Up to 20 people who need to sign.</CardDescription>
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
                            <div className="flex gap-3 pt-1">
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded border-gray-300 text-primary"
                                  checked={form.watch(`recipients.${index}.requiresReview`) ?? false}
                                  onChange={(e) => form.setValue(`recipients.${index}.requiresReview`, e.target.checked)}
                                />
                                <span className="text-xs text-muted-foreground">Reviewer</span>
                              </label>
                              <label className="flex items-center gap-1.5 cursor-pointer">
                                <input
                                  type="checkbox"
                                  className="h-3.5 w-3.5 rounded border-gray-300 text-primary"
                                  checked={form.watch(`recipients.${index}.requiresSignature`) ?? true}
                                  onChange={(e) => form.setValue(`recipients.${index}.requiresSignature`, e.target.checked)}
                                />
                                <span className="text-xs text-muted-foreground">Signer</span>
                              </label>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="flex items-center justify-between">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => append({ teamName: "", email: "", requiresReview: false, requiresSignature: true })}
                          disabled={formFields.length >= 20}
                        >
                          <Plus className="mr-1 h-3.5 w-3.5" />
                          Add ({formFields.length}/20)
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
                <CardHeader className="flex flex-row items-center justify-between pb-3">
                  <CardTitle className="text-base">Signers</CardTitle>
                  {recipients.some((r) => r.status !== "signed") && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 text-xs gap-1.5"
                      onClick={() => remindAllMutation.mutate()}
                      disabled={remindAllMutation.isPending}
                    >
                      <BellRing className="h-3 w-3" />
                      {remindAllMutation.isPending ? "Sending…" : "Remind All"}
                    </Button>
                  )}
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {recipients.map((recipient, idx) => {
                      const rExt = recipient as {
                        reviewStatus?: string;
                        reviewNote?: string | null;
                      };
                      const hasNote = (rExt.reviewStatus === "changes_requested" || rExt.reviewStatus === "approved") && rExt.reviewNote;
                      const statusDate = recipient.signedAt ?? recipient.viewedAt;
                      const formattedDate = statusDate ? format(new Date(statusDate), "MMM d, h:mm a") : null;
                      return (
                        <div key={recipient.id} className="rounded-lg border overflow-hidden">
                          {/* Main row */}
                          <div className="flex items-start gap-2.5 p-3">
                            {/* Sequential number */}
                            {doc.signingOrder === "sequential" && (
                              <div
                                className="h-5 w-5 mt-0.5 shrink-0 rounded-full flex items-center justify-center text-white text-[10px] font-bold"
                                style={{ background: RECIPIENT_COLORS[idx % RECIPIENT_COLORS.length].border }}
                              >
                                {idx + 1}
                              </div>
                            )}

                            {/* Info block */}
                            <div className="flex-1 min-w-0 space-y-0.5">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="text-sm font-semibold">{recipient.teamName}</span>
                                {rExt.reviewStatus === "approved" && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-green-50 text-green-700 border border-green-200">
                                    <ShieldCheck className="h-2.5 w-2.5" /> Approved
                                  </span>
                                )}
                                {rExt.reviewStatus === "changes_requested" && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-orange-50 text-orange-700 border border-orange-200">
                                    <ShieldX className="h-2.5 w-2.5" /> Changes requested
                                  </span>
                                )}
                                {!(rExt.reviewStatus === "approved" || rExt.reviewStatus === "changes_requested") && (
                                  <RecipientStatusBadge status={recipient.status} />
                                )}
                              </div>
                              <div className="text-xs text-muted-foreground flex items-center gap-1 truncate">
                                <Mail className="h-3 w-3 shrink-0" />
                                <span className="truncate">{recipient.email}</span>
                              </div>
                              {recipient.signerName && (
                                <div className="text-xs text-muted-foreground flex items-center gap-1">
                                  <PenLine className="h-3 w-3 shrink-0" />
                                  Signed by <strong className="font-medium text-foreground">{recipient.signerName}</strong>
                                </div>
                              )}
                              {formattedDate && (
                                <div className="text-[11px] text-muted-foreground/70">{formattedDate}</div>
                              )}
                            </div>

                            {/* Action buttons */}
                            <div className="flex items-center gap-1 shrink-0">
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                title="Copy signing link"
                                onClick={() => handleCopyLink(recipient.token)}
                              >
                                {copiedLink === recipient.token ? (
                                  <Check className="h-3.5 w-3.5 text-green-500" />
                                ) : (
                                  <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                                )}
                              </Button>
                              {recipient.status !== "signed" && (
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7"
                                  title="Send reminder"
                                  onClick={() => handleRemind(recipient.id)}
                                  disabled={remindMutation.isPending}
                                >
                                  <BellRing className="h-3.5 w-3.5 text-muted-foreground" />
                                </Button>
                              )}
                            </div>
                          </div>

                          {/* Note footer */}
                          {hasNote && (
                            <div className={`border-t px-3 py-2 flex gap-2 ${rExt.reviewStatus === "approved" ? "border-green-200 bg-green-50" : "border-amber-200 bg-amber-50"}`}>
                              <MessageSquare className={`h-3.5 w-3.5 shrink-0 mt-px ${rExt.reviewStatus === "approved" ? "text-green-500" : "text-amber-500"}`} />
                              <p className={`text-xs whitespace-pre-wrap break-words leading-relaxed ${rExt.reviewStatus === "approved" ? "text-green-800" : "text-amber-800"}`}>{rExt.reviewNote}</p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>

              {/* Activity Log */}
              <ActivityLog documentId={id} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

interface ActivityEvent {
  id: string;
  eventType: string;
  actorName?: string | null;
  actorEmail?: string | null;
  createdAt: string;
  metadata?: unknown;
}

function ActivityLog({ documentId }: { documentId: string }) {
  const { data, isLoading } = useQuery<{ events: ActivityEvent[] }>({
    queryKey: ["document-activity", documentId],
    queryFn: async () => {
      const res = await fetch(`/api/documents/${documentId}/activity`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load activity");
      return res.json();
    },
    refetchInterval: 10000,
  });

  const events = data?.events ?? [];

  function eventIcon(type: string) {
    switch (type) {
      case "review_approved": return <ShieldCheck className="h-3.5 w-3.5 text-green-500 shrink-0" />;
      case "review_changes_requested": return <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0" />;
      case "signed": return <CheckCircle2 className="h-3.5 w-3.5 text-blue-500 shrink-0" />;
      case "completed": return <CheckCircle2 className="h-3.5 w-3.5 text-green-600 shrink-0" />;
      case "sealed": return <ShieldCheck className="h-3.5 w-3.5 text-slate-500 shrink-0" />;
      default: return <Activity className="h-3.5 w-3.5 text-muted-foreground shrink-0" />;
    }
  }

  function eventLabel(type: string) {
    switch (type) {
      case "sent_for_review": return "Sent for review";
      case "review_approved": return "Approved";
      case "review_changes_requested": return "Changes requested";
      case "signed": return "Signed";
      case "completed": return "Completed";
      case "sealed": return "PDF sealed";
      default: return type.replace(/_/g, " ");
    }
  }

  if (isLoading || events.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Activity className="h-4 w-4" />
          Activity Log
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          {events.map((e) => (
            <div key={e.id} className="flex items-start gap-2.5 text-sm">
              <div className="mt-0.5">{eventIcon(e.eventType)}</div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium capitalize">{eventLabel(e.eventType)}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {format(new Date(e.createdAt), "MMM d, h:mm a")}
                  </span>
                </div>
                {e.actorName && e.actorName !== "System" && (
                  <p className="text-xs text-muted-foreground truncate">{e.actorName}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
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
    case "in_review":
      return (
        <Badge variant="secondary" className="bg-amber-500/10 text-amber-600 border-transparent">
          <Clock className="mr-1 h-3 w-3" /> In Review
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
