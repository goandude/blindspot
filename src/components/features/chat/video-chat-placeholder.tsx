
"use client";

import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Video, Mic, MicOff, VideoOff, Users, Zap } from 'lucide-react';
import { useEffect, useRef } from 'react';

interface VideoChatPlaceholderProps {
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  onToggleMic?: () => void;
  onToggleVideo?: () => void;
  isMicOn?: boolean;
  isVideoOn?: boolean;
  chatState: 'idle' | 'dialing' | 'connecting' | 'connected' | 'revealed'; // Updated chatState
  peerName?: string; // Added to display peer name
}

export function VideoChatPlaceholder({
  localStream,
  remoteStream,
  onToggleMic,
  onToggleVideo,
  isMicOn = true,
  isVideoOn = true,
  chatState,
  peerName,
}: VideoChatPlaceholderProps) {
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
    }
  }, [localStream]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
    }
  }, [remoteStream]);

  const getTitle = () => {
    if (chatState === 'connected') return `Connected with ${peerName || 'Peer'}!`;
    if (chatState === 'connecting') return `Connecting to ${peerName || 'Peer'}...`;
    if (chatState === 'dialing') return `Calling ${peerName || 'Peer'}...`;
    return "Video Call"; // Default title, should ideally not be seen in active call states
  }

  return (
    <Card className="w-full shadow-xl overflow-hidden">
      <CardHeader className="bg-muted/50 p-4">
        <CardTitle className="text-lg text-center text-foreground/90">{getTitle()}</CardTitle>
      </CardHeader>
      <CardContent className="p-0 aspect-video bg-black flex flex-col items-center justify-center relative">
        {/* Remote Video Feed */}
        <div className="w-full h-full absolute inset-0">
          <video ref={remoteVideoRef} autoPlay playsInline className="w-full h-full object-cover" />
          {!remoteStream && (chatState === 'connecting' || chatState === 'connected') && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-primary-foreground">
              <Users className="w-16 h-16 text-primary-foreground/70 mb-2" />
              <p className="text-lg">Waiting for {peerName || 'peer'}...</p>
            </div>
          )}
        </div>

        {/* Local Video Preview (picture-in-picture style) */}
        {localStream && (
          <div className="absolute bottom-4 right-4 w-1/4 max-w-[150px] aspect-[4/3] border-2 border-primary rounded-md overflow-hidden shadow-lg z-10">
            <video ref={localVideoRef} autoPlay playsInline muted className="w-full h-full object-cover" />
             {!isVideoOn && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/70">
                    <VideoOff className="w-1/3 h-1/3 text-white" />
                </div>
            )}
          </div>
        )}
        
        {/* Overlays for dialing/connecting states */}
        {(chatState === 'dialing' || (chatState === 'connecting' && !remoteStream)) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 z-20">
              <Zap className="w-16 h-16 text-primary mb-4 animate-pulse" />
              <p className="text-primary-foreground text-xl font-medium">
                {chatState === 'dialing' ? `Calling ${peerName || 'user'}...` : "Establishing connection..."}
              </p>
              <p className="text-primary-foreground/80">Please wait.</p>
            </div>
        )}
         {!localStream && (chatState === 'dialing' || chatState === 'connecting' || chatState === 'connected') && (
             <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-primary-foreground z-20">
               <VideoOff className="w-16 h-16 text-primary-foreground/70 mb-2" />
               <p className="text-lg">Camera not active</p>
             </div>
           )}

      </CardContent>
      <CardFooter className="flex justify-center gap-3 p-4 bg-muted/50">
        <Button variant="outline" size="icon" aria-label="Toggle Microphone" onClick={onToggleMic} disabled={!localStream || chatState === 'dialing' || chatState === 'connecting'}>
          {isMicOn ? <Mic className="w-5 h-5" /> : <MicOff className="w-5 h-5" />}
        </Button>
        <Button variant="outline" size="icon" aria-label="Toggle Camera" onClick={onToggleVideo} disabled={!localStream || chatState === 'dialing' || chatState === 'connecting'}>
          {isVideoOn ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
        </Button>
      </CardFooter>
    </Card>
  );
}

    