
"use client";

import type { OnlineUser } from '@/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { User, Video, MessageSquare } from 'lucide-react'; // Added MessageSquare
import { ScrollArea } from '@/components/ui/scroll-area';

interface OnlineUsersPanelProps {
  onlineUsers: OnlineUser[];
  onInitiateCall: (user: OnlineUser) => void;
  onInitiateChat: (user: OnlineUser) => void; // New prop for initiating chat
  currentUserId: string | null;
}

export function OnlineUsersPanel({ onlineUsers, onInitiateCall, onInitiateChat, currentUserId }: OnlineUsersPanelProps) {
  const otherOnlineUsers = onlineUsers.filter(user => user.id !== currentUserId);

  return (
    <Card className="w-full shadow-lg">
      <CardHeader>
        <CardTitle className="text-xl text-center">Online Users ({otherOnlineUsers.length})</CardTitle>
      </CardHeader>
      <CardContent>
        {otherOnlineUsers.length > 0 ? (
          <ScrollArea className="h-[300px] pr-4">
            <ul className="space-y-3">
              {otherOnlineUsers.map((user) => (
                <li key={user.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg shadow-sm">
                  <div className="flex items-center gap-3">
                    <Avatar className="h-10 w-10 border-2 border-primary">
                      <AvatarImage src={user.photoUrl} alt={user.name} data-ai-hint="avatar abstract"/>
                      <AvatarFallback>{user.name ? user.name.charAt(0).toUpperCase() : <User />}</AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <span className="font-medium text-foreground/90">
                        {user.name}
                        {user.isGoogleUser && <span className="text-xs text-primary font-semibold ml-1">(Google)</span>}
                      </span>
                      {user.countryCode && (
                        <span className="text-xs text-muted-foreground">({user.countryCode})</span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" onClick={() => onInitiateChat(user)} aria-label={`Chat with ${user.name}`}>
                      <MessageSquare className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => onInitiateCall(user)} aria-label={`Call ${user.name}`}>
                      <Video className="mr-2 h-4 w-4 sm:mr-0" /> 
                      <span className="hidden sm:inline ml-2">Call</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </ScrollArea>
        ) : (
          <p className="text-sm text-muted-foreground text-center py-4">
            No other users are currently online.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
