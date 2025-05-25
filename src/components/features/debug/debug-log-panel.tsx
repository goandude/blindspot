
"use client";

import { ScrollArea } from '@/components/ui/scroll-area';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useEffect, useRef } from 'react';

interface DebugLogPanelProps {
  logs: string[];
}

export function DebugLogPanel({ logs }: DebugLogPanelProps) {
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <Card className="shadow-md">
      <CardHeader className="p-4">
        <CardTitle className="text-md">Debug Log</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <ScrollArea ref={scrollAreaRef} className="h-[250px] w-full border-t">
          <div className="p-4 text-xs space-y-1">
            {logs.map((log, index) => (
              <div key={index} className="font-mono whitespace-pre-wrap break-all">
                {log}
              </div>
            ))}
            <div ref={logsEndRef} />
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
