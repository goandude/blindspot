"use client";

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { UserProfileCard } from '@/components/features/profile/user-profile-card';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { UserProfile } from '@/types';
import { Zap, Users, MessageSquare, Repeat } from 'lucide-react';

type ChatState = 'idle' | 'chatting' | 'revealed';

const mockCurrentUser: UserProfile = {
  id: 'user1',
  name: 'Alex Miller',
  photoUrl: 'https://placehold.co/300x300.png',
  dataAiHint: 'man smiling',
  bio: 'Enjoys coding, reading sci-fi, and exploring new tech. Always up for an interesting conversation.',
};

const mockMatchedUser: UserProfile = {
  id: 'user2',
  name: 'Samira Jones',
  photoUrl: 'https://placehold.co/300x300.png',
  dataAiHint: 'woman laughing',
  bio: 'Loves painting, long walks in nature, and discovering hidden gems in the city. Creative soul.',
};

export default function HomePage() {
  const [chatState, setChatState] = useState<ChatState>('idle');

  const handleStartChat = () => setChatState('chatting');
  const handleRevealProfiles = () => setChatState('revealed');
  const handleFindNew = () => setChatState('idle');

  return (
    <MainLayout>
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-primary mb-2">BlindSpot Social</h1>
        <p className="text-lg text-foreground/80">Connect Anonymously. Reveal Meaningfully.</p>
      </div>

      {chatState === 'idle' && (
        <div className="flex flex-col items-center gap-6 p-8 bg-card rounded-xl shadow-lg w-full">
          <Zap className="w-16 h-16 text-accent" />
          <h2 className="text-2xl font-semibold text-foreground">Ready for a Spark?</h2>
          <p className="text-center text-muted-foreground max-w-sm">
            Dive into an anonymous video chat. If you click, you might just meet someone amazing.
          </p>
          <Button onClick={handleStartChat} size="lg" className="w-full max-w-xs">
            <MessageSquare className="mr-2 h-5 w-5" />
            Start Anonymous Chat
          </Button>
        </div>
      )}

      {chatState === 'chatting' && (
        <div className="w-full flex flex-col items-center gap-6">
          <VideoChatPlaceholder />
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
            <Button onClick={handleRevealProfiles} size="lg" className="flex-1">
              <Users className="mr-2 h-5 w-5" />
              End Chat & Reveal Profiles
            </Button>
            <ReportDialog 
              reportedUser={null} 
              triggerButtonText="Report Anonymous User"
              triggerButtonVariant="destructive"
              triggerButtonFullWidth={true} 
            />
          </div>
        </div>
      )}

      {chatState === 'revealed' && (
        <div className="w-full flex flex-col items-center gap-8">
          <h2 className="text-3xl font-semibold text-primary">Profiles Revealed!</h2>
          <div className="grid md:grid-cols-2 gap-8 w-full">
            <UserProfileCard user={mockCurrentUser} />
            <UserProfileCard user={mockMatchedUser} />
          </div>
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mt-4">
            <Button onClick={handleFindNew} size="lg" variant="secondary" className="flex-1">
              <Repeat className="mr-2 h-5 w-5" />
              Find Someone New
            </Button>
            <ReportDialog 
              reportedUser={mockMatchedUser} 
              triggerButtonText={`Report ${mockMatchedUser.name}`}
              triggerButtonVariant="destructive"
              triggerButtonFullWidth={true}
            />
          </div>
        </div>
      )}
    </MainLayout>
  );
}
