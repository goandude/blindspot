
"use client";

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { User, Hourglass } from 'lucide-react';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';

interface QueuedUsersPanelProps {
  queuedUserIds: string[];
}

export function QueuedUsersPanel({ queuedUserIds }: QueuedUsersPanelProps) {
  return (
    <Card className="w-full max-w-md shadow-md mt-8">
      <CardHeader className="pb-3">
        <CardTitle className="text-xl flex items-center">
          <Hourglass className="mr-2 h-5 w-5 text-primary" />
          Waiting Room
        </CardTitle>
      </CardHeader>
      <CardContent>
        {queuedUserIds.length > 0 ? (
          <ScrollArea className="h-[150px]">
            <ul className="space-y-3">
              {queuedUserIds.map((userId) => (
                <li key={userId} className="flex items-center p-2 bg-muted/50 rounded-md">
                  <Avatar className="h-8 w-8 mr-3">
                    <AvatarFallback>
                      <User className="h-4 w-4" />
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-sm text-foreground/90">
                    User <span className="font-mono text-xs bg-primary/10 text-primary px-1 py-0.5 rounded">{userId.substring(0, 8)}...</span> is searching...
                  </span>
                </li>
              ))}
            </ul>
          </ScrollArea>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            No one is currently waiting to chat.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
