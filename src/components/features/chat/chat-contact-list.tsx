
"use client";

import type { OnlineUser } from '@/types';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { User as UserIcon, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ChatContactListProps {
  peers: OnlineUser[];
  selectedPeerId: string | null;
  onSelectPeer: (peer: OnlineUser) => void;
  onCloseChatList?: () => void; // To close the entire chat UI
}

export function ChatContactList({ peers, selectedPeerId, onSelectPeer, onCloseChatList }: ChatContactListProps) {
  return (
    <div className="flex flex-col h-full border-r bg-card">
      <header className="p-3 border-b bg-muted/50 flex items-center justify-between">
        <h3 className="text-md font-semibold text-foreground">Active Chats</h3>
        {onCloseChatList && (
          <Button variant="ghost" size="icon" onClick={onCloseChatList} aria-label="Close chat list">
            <XCircle className="h-5 w-5" />
          </Button>
        )}
      </header>
      <ScrollArea className="flex-grow">
        {peers.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground text-center">No active chats. Start a conversation from the Online Users list.</p>
        )}
        <ul className="space-y-1 p-2">
          {peers.map((peer) => (
            <li key={peer.id}>
              <button
                onClick={() => onSelectPeer(peer)}
                className={cn(
                  "w-full flex items-center gap-3 p-2 rounded-md text-left hover:bg-muted transition-colors",
                  selectedPeerId === peer.id ? "bg-muted" : ""
                )}
                aria-current={selectedPeerId === peer.id ? "page" : undefined}
              >
                <Avatar className="h-10 w-10 border">
                  <AvatarImage src={peer.photoUrl} alt={peer.name} data-ai-hint={peer.dataAiHint || "avatar person"}/>
                  <AvatarFallback>{peer.name ? peer.name.charAt(0).toUpperCase() : <UserIcon />}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm truncate text-foreground">{peer.name}</p>
                  <p className="text-xs text-muted-foreground truncate">
                    {peer.isGoogleUser ? '(Google User)' : '(Anonymous)'}
                  </p>
                </div>
              </button>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}
