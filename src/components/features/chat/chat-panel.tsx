
"use client";

import React, { useState, useEffect, useRef } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Paperclip, Send, Smile, User as UserIcon } from 'lucide-react';
import type { ChatMessage } from '@/types';
import { cn } from '@/lib/utils';

interface ChatPanelProps {
  messages: ChatMessage[];
  onSendMessage: (text: string, attachments?: File[]) => void; // attachments planned for future
  currentUserId: string | null;
  chatRoomId: string | null; 
  isLoading?: boolean; 
  chatTitle?: string;
  onClose?: () => void; // Optional: For closing the chat panel (e.g., in dual panel view)
}

export function ChatPanel({
  messages,
  onSendMessage,
  currentUserId,
  // chatRoomId, 
  isLoading = false,
  chatTitle = "Chat",
  onClose
}: ChatPanelProps) {
  const [newMessage, setNewMessage] = useState('');
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setNewMessage(event.target.value);
  };

  const handleSendClick = () => {
    if (newMessage.trim() === '' || !currentUserId) return;
    onSendMessage(newMessage.trim());
    setNewMessage('');
  };

  const handleKeyPress = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      handleSendClick();
    }
  };

  const handleAttachFile = () => {
    console.log("Attach file clicked - Placeholder");
    // Future: trigger file input
  };

  const handleEmojiPicker = () => {
    console.log("Emoji picker clicked - Placeholder");
    // Future: open emoji picker
  };
  
  const formatTimestamp = (timestamp: any): string => {
    if (!timestamp) return '';
    if (typeof timestamp === 'object' && timestamp.hasOwnProperty('.sv')) {
        return 'sending...'
    }
    try {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
        return 'invalid date';
    }
  };


  return (
    <div className="flex flex-col h-full bg-card border border-border rounded-lg shadow-md">
      <header className="p-3 border-b bg-muted/50 rounded-t-lg flex items-center justify-between">
        <h3 className="text-md font-semibold text-center text-foreground flex-grow">{chatTitle}</h3>
        {onClose && (
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close chat">
            &times;
          </Button>
        )}
      </header>
      <ScrollArea ref={scrollAreaRef} className="flex-grow p-3">
        <div className="space-y-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "flex items-end gap-2",
                msg.senderId === currentUserId ? "justify-end" : "justify-start"
              )}
            >
              {msg.senderId !== currentUserId && (
                <Avatar className="h-8 w-8 self-start border">
                  <AvatarImage src={msg.senderPhotoUrl} alt={msg.senderName} data-ai-hint="avatar person" />
                  <AvatarFallback>{msg.senderName ? msg.senderName.charAt(0).toUpperCase() : <UserIcon size={16}/>}</AvatarFallback>
                </Avatar>
              )}
              <div
                className={cn(
                  "max-w-[70%] rounded-lg px-3 py-2 shadow",
                  msg.senderId === currentUserId
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                )}
              >
                {msg.senderId !== currentUserId && (
                    <p className="text-xs font-semibold mb-0.5 opacity-80">{msg.senderName}</p>
                )}
                {msg.text && <p className="text-sm whitespace-pre-wrap break-words">{msg.text}</p>}
                {msg.attachments && msg.attachments.map(att => (
                    <div key={att.id} className="mt-1 p-1 border border-foreground/20 rounded text-xs">
                       File: {att.name} ({(att.size / 1024).toFixed(1)} KB)
                       {att.thumbnailUrl && <img src={att.thumbnailUrl} alt="thumbnail" className="max-w-[100px] max-h-[100px] rounded mt-1"/>}
                    </div>
                ))}
                <p className={cn(
                    "text-xs opacity-70 mt-1",
                     msg.senderId === currentUserId ? "text-right" : "text-left"
                )}>
                    {formatTimestamp(msg.timestamp)}
                </p>
              </div>
               {msg.senderId === currentUserId && (
                <Avatar className="h-8 w-8 self-start border">
                  <AvatarImage src={msg.senderPhotoUrl} alt={msg.senderName} data-ai-hint="avatar person"/>
                  <AvatarFallback>{msg.senderName ? msg.senderName.charAt(0).toUpperCase() : <UserIcon size={16}/>}</AvatarFallback>
                </Avatar>
              )}
            </div>
          ))}
        </div>
        <div ref={messagesEndRef} />
      </ScrollArea>
      <footer className="p-3 border-t">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={handleAttachFile} disabled={isLoading} aria-label="Attach file">
            <Paperclip className="h-5 w-5" />
          </Button>
          <Button variant="outline" size="icon" onClick={handleEmojiPicker} disabled={isLoading} aria-label="Select emoji">
            <Smile className="h-5 w-5" />
          </Button>
          <Input
            type="text"
            placeholder="Type a message..."
            value={newMessage}
            onChange={handleInputChange}
            onKeyPress={handleKeyPress}
            disabled={isLoading || !currentUserId}
            className="flex-grow text-foreground"
          />
          <Button onClick={handleSendClick} disabled={isLoading || newMessage.trim() === '' || !currentUserId} aria-label="Send message">
            <Send className="h-5 w-5" />
          </Button>
        </div>
      </footer>
    </div>
  );
}
