import { useCallback, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "./ui/button";
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

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
  const [containerWidth, setContainerWidth] = useState(0);

  const measuredRef = useCallback((node: HTMLDivElement | null) => {
    if (node) setContainerWidth(node.offsetWidth);
  }, []);

  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!onCanvasClick || !clickable) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    onCanvasClick(x, y);
  };

  return (
    <div className={`flex flex-col items-center gap-3 w-full ${className}`}>
      <div className="w-full max-w-[816px] mx-auto">
      <div
        ref={measuredRef}
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
          {containerWidth > 0 && (
            <Page
              pageNumber={currentPage}
              width={containerWidth}
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
