import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQueryClient } from "@tanstack/react-query";
import { Upload, FileText, ArrowLeft } from "lucide-react";
import { Link } from "wouter";

import { useToast } from "@/hooks/use-toast";
import { getListDocumentsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

const uploadSchema = z.object({
  title: z.string().min(1, "Title is required").max(100),
  signing_order: z.enum(["sequential", "simultaneous"]),
});

export function UploadPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<z.infer<typeof uploadSchema>>({
    resolver: zodResolver(uploadSchema),
    defaultValues: {
      title: "",
      signing_order: "simultaneous",
    },
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selectedFile = e.target.files[0];
      setFile(selectedFile);
      
      // Auto-fill title if empty
      if (!form.getValues("title")) {
        // Remove extension
        const title = selectedFile.name.replace(/\.[^/.]+$/, "");
        form.setValue("title", title);
      }
    }
  };

  const onSubmit = async (values: z.infer<typeof uploadSchema>) => {
    if (!file) {
      toast({ variant: "destructive", title: "File required", description: "Please select a PDF document to upload." });
      return;
    }

    setIsUploading(true);
    
    try {
      const formData = new FormData();
      formData.append("document", file);
      formData.append("title", values.title);
      formData.append("signing_order", values.signing_order);

      const response = await fetch("/api/documents", {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to upload document");
      }

      const data = await response.json();
      
      queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
      toast({ title: "Document uploaded", description: "You can now add recipients." });
      
      setLocation(`/documents/${data.documentId}`);
    } catch (error: any) {
      toast({
        variant: "destructive",
        title: "Upload failed",
        description: error.message || "An unexpected error occurred during upload.",
      });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <Link href="/" className="inline-flex items-center text-sm font-medium text-muted-foreground hover:text-primary mb-4 transition-colors">
          <ArrowLeft className="mr-2 h-4 w-4" />
          Back to Dashboard
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Upload Document</h1>
        <p className="text-muted-foreground">Upload a PDF to collect signatures.</p>
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <Card>
            <CardHeader>
              <CardTitle>Document Details</CardTitle>
              <CardDescription>Select a file and configure signing options.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              
              <div className="space-y-2">
                <FormLabel>Document File (PDF)</FormLabel>
                <div 
                  className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                    file ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50 hover:border-primary/50'
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  style={{ cursor: "pointer" }}
                >
                  <input
                    type="file"
                    accept=".pdf,application/pdf"
                    className="hidden"
                    ref={fileInputRef}
                    onChange={handleFileChange}
                  />
                  
                  {file ? (
                    <div className="flex flex-col items-center gap-2">
                      <div className="h-12 w-12 rounded-full bg-primary/20 flex items-center justify-center text-primary">
                        <FileText className="h-6 w-6" />
                      </div>
                      <span className="font-medium text-foreground">{file.name}</span>
                      <span className="text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                      <Button type="button" variant="link" size="sm" onClick={(e) => { e.stopPropagation(); setFile(null); }} className="mt-2 text-destructive">
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-2 text-muted-foreground">
                      <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                        <Upload className="h-6 w-6" />
                      </div>
                      <span className="font-medium text-foreground mt-2">Click to select a PDF</span>
                      <span className="text-sm">or drag and drop here</span>
                    </div>
                  )}
                </div>
              </div>

              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Document Title</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g., NDA - Acme Corp" {...field} />
                    </FormControl>
                    <FormDescription>
                      This will be shown to recipients.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="signing_order"
                render={({ field }) => (
                  <FormItem className="space-y-3">
                    <FormLabel>Signing Order</FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={field.onChange}
                        defaultValue={field.value}
                        className="flex flex-col space-y-1"
                      >
                        <FormItem className="flex items-start space-x-3 space-y-0 rounded-md border p-4 shadow-sm">
                          <FormControl>
                            <RadioGroupItem value="simultaneous" />
                          </FormControl>
                          <div className="space-y-1 leading-none">
                            <FormLabel className="font-medium cursor-pointer">
                              Simultaneous (Any order)
                            </FormLabel>
                            <FormDescription>
                              All recipients receive the document at the same time.
                            </FormDescription>
                          </div>
                        </FormItem>
                        <FormItem className="flex items-start space-x-3 space-y-0 rounded-md border p-4 shadow-sm">
                          <FormControl>
                            <RadioGroupItem value="sequential" />
                          </FormControl>
                          <div className="space-y-1 leading-none">
                            <FormLabel className="font-medium cursor-pointer">
                              Sequential (Strict order)
                            </FormLabel>
                            <FormDescription>
                              Recipients receive the document one by one in a specific order.
                            </FormDescription>
                          </div>
                        </FormItem>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

            </CardContent>
            <CardFooter className="flex justify-end gap-2 border-t pt-6 bg-muted/20">
              <Link href="/">
                <Button variant="outline" type="button">Cancel</Button>
              </Link>
              <Button type="submit" disabled={!file || isUploading}>
                {isUploading ? (
                  <>
                    <Upload className="mr-2 h-4 w-4 animate-bounce" />
                    Uploading...
                  </>
                ) : (
                  "Upload & Continue"
                )}
              </Button>
            </CardFooter>
          </Card>
        </form>
      </Form>
    </div>
  );
}
