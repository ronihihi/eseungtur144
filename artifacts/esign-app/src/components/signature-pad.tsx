import { useRef, useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Upload, PenLine, X, ImageIcon } from "lucide-react";

interface SignaturePadProps {
  onSign: (dataUrl: string) => void;
  onClear: () => void;
}

type Mode = "draw" | "upload";

const ACCEPTED = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
const MAX_BYTES = 5 * 1024 * 1024;

function imageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const src = e.target?.result as string;
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        const MAX_W = 600;
        const scale = img.width > MAX_W ? MAX_W / img.width : 1;
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = reject;
      img.src = src;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function SignaturePad({ onSign, onClear }: SignaturePadProps) {
  const [mode, setMode] = useState<Mode>("draw");

  /* ── Draw mode ── */
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const dpr = useRef(1);

  /* ── Upload mode ── */
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadedDataUrl, setUploadedDataUrl] = useState<string>("");
  const [isDragging, setIsDragging] = useState(false);
  const [uploadError, setUploadError] = useState("");

  /* ── Canvas init: account for device pixel ratio so strokes land exactly under the cursor ── */
  const initCanvas = useCallback(() => {
    if (mode !== "draw") return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    dpr.current = ratio;
    const cssW = canvas.offsetWidth || (canvas.parentElement?.offsetWidth ?? 480);
    const cssH = 200;
    // Set real pixel size
    canvas.width = Math.round(cssW * ratio);
    canvas.height = Math.round(cssH * ratio);
    // Scale all drawing operations so 1 CSS px = 1 unit
    ctx.scale(ratio, ratio);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "#1c325d";
  }, [mode]);

  useEffect(() => {
    initCanvas();
  }, [initCanvas]);

  /* ── Get canvas-local coordinates (CSS pixels, corrected for scroll/offset) ── */
  const getPos = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ): { x: number; y: number } => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    if ("touches" in e) {
      const t = e.touches[0];
      return { x: t.clientX - rect.left, y: t.clientY - rect.top };
    }
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startDrawing = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    e.preventDefault();
    const pos = getPos(e);
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    lastPoint.current = pos;
    setIsDrawing(true);
    setHasDrawn(true);
  };

  const draw = (
    e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>
  ) => {
    e.preventDefault();
    if (!isDrawing) return;
    const pos = getPos(e);
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx || !lastPoint.current) return;

    // Quadratic Bézier through the midpoint: this turns sharp corners into smooth curves
    const mid = {
      x: (lastPoint.current.x + pos.x) / 2,
      y: (lastPoint.current.y + pos.y) / 2,
    };
    ctx.quadraticCurveTo(lastPoint.current.x, lastPoint.current.y, mid.x, mid.y);
    ctx.stroke();
    // Start the next segment from the midpoint so curves connect smoothly
    ctx.beginPath();
    ctx.moveTo(mid.x, mid.y);

    lastPoint.current = pos;
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    // Draw a final dot if the user just clicked without moving
    const ctx = canvasRef.current?.getContext("2d");
    if (ctx && lastPoint.current) {
      ctx.lineTo(lastPoint.current.x + 0.1, lastPoint.current.y + 0.1);
      ctx.stroke();
    }
    lastPoint.current = null;
    setIsDrawing(false);
    if (hasDrawn && canvasRef.current) {
      // Export at full resolution
      onSign(canvasRef.current.toDataURL("image/png"));
    }
  };

  /* ── Clear ── */
  const clearCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (canvas && ctx) {
      // Reset transform, clear, then re-apply DPR scale
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.scale(dpr.current, dpr.current);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "#1c325d";
    }
    lastPoint.current = null;
    setHasDrawn(false);
    onClear();
  };

  const clearAll = useCallback(() => {
    clearCanvas();
    setUploadedDataUrl("");
    setUploadError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    onClear();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClear]);

  const switchMode = (m: Mode) => {
    clearAll();
    setMode(m);
  };

  /* ── Upload handlers ── */
  const applyFile = useCallback(async (file: File) => {
    setUploadError("");
    if (!ACCEPTED.includes(file.type)) {
      setUploadError("Only PNG, JPG, WebP, or GIF images are accepted.");
      return;
    }
    if (file.size > MAX_BYTES) {
      setUploadError("Image must be smaller than 5 MB.");
      return;
    }
    try {
      const dataUrl = await imageFileToDataUrl(file);
      setUploadedDataUrl(dataUrl);
      onSign(dataUrl);
    } catch {
      setUploadError("Could not read the image. Please try another file.");
    }
  }, [onSign]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) applyFile(f);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) applyFile(f);
  };

  const removeUpload = () => {
    setUploadedDataUrl("");
    setUploadError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
    onClear();
  };

  return (
    <div className="space-y-3">
      {/* Mode toggle */}
      <div className="flex rounded-lg border border-input p-0.5 w-fit gap-0.5">
        {(["draw", "upload"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => switchMode(m)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
              mode === m
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {m === "draw" ? <PenLine className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
            {m === "draw" ? "Draw" : "Upload Image"}
          </button>
        ))}
      </div>

      {mode === "draw" ? (
        <>
          <div
            className="border border-input rounded-md overflow-hidden bg-white touch-none select-none"
            style={{ lineHeight: 0 }}
          >
            <canvas
              ref={canvasRef}
              onMouseDown={startDrawing}
              onMouseMove={draw}
              onMouseUp={stopDrawing}
              onMouseLeave={stopDrawing}
              onTouchStart={startDrawing}
              onTouchMove={draw}
              onTouchEnd={stopDrawing}
              onTouchCancel={stopDrawing}
              style={{ width: "100%", height: "200px", display: "block", cursor: "crosshair" }}
            />
          </div>
          <div className="flex justify-between items-center">
            <p className="text-xs text-muted-foreground">
              {hasDrawn ? "Looking good — clear to start over" : "Draw your signature above"}
            </p>
            <Button variant="outline" size="sm" type="button" onClick={clearCanvas} disabled={!hasDrawn}>
              Clear
            </Button>
          </div>
        </>
      ) : (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={handleFileInput}
          />

          {uploadedDataUrl ? (
            <div className="relative rounded-lg border border-green-200 bg-green-50/50 p-3 flex items-center justify-center min-h-[120px]">
              <img
                src={uploadedDataUrl}
                alt="Uploaded signature"
                className="max-h-28 max-w-full object-contain"
              />
              <button
                type="button"
                onClick={removeUpload}
                className="absolute top-2 right-2 h-6 w-6 rounded-full bg-destructive/10 hover:bg-destructive/20 flex items-center justify-center text-destructive transition-colors"
                title="Remove image"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div
              className={`rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-2 py-8 px-4 text-center cursor-pointer transition-all select-none ${
                isDragging
                  ? "border-primary bg-primary/5 scale-[1.01]"
                  : uploadError
                  ? "border-destructive/50 bg-destructive/5"
                  : "border-border hover:border-primary/50 hover:bg-muted/30"
              }`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false); }}
              onDrop={handleDrop}
            >
              <div className={`h-10 w-10 rounded-xl flex items-center justify-center ${isDragging ? "bg-primary/20" : "bg-muted"}`}>
                <Upload className={`h-5 w-5 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
              </div>
              <div className="space-y-0.5">
                <p className="text-sm font-medium">
                  {isDragging ? "Drop your image here" : "Click to browse or drag & drop"}
                </p>
                <p className="text-xs text-muted-foreground">PNG, JPG, WebP · up to 5 MB</p>
              </div>
              {uploadError && (
                <p className="text-xs text-destructive font-medium mt-1">{uploadError}</p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
