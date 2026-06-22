import { useState, useEffect } from "react";
import { useParams } from "wouter";
import { CheckCircle2, XCircle, Eye, Clock, Loader2, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PdfViewer } from "@/components/pdf-viewer";
import { useToast } from "@/hooks/use-toast";

interface SigningInfo {
  recipient: {
    id: string;
    teamName: string;
    email: string;
    requiresReview: boolean;
    requiresSignature: boolean;
    reviewStatus: string | null;
    reviewedAt: string | null;
    reviewChecklist?: Array<{ label: string; checked: boolean }> | null;
  };
  documentTitle: string;
  documentFilename: string;
  nextStep: string;
}

interface ChecklistItem {
  label: string;
  checked: boolean;
}

export function ReviewPage() {
  const { token } = useParams<{ token: string }>();
  const { toast } = useToast();

  const [info, setInfo] = useState<SigningInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [pdfPage, setPdfPage] = useState(1);
  const [pdfNumPages, setPdfNumPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [postReviewNextStep, setPostReviewNextStep] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [decision, setDecision] = useState<"approve" | "request_changes" | null>(null);

  const pdfUrl = token ? { url: `/api/sign/${token}/file`, withCredentials: false } : null;

  useEffect(() => {
    if (!token) return;
    fetch(`/api/sign/${token}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
        } else {
          setInfo(data);
          if (data.recipient?.reviewChecklist && data.recipient.reviewChecklist.length > 0) {
            setChecklist(data.recipient.reviewChecklist.map((item: ChecklistItem) => ({ ...item, checked: false })));
          }
          if (data.recipient?.reviewStatus === "approved" || data.recipient?.reviewStatus === "changes_requested") {
            setSubmitted(true);
            setDecision(data.recipient.reviewStatus === "approved" ? "approve" : "request_changes");
          }
        }
        setLoading(false);
      })
      .catch(() => {
        setError("Failed to load document");
        setLoading(false);
      });
  }, [token]);

  const handleSubmit = async (d: "approve" | "request_changes") => {
    setSubmitting(true);
    setDecision(d);
    try {
      const res = await fetch(`/api/sign/${token}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: d,
          note: note.trim() || null,
          checklist: checklist.length > 0 ? checklist : null,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to submit review");
      }
      setSubmitted(true);
      if (data.nextStep) setPostReviewNextStep(data.nextStep);
      toast({
        title: d === "approve" ? "Document Approved" : "Changes Requested",
        description: d === "approve"
          ? "You have approved this document. Signers will be notified."
          : "Your feedback has been submitted to the document owner.",
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Error",
        description: (err as Error).message,
      });
      setDecision(null);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading document…</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50">
        <Card className="max-w-md w-full mx-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-destructive">
              <XCircle className="h-5 w-5" />
              Access Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-muted-foreground">{error}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <Card className="max-w-lg w-full">
          <CardContent className="pt-10 pb-10 flex flex-col items-center text-center gap-4">
            {decision === "approve" ? (
              <>
                <div className="h-16 w-16 rounded-full bg-green-100 flex items-center justify-center">
                  <CheckCircle2 className="h-8 w-8 text-green-600" />
                </div>
                <h2 className="text-xl font-bold">Document Approved</h2>
                {postReviewNextStep === "sign" ? (
                  <>
                    <p className="text-muted-foreground max-w-sm">
                      You approved <strong>{info?.documentTitle}</strong>. You also need to sign it — click below to proceed.
                    </p>
                    <a
                      href={`/sign/${token}`}
                      className="inline-flex items-center gap-2 rounded-md bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                      Sign Document →
                    </a>
                  </>
                ) : (
                  <p className="text-muted-foreground max-w-sm">
                    You have approved <strong>{info?.documentTitle}</strong>. The signing process will continue once all reviewers have approved.
                  </p>
                )}
              </>
            ) : (
              <>
                <div className="h-16 w-16 rounded-full bg-amber-100 flex items-center justify-center">
                  <XCircle className="h-8 w-8 text-amber-600" />
                </div>
                <h2 className="text-xl font-bold">Changes Requested</h2>
                <p className="text-muted-foreground max-w-sm">
                  Your feedback has been recorded for <strong>{info?.documentTitle}</strong>. The document owner has been notified.
                </p>
              </>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="text-xs text-muted-foreground"
              onClick={() => { setSubmitted(false); setDecision(null); setPostReviewNextStep(null); }}
            >
              Change my decision
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header bar */}
      <div className="bg-white border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-8 w-8 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0">
              <FileText className="h-4 w-4 text-white" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-sm truncate">{info?.documentTitle}</p>
              <p className="text-xs text-muted-foreground">
                Review request for {info?.recipient.teamName}
              </p>
            </div>
          </div>
          <Badge variant="outline" className="flex-shrink-0 text-amber-600 border-amber-300 bg-amber-50">
            <Eye className="h-3 w-3 mr-1" />
            Review Required
          </Badge>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6">
        <div className="grid lg:grid-cols-[1fr_360px] gap-6">
          {/* PDF Viewer */}
          <div className="min-h-[600px] bg-white rounded-lg border shadow-sm overflow-hidden">
            {pdfUrl && (
              <PdfViewer
                fileUrl={pdfUrl}
                currentPage={pdfPage}
                numPages={pdfNumPages}
                onLoadSuccess={setPdfNumPages}
                onPageChange={setPdfPage}
                className="w-full"
              />
            )}
          </div>

          {/* Review Panel */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="h-4 w-4 text-amber-500" />
                  Review this Document
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-1">
                  Please review the document carefully. Once you approve, the signers will be notified to proceed.
                </p>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Checklist */}
                {checklist.length > 0 && (
                  <div className="space-y-2">
                    <Label className="text-sm font-medium">Review Checklist</Label>
                    <div className="space-y-2 rounded-md border p-3 bg-slate-50">
                      {checklist.map((item, idx) => (
                        <div key={idx} className="flex items-start gap-2">
                          <Checkbox
                            id={`chk-${idx}`}
                            checked={item.checked}
                            onCheckedChange={(val) =>
                              setChecklist((prev) =>
                                prev.map((c, i) => i === idx ? { ...c, checked: !!val } : c)
                              )
                            }
                            className="mt-0.5"
                          />
                          <label htmlFor={`chk-${idx}`} className="text-sm cursor-pointer leading-snug">
                            {item.label}
                          </label>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Notes */}
                <div className="space-y-1.5">
                  <Label htmlFor="review-note" className="text-sm font-medium">
                    Notes <span className="text-muted-foreground font-normal">(optional)</span>
                  </Label>
                  <Textarea
                    id="review-note"
                    placeholder="Add any comments or feedback about this document…"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={4}
                    className="resize-none text-sm"
                  />
                </div>

                {/* Actions */}
                <div className="flex flex-col gap-2 pt-1">
                  <Button
                    className="w-full bg-green-600 hover:bg-green-700 text-white"
                    disabled={submitting}
                    onClick={() => handleSubmit("approve")}
                  >
                    {submitting && decision === "approve" ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4 mr-2" />
                    )}
                    Approve Document
                  </Button>
                  <Button
                    variant="outline"
                    className="w-full text-amber-700 border-amber-300 hover:bg-amber-50"
                    disabled={submitting}
                    onClick={() => handleSubmit("request_changes")}
                  >
                    {submitting && decision === "request_changes" ? (
                      <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    ) : (
                      <XCircle className="h-4 w-4 mr-2" />
                    )}
                    Request Changes
                  </Button>
                </div>
              </CardContent>
            </Card>

            <p className="text-xs text-muted-foreground text-center px-2">
              Your review decision will be recorded and attached to the audit trail of this document.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
