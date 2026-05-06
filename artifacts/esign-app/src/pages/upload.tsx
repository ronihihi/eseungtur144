import { useState, useRef, useCallback } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, FileText, ArrowLeft, X, CheckCircle2, AlertCircle } from "lucide-react";
import { Link } from "wouter";

import { useToast } from "@/hooks/use-toast";
import { getListDocumentsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";

const ACCEPTED_TYPES = [".pdf", ".docx", ".doc"];
const ACCEPTED_MIME = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/msword"];
const MAX_MB = 50;

const uploadSchema = z.object({
  title: z.string().min(1, "Title is required").max(100),
  signing_order: z.enum(["sequential", "simultaneous"]),
});

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fileExt(name: string) {
  return name.split(".").pop()?.toUpperCase() ?? "FILE";
}

export function UploadPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragError, setDragError] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<z.infer<typeof uploadSchema>>({
    resolver: zodResolver(uploadSchema),
    defaultValues: { title: "", signing_order: "simultaneous" },
  });

  const applyFile = useCallback((f: File) => {
    setDragError("");
    const ext = "." + f.name.split(".").pop()?.toLowerCase();
    if (!ACCEPTED_TYPES.includes(ext) && !ACCEPTED_MIME.includes(f.type)) {
      setDragError("Only PDF, DOC, and DOCX files are supported.");
      return;
    }
    if (f.size > MAX_MB * 1024 * 1024) {
      setDragError(`File exceeds the ${MAX_MB} MB limit.`);
      return;
    }
    setFile(f);
    if (!form.getValues("title")) {
      form.setValue("title", f.name.replace(/\.[^/.]+$/, ""), { shouldValidate: true });
    }
  }, [form]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) applyFile(e.target.files[0]);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragging(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) applyFile(dropped);
  };

  const handleZoneClick = () => {
    if (!file) fileInputRef.current?.click();
  };

  const removeFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    setFile(null);
    setDragError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onSubmit = async (values: z.infer<typeof uploadSchema>) => {
    if (!file) {
      toast({ variant: "destructive", title: "File required", description: "Please select a document to upload." });
      return;
    }

    setIsUploading(true);
    setUploadProgress(0);

    const formData = new FormData();
    formData.append("document", file);
    formData.append("title", values.title);
    formData.append("signing_order", values.signing_order);

    try {
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/documents");
        xhr.withCredentials = true;

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUploadProgress(Math.round((e.loaded / e.total) * 90));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            setUploadProgress(100);
            const data = JSON.parse(xhr.responseText);
            queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
            setTimeout(() => {
              setLocation(`/documents/${data.documentId}`);
            }, 300);
            resolve();
          } else {
            const err = JSON.parse(xhr.responseText);
            reject(new Error(err.error || "Upload failed"));
          }
        };

        xhr.onerror = () => reject(new Error("Network error during upload"));
        xhr.send(formData);
      });
    } catch (error: unknown) {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
      setUploadProgress(0);
    } finally {
      setIsUploading(false);
    }
  };

  const canSubmit = !!file && !isUploading;

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <Link href="/">
          <Button variant="outline" size="sm" className="mb-5 gap-1.5">
            <ArrowLeft className="h-4 w-4" />
            Home
          </Button>
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">Upload Document</h1>
        <p className="text-muted-foreground mt-1">Upload a PDF or Word document to start collecting signatures.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">

          {/* Drop zone */}
          <div
            className={`relative rounded-xl border-2 border-dashed transition-all duration-150 select-none ${
              isDragging
                ? "border-primary bg-primary/5 scale-[1.01]"
                : file
                ? "border-primary/40 bg-primary/[0.03]"
                : dragError
                ? "border-destructive/50 bg-destructive/5"
                : "border-border hover:border-primary/50 hover:bg-muted/40"
            } ${!file ? "cursor-pointer" : "cursor-default"}`}
            onClick={handleZoneClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <input
              type="file"
              accept=".pdf,.docx,.doc,application/pdf"
              className="hidden"
              ref={fileInputRef}
              onChange={handleFileChange}
            />

            <div className="flex flex-col items-center justify-center gap-3 py-10 px-6 text-center">
              {file ? (
                <>
                  <div className="h-14 w-14 rounded-2xl bg-primary/10 flex items-center justify-center">
                    <FileText className="h-7 w-7 text-primary" />
                  </div>
                  <div className="space-y-0.5">
                    <p className="font-semibold text-foreground">{file.name}</p>
                    <p className="text-sm text-muted-foreground">
                      {fileExt(file.name)} · {formatBytes(file.size)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={removeFile}
                    className="text-muted-foreground hover:text-destructive gap-1.5 mt-1"
                  >
                    <X className="h-3.5 w-3.5" />
                    Remove file
                  </Button>
                </>
              ) : dragError ? (
                <>
                  <div className="h-14 w-14 rounded-2xl bg-destructive/10 flex items-center justify-center">
                    <AlertCircle className="h-7 w-7 text-destructive" />
                  </div>
                  <div className="space-y-1">
                    <p className="font-medium text-destructive">{dragError}</p>
                    <p className="text-sm text-muted-foreground">Click to try a different file</p>
                  </div>
                </>
              ) : (
                <>
                  <div className={`h-14 w-14 rounded-2xl flex items-center justify-center transition-colors ${isDragging ? "bg-primary/20" : "bg-muted"}`}>
                    <Upload className={`h-7 w-7 transition-colors ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
                  </div>
                  <div className="space-y-1">
                    <p className="font-semibold text-foreground">
                      {isDragging ? "Drop your file here" : "Click to browse or drag & drop"}
                    </p>
                    <p className="text-sm text-muted-foreground">PDF, DOCX or DOC · up to {MAX_MB} MB</p>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Upload progress */}
          {isUploading && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {uploadProgress < 100 ? "Uploading…" : (
                    <span className="flex items-center gap-1.5 text-green-600">
                      <CheckCircle2 className="h-4 w-4" /> Upload complete
                    </span>
                  )}
                </span>
                <span className="font-medium tabular-nums">{uploadProgress}%</span>
              </div>
              <Progress value={uploadProgress} className="h-1.5" />
            </div>
          )}

          {/* Title */}
          <FormField
            control={form.control}
            name="title"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Document Title</FormLabel>
                <FormControl>
                  <Input placeholder="e.g., NDA — Acme Corp" {...field} />
                </FormControl>
                <FormDescription>Shown to all recipients in their signing email.</FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Signing order */}
          <FormField
            control={form.control}
            name="signing_order"
            render={({ field }) => (
              <FormItem className="space-y-2">
                <FormLabel>Signing Order</FormLabel>
                <FormControl>
                  <RadioGroup
                    onValueChange={field.onChange}
                    defaultValue={field.value}
                    className="grid grid-cols-1 sm:grid-cols-2 gap-3"
                  >
                    {[
                      {
                        value: "simultaneous",
                        label: "Simultaneous",
                        description: "All recipients receive the document at the same time.",
                      },
                      {
                        value: "sequential",
                        label: "Sequential",
                        description: "Recipients sign one by one in a specific order.",
                      },
                    ].map((opt) => (
                      <label
                        key={opt.value}
                        className={`flex items-start gap-3 rounded-lg border p-4 cursor-pointer transition-colors ${
                          field.value === opt.value
                            ? "border-primary bg-primary/5"
                            : "border-border hover:bg-muted/50"
                        }`}
                      >
                        <RadioGroupItem value={opt.value} className="mt-0.5 shrink-0" />
                        <div>
                          <p className="font-medium text-sm leading-none mb-1">{opt.label}</p>
                          <p className="text-xs text-muted-foreground">{opt.description}</p>
                        </div>
                      </label>
                    ))}
                  </RadioGroup>
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <Link href="/">
              <Button variant="outline" type="button" disabled={isUploading}>
                Cancel
              </Button>
            </Link>
            <Button type="submit" disabled={!canSubmit} className="min-w-36">
              {isUploading ? (
                <span className="flex items-center gap-2">
                  <span className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                  Uploading…
                </span>
              ) : (
                "Upload & Continue"
              )}
            </Button>
          </div>

        </form>
      </Form>
    </div>
  );
}
