import { useState } from "react";
import { Link } from "wouter";
import { useGetAdminAuditLog } from "@workspace/api-client-react";
import type { AuditEvent } from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  ClipboardList, Search, Upload, Send, Eye, PenLine,
  CheckCircle2, ExternalLink, RefreshCw, Download,
  CheckCheck, XCircle, FileText, Users,
} from "lucide-react";

const EVENT_LABELS: Record<string, string> = {
  uploaded: "Uploaded",
  sent: "Sent for Signing",
  viewed: "Viewed",
  signed: "Signed",
  completed: "Completed",
  review_approved: "Review Approved",
  review_changes_requested: "Changes Requested",
};

const EVENT_ICONS: Record<string, React.ReactNode> = {
  uploaded: <Upload className="h-3 w-3" />,
  sent: <Send className="h-3 w-3" />,
  viewed: <Eye className="h-3 w-3" />,
  signed: <PenLine className="h-3 w-3" />,
  completed: <CheckCircle2 className="h-3 w-3" />,
  review_approved: <CheckCheck className="h-3 w-3" />,
  review_changes_requested: <XCircle className="h-3 w-3" />,
};

const EVENT_COLORS: Record<string, string> = {
  uploaded: "bg-blue-50 text-blue-700 border-blue-200",
  sent: "bg-purple-50 text-purple-700 border-purple-200",
  viewed: "bg-amber-50 text-amber-700 border-amber-200",
  signed: "bg-emerald-50 text-emerald-700 border-emerald-200",
  completed: "bg-green-50 text-green-700 border-green-200",
  review_approved: "bg-teal-50 text-teal-700 border-teal-200",
  review_changes_requested: "bg-orange-50 text-orange-700 border-orange-200",
};

const TAB_TYPES: Record<string, string[]> = {
  all: [],
  documents: ["uploaded", "sent", "completed"],
  signing: ["viewed", "signed"],
  review: ["review_approved", "review_changes_requested"],
};

function EventBadge({ type }: { type: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium border whitespace-nowrap ${EVENT_COLORS[type] ?? "bg-muted text-muted-foreground border-border"}`}
    >
      {EVENT_ICONS[type]}
      {EVENT_LABELS[type] ?? type}
    </span>
  );
}

function formatTimestamp(iso: string) {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  let relative: string;
  if (diffMins < 1) relative = "just now";
  else if (diffMins < 60) relative = `${diffMins}m ago`;
  else if (diffHours < 24) relative = `${diffHours}h ago`;
  else if (diffDays < 7) relative = `${diffDays}d ago`;
  else relative = date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

  const absolute = date.toLocaleString(undefined, {
    month: "short", day: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  return { relative, absolute };
}

type ExtendedAuditEvent = AuditEvent & {
  uploaderName?: string;
  uploaderEmail?: string | null;
  note?: string | null;
};

function AuditRow({ event }: { event: ExtendedAuditEvent }) {
  const { relative, absolute } = formatTimestamp(event.timestamp);

  return (
    <TableRow className="hover:bg-muted/30">
      <TableCell className="py-2.5">
        <EventBadge type={event.type} />
      </TableCell>
      <TableCell className="py-2.5 max-w-[200px]">
        <Link
          href={`/documents/${event.documentId}`}
          className="hover:text-primary hover:underline text-sm font-medium flex items-center gap-1 truncate"
        >
          <span className="truncate">{event.documentTitle}</span>
          <ExternalLink className="h-3 w-3 shrink-0 opacity-40" />
        </Link>
        {(event as ExtendedAuditEvent).uploaderName && (
          <div className="text-xs text-muted-foreground truncate mt-0.5">
            by {(event as ExtendedAuditEvent).uploaderName}
            {(event as ExtendedAuditEvent).uploaderEmail && (
              <span className="opacity-70"> · {(event as ExtendedAuditEvent).uploaderEmail}</span>
            )}
          </div>
        )}
      </TableCell>
      <TableCell className="py-2.5">
        {event.actorName ? (
          <div>
            <div className="text-sm font-medium">{event.actorName}</div>
            {event.actorEmail && (
              <div className="text-xs text-muted-foreground">{event.actorEmail}</div>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="py-2.5">
        {event.ipAddress ? (
          <span className="text-xs font-mono text-muted-foreground">{event.ipAddress.split(",")[0].trim()}</span>
        ) : (
          <span className="text-muted-foreground text-xs">—</span>
        )}
      </TableCell>
      <TableCell className="py-2.5">
        {(event as ExtendedAuditEvent).note && (
          <div className="text-xs text-orange-700 bg-orange-50 border border-orange-200 rounded px-2 py-1 max-w-[180px] truncate" title={(event as ExtendedAuditEvent).note ?? ""}>
            {(event as ExtendedAuditEvent).note}
          </div>
        )}
      </TableCell>
      <TableCell className="py-2.5 text-right">
        <Tooltip>
          <TooltipTrigger asChild>
            <time className="text-xs text-muted-foreground cursor-default">{relative}</time>
          </TooltipTrigger>
          <TooltipContent side="left">
            <p className="text-xs">{absolute}</p>
          </TooltipContent>
        </Tooltip>
      </TableCell>
    </TableRow>
  );
}

function EventTable({ events, isLoading, emptyMessage }: { events: ExtendedAuditEvent[]; isLoading: boolean; emptyMessage?: string }) {
  if (isLoading) {
    return <div className="p-12 text-center text-muted-foreground text-sm">Loading audit log…</div>;
  }
  if (events.length === 0) {
    return <div className="p-12 text-center text-muted-foreground text-sm">{emptyMessage ?? "No events match your filter."}</div>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-44">Event</TableHead>
          <TableHead>Document</TableHead>
          <TableHead>Actor</TableHead>
          <TableHead className="w-32">IP Address</TableHead>
          <TableHead>Note</TableHead>
          <TableHead className="text-right w-28">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {events.map(event => (
          <AuditRow key={event.id} event={event} />
        ))}
      </TableBody>
    </Table>
  );
}

export function AdminAuditPage() {
  const { data, isLoading, refetch, isFetching } = useGetAdminAuditLog();
  const [search, setSearch] = useState("");

  const events = (data?.events ?? []) as ExtendedAuditEvent[];

  const filterEvents = (tab: string) => {
    const tabTypes = TAB_TYPES[tab] ?? [];
    return events.filter(e => {
      const matchesTab = tabTypes.length === 0 || tabTypes.includes(e.type);
      const term = search.toLowerCase();
      const matchesSearch =
        !term ||
        e.documentTitle.toLowerCase().includes(term) ||
        (e.actorName ?? "").toLowerCase().includes(term) ||
        (e.actorEmail ?? "").toLowerCase().includes(term) ||
        (e.ipAddress ?? "").includes(term) ||
        ((e as ExtendedAuditEvent).uploaderName ?? "").toLowerCase().includes(term) ||
        ((e as ExtendedAuditEvent).uploaderEmail ?? "").toLowerCase().includes(term);
      return matchesTab && matchesSearch;
    });
  };

  const tabCount = (tab: string) => {
    if (isLoading) return "";
    const count = filterEvents(tab).length;
    return ` (${count})`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-primary" />
            Audit Log
          </h1>
          <p className="text-muted-foreground mt-1">
            All document and signing activity across your organisation
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            asChild
          >
            <a href="/api/admin/audit/export" download>
              <Download className="h-3.5 w-3.5 mr-1.5" />
              Export CSV
            </a>
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search document, person, or IP…"
          className="pl-9"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* Tabs */}
      <Tabs defaultValue="all">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="all" className="gap-1.5">
            <ClipboardList className="h-3.5 w-3.5" />
            All{tabCount("all")}
          </TabsTrigger>
          <TabsTrigger value="documents" className="gap-1.5">
            <FileText className="h-3.5 w-3.5" />
            Documents{tabCount("documents")}
          </TabsTrigger>
          <TabsTrigger value="signing" className="gap-1.5">
            <Users className="h-3.5 w-3.5" />
            Signing{tabCount("signing")}
          </TabsTrigger>
          <TabsTrigger value="review" className="gap-1.5">
            <CheckCheck className="h-3.5 w-3.5" />
            Review{tabCount("review")}
          </TabsTrigger>
        </TabsList>

        {(["all", "documents", "signing", "review"] as const).map(tab => {
          const filtered = filterEvents(tab);
          return (
            <TabsContent key={tab} value={tab} className="mt-4">
              <Card className="overflow-hidden">
                <CardHeader className="pb-3 border-b">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {isLoading ? "Loading…" : `${filtered.length} event${filtered.length !== 1 ? "s" : ""}`}
                  </CardTitle>
                  <CardDescription>
                    {tab === "all" && "All activity · most recent first · up to 1 000 events"}
                    {tab === "documents" && "Uploads, sends and completions"}
                    {tab === "signing" && "Document views and signatures collected"}
                    {tab === "review" && "Reviewer approvals and change requests"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0 overflow-x-auto">
                  <EventTable
                    events={filtered}
                    isLoading={isLoading}
                    emptyMessage={events.length === 0 ? "No activity yet." : "No events match your search."}
                  />
                </CardContent>
              </Card>
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}
