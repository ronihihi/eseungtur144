import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FileSignature, CheckCircle2, AlertCircle, Stamp, FileText, Download, PenLine, CalendarDays, Type } from "lucide-react";

import {
  useGetSigningInfo,
  getGetSigningInfoQueryKey,
  useSubmitSignature,
  useGetMe,
  useGetSavedSignature,
  getGetSavedSignatureQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardFooter, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SignaturePad } from "@/components/signature-pad";
import { PdfViewer } from "@/components/pdf-viewer";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";

const signatureSchema = z.object({
  fullName: z.string().min(2, "Full name is required"),
  signatureData: z.string().optional(),
});

type FieldType = "signature" | "initials" | "date" | "text";

const FIELD_COLORS: Record<FieldType, { bg: string; border: string; textColor: string; label: string }> = {
  signature: { bg: "rgba(245,158,11,0.18)", border: "#f59e0b", textColor: "#92400e", label: "Sign here" },
  initials: { bg: "rgba(139,92,246,0.15)", border: "#8b5cf6", textColor: "#5b21b6", label: "Initials" },
  date: { bg: "rgba(59,130,246,0.15)", border: "#3b82f6", textColor: "#1e3a8a", label: "Date" },
  text: { bg: "rgba(34,197,94,0.12)", border: "#22c55e", textColor: "#14532d", label: "Fill in" },
};

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

export function SignPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [success, setSuccess] = useState(false);
  const [submittedSig, setSubmittedSig] = useState<string>("");
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(1);
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});

  const { data, isLoading, isError, error } = useGetSigningInfo(token, {
    query: { enabled: !!token, queryKey: getGetSigningInfoQueryKey(token), retry: false },
  });

  const { data: meData } = useGetMe();
  const { data: savedSigData } = useGetSavedSignature({
    query: { enabled: !!meData?.user?.hasSavedSignature, queryKey: getGetSavedSignatureQueryKey() },
  });

  const submitSignatureMutation = useSubmitSignature();

  const form = useForm<z.infer<typeof signatureSchema>>({
    resolver: zodResolver(signatureSchema),
    defaultValues: { fullName: "", signatureData: "" },
  });

  const signatureData = form.watch("signatureData");

  const recipientFields = data?.fields ?? [];
  const isPdf = data?.documentFilename?.toLowerCase().endsWith(".pdf") ?? true;

  const hasSignatureFields = recipientFields.some(
    (f) => (f as { fieldType?: string }).fieldType === "signature" || (f as { fieldType?: string }).fieldType === "initials" || !(f as { fieldType?: string }).fieldType
  );
  const hasTextFields = recipientFields.filter((f) => (f as { fieldType?: string }).fieldType === "text");
  const hasDateFields = recipientFields.filter((f) => (f as { fieldType?: string }).fieldType === "date");

  // Pre-populate date fields with today's date
  useEffect(() => {
    if (hasDateFields.length > 0) {
      const today = todayISO();
      setFieldValues((prev) => {
        const next = { ...prev };
        for (const f of hasDateFields) {
          if (!next[(f as { id: string }).id]) {
            next[(f as { id: string }).id] = today;
          }
        }
        return next;
      });
    }
  }, [recipientFields.length]);

  const completedSig = submittedSig || data?.recipient?.signatureData || "";

  const isSubmitDisabled =
    submitSignatureMutation.isPending ||
    (hasSignatureFields && !signatureData) ||
    !form.watch("fullName");

  const onSubmit = (values: z.infer<typeof signatureSchema>) => {
    if (hasSignatureFields && !values.signatureData) {
      form.setError("signatureData", { message: "Signature is required" });
      return;
    }
    submitSignatureMutation.mutate(
      {
        token,
        data: {
          fullName: values.fullName,
          signatureData: values.signatureData ?? null,
          fieldValues: Object.keys(fieldValues).length > 0 ? fieldValues : undefined,
        },
      },
      {
        onSuccess: () => {
          setSubmittedSig(values.signatureData ?? "");
          setSuccess(true);
          queryClient.invalidateQueries({ queryKey: getGetSigningInfoQueryKey(token) });
        },
        onError: (err: unknown) => {
          toast({ variant: "destructive", title: "Submission failed", description: (err as { error?: string })?.error });
        },
      }
    );
  };

  const useSavedSignature = () => {
    if (savedSigData?.signatureData) {
      form.setValue("signatureData", savedSigData.signatureData);
      form.clearErrors("signatureData");
      toast({ title: "Saved signature applied" });
    }
  };

  const renderSigningOverlay = () => (
    <>
      {recipientFields
        .filter((f) => f.page === currentPage)
        .map((f, idx) => {
          const ft = ((f as { fieldType?: string }).fieldType || "signature") as FieldType;
          const cfg = FIELD_COLORS[ft];
          const fieldId = (f as { id?: string }).id;
          const currentVal = fieldId ? fieldValues[fieldId] : undefined;
          return (
            <div
              key={idx}
              className="absolute pointer-events-none flex items-center justify-center rounded"
              style={{
                left: `${f.x * 100}%`,
                top: `${f.y * 100}%`,
                width: `${f.width * 100}%`,
                height: `${f.height * 100}%`,
                background: cfg.bg,
                border: `2px dashed ${cfg.border}`,
              }}
            >
              {ft === "date" && currentVal ? (
                <span className="text-[9px] font-semibold truncate px-1 select-none" style={{ color: cfg.textColor }}>
                  {currentVal}
                </span>
              ) : ft === "text" && currentVal ? (
                <span className="text-[9px] font-semibold truncate px-1 select-none" style={{ color: cfg.textColor }}>
                  {currentVal}
                </span>
              ) : (
                <span className="text-[10px] font-semibold select-none" style={{ color: cfg.textColor }}>
                  {cfg.label}
                </span>
              )}
            </div>
          );
        })}
    </>
  );

  const renderCompletedOverlay = () => (
    <>
      {recipientFields
        .filter((f) => f.page === currentPage)
        .map((f, idx) => {
          const ft = ((f as { fieldType?: string }).fieldType || "signature") as FieldType;
          const fieldId = (f as { id?: string }).id;
          const storedVal = fieldId ? fieldValues[fieldId] : undefined;
          return (
            <div
              key={idx}
              className="absolute pointer-events-none flex items-center justify-center rounded"
              style={{
                left: `${f.x * 100}%`,
                top: `${f.y * 100}%`,
                width: `${f.width * 100}%`,
                height: `${f.height * 100}%`,
                background: "rgba(34,197,94,0.08)",
                border: "2px solid #22c55e",
              }}
            >
              {(ft === "signature" || ft === "initials") && completedSig ? (
                <img src={completedSig} alt="Signature" className="max-h-full max-w-full object-contain p-1" />
              ) : storedVal ? (
                <span className="text-[10px] font-semibold truncate px-1 select-none text-green-800">{storedVal}</span>
              ) : (
                <CheckCircle2 className="h-4 w-4 text-green-500" />
              )}
            </div>
          );
        })}
    </>
  );

  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-muted/30 p-4">
        <Card className="w-full max-w-lg">
          <CardHeader>
            <Skeleton className="h-8 w-3/4 mb-2" />
            <Skeleton className="h-4 w-1/2" />
          </CardHeader>
          <CardContent className="space-y-4">
            <Skeleton className="h-[400px] w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-40 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-muted/30 p-4">
        <Alert variant="destructive" className="w-full max-w-lg">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Invalid or Expired Link</AlertTitle>
          <AlertDescription>
            {(error as { error?: string })?.error || "This signing link is invalid or has already expired."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (data.alreadySigned || success) {
    return (
      <div className="min-h-[100dvh] flex flex-col bg-muted/30">
        <header className="bg-card border-b py-4 sticky top-0 z-10">
          <div className="container mx-auto px-4 flex items-center justify-between">
            <div className="flex items-center gap-2 font-semibold text-primary">
              <FileSignature className="h-5 w-5" />
              <span>WorkflowSign</span>
            </div>
            <a href={`/api/sign/${token}/download`} download={data.documentFilename || "document.pdf"}>
              <Button variant="outline" size="sm">
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Download
              </Button>
            </a>
          </div>
        </header>

        <main className="flex-1 container mx-auto px-4 py-6 max-w-4xl space-y-4">
          <Alert className="border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900/40">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            <AlertTitle className="text-green-800 dark:text-green-400">Document signed successfully</AlertTitle>
            <AlertDescription className="text-green-700 dark:text-green-500">
              Your signature has been securely recorded for <strong>"{data.documentTitle}"</strong>.
              The document is shown below with your signature applied.
            </AlertDescription>
          </Alert>

          {isPdf ? (
            <div className="space-y-4">
              {recipientFields.length > 0 && (
                <p className="text-sm text-muted-foreground flex items-center gap-1.5">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                  Your fields are shown at the highlighted locations below
                </p>
              )}
              <PdfViewer
                fileUrl={`/api/sign/${token}/file`}
                currentPage={currentPage}
                numPages={numPages}
                onLoadSuccess={setNumPages}
                onPageChange={setCurrentPage}
                renderOverlay={recipientFields.length > 0 ? renderCompletedOverlay : undefined}
              />
              {recipientFields.length === 0 && completedSig && (
                <div className="rounded-xl border border-green-200 bg-green-50 dark:bg-green-950/20 dark:border-green-900/40 p-4 space-y-2">
                  <p className="text-xs font-semibold text-green-700 dark:text-green-400 flex items-center gap-1.5">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Signature recorded for this document
                  </p>
                  <div className="bg-white dark:bg-black/20 rounded-lg border p-3 flex items-center justify-center">
                    <img src={completedSig} alt="Your signature" className="max-h-20 object-contain" />
                  </div>
                  {data.recipient.signerName && (
                    <p className="text-xs text-green-700 dark:text-green-500">
                      Signed by <strong>{data.recipient.signerName}</strong>
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : (
            <Card className="border-dashed">
              <CardContent className="flex flex-col items-center justify-center gap-4 py-12 text-center">
                <div className="h-16 w-16 rounded-2xl bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="h-8 w-8 text-green-600" />
                </div>
                <div className="space-y-1">
                  <p className="font-semibold">{data.documentFilename}</p>
                  <p className="text-sm text-muted-foreground">Your signature has been recorded.</p>
                </div>
                <a
                  href={`/api/sign/${token}/download`}
                  download={data.documentFilename || "document.pdf"}
                  className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <Download className="h-4 w-4" />
                  Download Document
                </a>
              </CardContent>
            </Card>
          )}
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] flex flex-col bg-muted/30">
      <header className="bg-card border-b py-4 sticky top-0 z-10">
        <div className="container mx-auto px-4 flex items-center gap-2 font-semibold text-primary">
          <FileSignature className="h-5 w-5" />
          <span>WorkflowSign</span>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8 max-w-5xl">
        <div className="grid lg:grid-cols-[1fr_380px] gap-8 items-start">
          {/* Left: Document Viewer */}
          <div className="space-y-3">
            <h2 className="font-semibold text-lg">{data.documentTitle}</h2>
            {isPdf ? (
              <>
                {recipientFields.length > 0 && (
                  <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                    {hasSignatureFields && (
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: FIELD_COLORS.signature.bg, border: `1.5px dashed ${FIELD_COLORS.signature.border}` }} />
                        Signature field
                      </span>
                    )}
                    {hasDateFields.length > 0 && (
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: FIELD_COLORS.date.bg, border: `1.5px dashed ${FIELD_COLORS.date.border}` }} />
                        Date field
                      </span>
                    )}
                    {hasTextFields.length > 0 && (
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: FIELD_COLORS.text.bg, border: `1.5px dashed ${FIELD_COLORS.text.border}` }} />
                        Text field
                      </span>
                    )}
                  </div>
                )}
                <PdfViewer
                  fileUrl={`/api/sign/${token}/file`}
                  currentPage={currentPage}
                  numPages={numPages}
                  onLoadSuccess={setNumPages}
                  onPageChange={setCurrentPage}
                  renderOverlay={recipientFields.length > 0 ? renderSigningOverlay : undefined}
                />
              </>
            ) : (
              <Card className="border-dashed">
                <CardContent className="flex flex-col items-center justify-center gap-4 py-12 text-center">
                  <div className="h-16 w-16 rounded-2xl bg-muted flex items-center justify-center">
                    <FileText className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <div className="space-y-1">
                    <p className="font-semibold text-foreground">{data.documentFilename}</p>
                    <p className="text-sm text-muted-foreground">
                      In-browser preview is only available for PDF files.
                    </p>
                  </div>
                  <a
                    href={`/api/sign/${token}/download`}
                    download={data.documentFilename}
                    className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                  >
                    <Download className="h-4 w-4" />
                    Download to review
                  </a>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    Please download and review the document before submitting your signature below.
                  </p>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right: Signing Form */}
          <div>
            <Card className="shadow-md border-border/50 sticky top-24">
              <CardHeader className="border-b pb-4">
                <div className="flex items-center gap-3 mb-2">
                  <div className="h-10 w-10 rounded-xl bg-primary/10 flex items-center justify-center text-primary">
                    <FileSignature className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Sign Document</CardTitle>
                    <CardDescription className="text-xs">
                      Signing as <strong>{data.recipient.teamName}</strong>
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>

              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)}>
                  <CardContent className="space-y-5 pt-5">
                    {/* Full name */}
                    <FormField
                      control={form.control}
                      name="fullName"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Your full legal name</FormLabel>
                          <FormControl>
                            <Input placeholder="e.g. Roni Ahmed" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    {/* Text fields */}
                    {hasTextFields.length > 0 && (
                      <>
                        <Separator />
                        <div className="space-y-3">
                          {hasTextFields.map((f) => {
                            const fId = (f as { id: string }).id;
                            return (
                              <div key={fId} className="space-y-1.5">
                                <label className="text-sm font-medium flex items-center gap-1.5">
                                  <Type className="h-3.5 w-3.5 text-muted-foreground" />
                                  Text field
                                </label>
                                <Input
                                  placeholder="Enter text…"
                                  value={fieldValues[fId] ?? ""}
                                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [fId]: e.target.value }))}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}

                    {/* Date fields */}
                    {hasDateFields.length > 0 && (
                      <>
                        <Separator />
                        <div className="space-y-3">
                          {hasDateFields.map((f) => {
                            const fId = (f as { id: string }).id;
                            return (
                              <div key={fId} className="space-y-1.5">
                                <label className="text-sm font-medium flex items-center gap-1.5">
                                  <CalendarDays className="h-3.5 w-3.5 text-muted-foreground" />
                                  Date signed
                                </label>
                                <Input
                                  type="date"
                                  value={fieldValues[fId] ?? todayISO()}
                                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [fId]: e.target.value }))}
                                />
                              </div>
                            );
                          })}
                        </div>
                      </>
                    )}

                    {/* Signature / Initials pad */}
                    {hasSignatureFields && (
                      <>
                        <Separator />
                        <FormField
                          control={form.control}
                          name="signatureData"
                          render={({ field }) => (
                            <FormItem>
                              <div className="flex items-center justify-between mb-1.5">
                                <FormLabel className="flex items-center gap-1.5">
                                  <PenLine className="h-3.5 w-3.5 text-muted-foreground" />
                                  Your signature
                                </FormLabel>
                                {meData?.user?.hasSavedSignature && (
                                  <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs gap-1.5"
                                    onClick={useSavedSignature}
                                  >
                                    <Stamp className="h-3 w-3" />
                                    Use saved
                                  </Button>
                                )}
                              </div>
                              <FormControl>
                                <div className={`rounded-lg transition-colors ${form.formState.errors.signatureData ? "ring-2 ring-destructive ring-offset-2" : ""}`}>
                                  {signatureData && signatureData.startsWith("data:image") ? (
                                    <div className="border rounded-lg bg-white p-2 flex flex-col items-center gap-2">
                                      <img src={signatureData} alt="Signature preview" className="max-h-24 object-contain" />
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        className="text-xs text-muted-foreground"
                                        onClick={() => field.onChange("")}
                                      >
                                        Clear & redraw
                                      </Button>
                                    </div>
                                  ) : (
                                    <SignaturePad
                                      onSign={(sig) => { field.onChange(sig); form.clearErrors("signatureData"); }}
                                      onClear={() => field.onChange("")}
                                    />
                                  )}
                                </div>
                              </FormControl>
                              <FormMessage />
                            </FormItem>
                          )}
                        />
                      </>
                    )}

                    <div className="bg-muted p-3 rounded-lg text-xs text-muted-foreground flex gap-2.5">
                      <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <p>
                        By submitting, you agree your electronic signature is the legally binding
                        equivalent of your handwritten signature.
                      </p>
                    </div>
                  </CardContent>

                  <CardFooter className="border-t bg-muted/20 p-4">
                    <Button
                      type="submit"
                      size="lg"
                      className="w-full"
                      disabled={isSubmitDisabled}
                    >
                      {submitSignatureMutation.isPending ? "Submitting…" : "Submit Signature"}
                    </Button>
                  </CardFooter>
                </form>
              </Form>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}
