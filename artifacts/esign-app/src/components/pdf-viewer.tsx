import { useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

// A4 width at 96 dpi = 210mm × (96/25.4) ≈ 794px
const MAX_PAGE_WIDTH = 794;

interface PdfViewerProps {
  fileUrl: string | { url: string; withCredentials?: boolean };
  currentPage: number;
  onLoadSuccess: (numPages: number) => void;
  onPageChange: (page: number) => void;
  numPages: number;
  onCanvasClick?: (x: number, y: number) => void;
  renderOverlay?: () => React.ReactNode;
  clickable?: boolean;
  className?: string;
  onDrop?: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragOver?: (e: React.DragEvent<HTMLDivElement>) => void;
}

export function PdfViewer({
  fileUrl,
  currentPage,
  numPages,
  onLoadSuccess,
  onPageChange,
  onCanvasClick,
  renderOverlay,
  clickable = false,
  className = "",
  onDrop,
  onDragOver,
}: PdfViewerProps) {
  const [pageWidth, setPageWidth] = useState(0);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ResizeObserver keeps pageWidth in sync whenever the container resizes.
  // Guards: debounce (150 ms) + 3 px threshold stop the scrollbar-driven
  // feedback loop where PDF renders tall → scrollbar steals ~15 px → PDF
  // shrinks → scrollbar disappears → PDF grows → repeat (zoom in/out flash).
  useEffect(() => {
    const node = wrapperRef.current;
    if (!node) return;

    let last = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = (w: number) => {
      const next = Math.min(Math.round(w), MAX_PAGE_WIDTH);
      if (Math.abs(next - last) > 3) {
        last = next;
        setPageWidth(next);
      }
    };

    // Measure immediately (no debounce needed on first paint)
    last = Math.min(Math.round(node.offsetWidth), MAX_PAGE_WIDTH);
    setPageWidth(last);

    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      clearTimeout(timer);
      timer = setTimeout(() => apply(entry.contentRect.width), 150);
    });
    ro.observe(node);

    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onCanvasClick || !clickable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    onCanvasClick(
      (e.clientX - rect.left) / rect.width,
      (e.clientY - rect.top) / rect.height,
    );
  };

  return (
    <div className={`flex flex-col items-center gap-3 w-full ${className}`}>
      {/* Outer wrapper caps width at A4 and provides the ResizeObserver target */}
      <div ref={wrapperRef} className="w-full" style={{ maxWidth: MAX_PAGE_WIDTH }}>
        <div
          className={`relative w-full border rounded-lg overflow-hidden shadow-sm bg-white ${
            clickable ? "cursor-crosshair" : ""
          }`}
          onClick={handleClick}
          onDrop={onDrop}
          onDragOver={onDragOver}
        >
          <Document
            file={fileUrl}
            onLoadSuccess={({ numPages: n }) => onLoadSuccess(n)}
            loading={
              <div className="h-96 flex items-center justify-center text-muted-foreground text-sm">
                Loading document…
              </div>
            }
            error={
              <div className="h-96 flex items-center justify-center text-destructive text-sm">
                Could not load PDF
              </div>
            }
          >
            {pageWidth > 0 && (
              <Page
                pageNumber={currentPage}
                width={pageWidth}
                renderAnnotationLayer={false}
                renderTextLayer={false}
              />
            )}
          </Document>

          {renderOverlay && (
            <div className="absolute inset-0 pointer-events-none">
              {renderOverlay()}
            </div>
          )}
        </div>
      </div>

      {numPages > 1 && (
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onPageChange(Math.max(1, currentPage - 1));
            }}
            disabled={currentPage <= 1}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {currentPage} of {numPages}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={(e) => {
              e.stopPropagation();
              onPageChange(Math.min(numPages, currentPage + 1));
            }}
            disabled={currentPage >= numPages}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
