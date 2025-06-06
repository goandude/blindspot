
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { MainLayout } from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, serverTimestamp, type DatabaseReference, push, child } from 'firebase/database';
import type { OnlineUser, UserProfile, RoomSignal } from '@/types';
import { Video, Mic, MicOff, VideoOff, PhoneOff, Users, LogOut, Copy, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';

const servers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

interface RemoteStreamWithUser extends MediaStream {
  userId?: string;
  userName?: string;
  userPhotoUrl?: string;
  dataAiHint?: string;
}

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const roomId = typeof params.roomId === 'string' ? params.roomId : null;
  const { toast } = useToast();

  const { currentUser: authCurrentUser, userProfile: authUserProfile, loading: authLoading } = useAuth();
  const [sessionUser, setSessionUser] = useState<OnlineUser | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RemoteStreamWithUser>>(new Map());
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [participants, setParticipants] = useState<OnlineUser[]>([]);
  
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isInRoom, setIsInRoom] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const firebaseListeners = useRef<Map<string, { ref: DatabaseReference, callback: (snapshot: any) => void }>>(new Map());

  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const currentSId = sessionUser?.id || 'N/A';
    const prefix = `[${currentSId.substring(0, 4)}] [Room ${roomId?.substring(0,4) || 'N/A'}] `;
    const logEntry = `[${timestamp}] ${prefix}${message}`;
    setDebugLogs(prevLogs => [logEntry, ...prevLogs].slice(0, 100));
    // console.log(logEntry); // Optional: also log to browser console
  }, [sessionUser, roomId]);

  // Effect to establish sessionUser (either from auth or generate anonymous)
  useEffect(() => {
    if (authLoading) {
      addDebugLog("Auth still loading, waiting...");
      return;
    }

    if (authCurrentUser && authUserProfile) {
      addDebugLog(`Authenticated user: ${authUserProfile.name} (${authCurrentUser.uid})`);
      const googleSessionUser: OnlineUser = {
        id: authCurrentUser.uid, name: authUserProfile.name, photoUrl: authUserProfile.photoUrl,
        dataAiHint: authUserProfile.dataAiHint, countryCode: authUserProfile.countryCode, isGoogleUser: true,
      };
      setSessionUser(googleSessionUser);
      setIsLoading(false);
    } else if (!authCurrentUser) {
      addDebugLog("No authenticated user, creating anonymous session for room.");
      const anonymousRoomId = `anon-${Math.random().toString(36).substring(2, 10)}`;
       const fetchCountryAndSetAnonymousUser = async () => {
        let countryCode = 'XX';
        try {
          const response = await fetch('https://ipapi.co/country_code/');
          if (response.ok) countryCode = (await response.text()).trim();
        } catch (e) { /* ignore */ }
        const anonUser: OnlineUser = {
          id: anonymousRoomId, name: `User-${anonymousRoomId.substring(5, 9)}`,
          photoUrl: `https://placehold.co/96x96.png?text=${anonymousRoomId.charAt(5).toUpperCase()}`,
          dataAiHint: 'abstract character', countryCode, isGoogleUser: false,
        };
        setSessionUser(anonUser);
        setIsLoading(false);
        addDebugLog(`Anonymous session for room: ${anonUser.name} (${anonUser.id})`);
      };
      fetchCountryAndSetAnonymousUser();
    }
  }, [authCurrentUser, authUserProfile, authLoading, addDebugLog]);


  const cleanupPeerConnection = useCallback((peerId: string) => {
    addDebugLog(`Cleaning up peer connection for ${peerId}`);
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onsignalingstatechange = null;
      pc.getSenders().forEach(sender => {
        if (sender.track) sender.track.stop();
        try { pc.removeTrack(sender); } catch (e) { /* ignore */ }
      });
      if (pc.signalingState !== 'closed') pc.close();
      peerConnectionsRef.current.delete(peerId);
    }
    setRemoteStreams(prev => {
      const newStreams = new Map(prev);
      newStreams.delete(peerId);
      return newStreams;
    });
  }, [addDebugLog]);

  const handleLeaveRoom = useCallback(async () => {
    addDebugLog(`Leaving room ${roomId}`);
    setIsInRoom(false);

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }

    peerConnectionsRef.current.forEach((pc, peerId) => {
      cleanupPeerConnection(peerId);
    });
    peerConnectionsRef.current.clear();
    setRemoteStreams(new Map());

    if (roomId && sessionUser?.id) {
      const participantRef = ref(db, `conferenceRooms/${roomId}/participants/${sessionUser.id}`);
      remove(participantRef).catch(e => addDebugLog(`Error removing self from participants: ${e.message}`));
      
      // Clean up signals directed TO this user
      const mySignalsRef = ref(db, `conferenceRooms/${roomId}/signals/${sessionUser.id}`);
      remove(mySignalsRef).catch(e => addDebugLog(`Error removing my signals folder: ${e.message}`));

      // Iterate over current participants to remove signals sent BY this user TO them
      participants.forEach(p => {
        if (p.id !== sessionUser.id) {
          // This is a bit broad, ideally signals would have unique IDs to remove.
          // For simplicity, we're not implementing fine-grained signal removal by sender for now.
          // A more robust solution might involve a cloud function for cleanup or TTL on signals.
        }
      });
    }
    
    firebaseListeners.current.forEach(({ ref: fRef, callback }) => off(fRef, 'value', callback));
    firebaseListeners.current.clear();

    setParticipants([]);
    toast({ title: "Left Room", description: "You have left the conference room." });
    router.push('/');
  }, [roomId, sessionUser, localStream, cleanupPeerConnection, addDebugLog, toast, router, participants]);


  const initializeAndSendOffer = useCallback(async (peerId: string, peerName?: string) => {
    if (!localStream || !roomId || !sessionUser?.id || peerConnectionsRef.current.has(peerId)) {
      addDebugLog(`Cannot send offer to ${peerId}. localStream: ${!!localStream}, roomId: ${roomId}, sessionUser: ${sessionUser?.id}, already connected: ${peerConnectionsRef.current.has(peerId)}`);
      return;
    }
    addDebugLog(`Initializing PC and sending offer to ${peerId} (${peerName || 'Unknown'})`);

    const pc = new RTCPeerConnection(servers);
    peerConnectionsRef.current.set(peerId, pc);

    localStream.getTracks().forEach(track => {
      try { pc.addTrack(track, localStream); } 
      catch (e: any) { addDebugLog(`Error adding local track for ${peerId}: ${e.message}`); }
    });

    pc.onicecandidate = event => {
      if (event.candidate && roomId && sessionUser?.id) {
        const signalPayload: RoomSignal = {
          type: 'candidate',
          senderId: sessionUser.id,
          senderName: sessionUser.name,
          data: event.candidate.toJSON(),
        };
        const candidateRef = push(ref(db, `conferenceRooms/${roomId}/signals/${peerId}`));
        set(candidateRef, signalPayload)
          .catch(e => addDebugLog(`Error sending ICE candidate to ${peerId}: ${e.message}`));
      }
    };

    pc.ontrack = event => {
      addDebugLog(`Remote track received from ${peerId}: Kind: ${event.track.kind}`);
      const existingStream = remoteStreams.get(peerId) || new MediaStream();
      event.streams[0].getTracks().forEach(track => existingStream.addTrack(track));
      
      const streamWithUser = existingStream as RemoteStreamWithUser;
      streamWithUser.userId = peerId;
      const participantData = participants.find(p => p.id === peerId);
      streamWithUser.userName = participantData?.name || peerId;
      streamWithUser.userPhotoUrl = participantData?.photoUrl;
      streamWithUser.dataAiHint = participantData?.dataAiHint;

      setRemoteStreams(prev => new Map(prev).set(peerId, streamWithUser));
    };
    
    pc.oniceconnectionstatechange = () => {
      addDebugLog(`ICE state for ${peerId}: ${pc.iceConnectionState}`);
      if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
         addDebugLog(`ICE connection to ${peerId} failed/disconnected. Cleaning up.`);
         cleanupPeerConnection(peerId);
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const offerPayload: RoomSignal = {
        type: 'offer',
        senderId: sessionUser.id,
        senderName: sessionUser.name,
        data: offer,
      };
      const offerRef = push(ref(db, `conferenceRooms/${roomId}/signals/${peerId}`));
      await set(offerRef, offerPayload);
      addDebugLog(`Offer sent to ${peerId}`);
    } catch (error: any) {
      addDebugLog(`Error creating/sending offer to ${peerId}: ${error.message}`);
      cleanupPeerConnection(peerId);
    }
  }, [localStream, roomId, sessionUser, addDebugLog, remoteStreams, participants, cleanupPeerConnection]);

  // Main effect for joining room, setting up listeners
  useEffect(() => {
    if (!isInRoom || !roomId || !sessionUser?.id || !localStream) return;

    addDebugLog(`Setting up Firebase listeners for room ${roomId}, user ${sessionUser.id}`);

    // 1. Listen for signals addressed to current user
    const mySignalsRefPath = `conferenceRooms/${roomId}/signals/${sessionUser.id}`;
    const mySignalsRef = ref(db, mySignalsRefPath);
    const signalsCallback = (snapshot: any) => {
      if (!snapshot.exists()) return;
      snapshot.forEach((childSnapshot: any) => {
        const signal = childSnapshot.val() as RoomSignal;
        const signalKey = childSnapshot.key;
        const { senderId, senderName, type, data } = signal;

        if (!senderId || senderId === sessionUser.id) return; // Ignore signals from self or invalid

        addDebugLog(`Received signal type '${type}' from ${senderId} (${senderName || 'Unknown'})`);
        let pc = peerConnectionsRef.current.get(senderId);

        if (type === 'offer') {
          if (pc) {
            addDebugLog(`WARN: Received offer from ${senderId}, but PC already exists. Possible race or old offer.`);
            // Potentially close existing and create new, or ignore if signalingState is stable
          }
          pc = new RTCPeerConnection(servers);
          peerConnectionsRef.current.set(senderId, pc);

          localStream.getTracks().forEach(track => {
            try { pc!.addTrack(track, localStream); }
            catch (e:any) { addDebugLog(`Error adding local track on offer from ${senderId}: ${e.message}`); }
          });

          pc.onicecandidate = event => {
            if (event.candidate && roomId && sessionUser?.id) {
              const candidatePayload: RoomSignal = {
                type: 'candidate',
                senderId: sessionUser.id,
                senderName: sessionUser.name,
                data: event.candidate.toJSON(),
              };
              const candidateRef = push(ref(db, `conferenceRooms/${roomId}/signals/${senderId}`));
              set(candidateRef, candidatePayload).catch(e => addDebugLog(`Error sending ICE to ${senderId} (on offer): ${e.message}`));
            }
          };

          pc.ontrack = event => {
            addDebugLog(`Remote track received from ${senderId} (on offer): Kind: ${event.track.kind}`);
            const existingStream = remoteStreams.get(senderId) || new MediaStream();
            event.streams[0].getTracks().forEach(track => existingStream.addTrack(track));
            
            const streamWithUser = existingStream as RemoteStreamWithUser;
            streamWithUser.userId = senderId;
            const participantData = participants.find(p => p.id === senderId);
            streamWithUser.userName = participantData?.name || senderId;
            streamWithUser.userPhotoUrl = participantData?.photoUrl;
            streamWithUser.dataAiHint = participantData?.dataAiHint;

            setRemoteStreams(prev => new Map(prev).set(senderId, streamWithUser));
          };
          
          pc.oniceconnectionstatechange = () => {
            addDebugLog(`ICE state for ${senderId} (on offer): ${pc!.iceConnectionState}`);
             if (['failed', 'disconnected', 'closed'].includes(pc!.iceConnectionState)) {
               addDebugLog(`ICE connection to ${senderId} failed/disconnected (on offer path). Cleaning up.`);
               cleanupPeerConnection(senderId);
            }
          };

          pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit))
            .then(() => pc!.createAnswer())
            .then(answer => pc!.setLocalDescription(answer))
            .then(() => {
              const answerPayload: RoomSignal = {
                type: 'answer',
                senderId: sessionUser.id!,
                senderName: sessionUser.name,
                data: pc!.localDescription!,
              };
              const answerRef = push(ref(db, `conferenceRooms/${roomId}/signals/${senderId}`));
              return set(answerRef, answerPayload);
            })
            .then(() => addDebugLog(`Answer sent to ${senderId}`))
            .catch(e => {
              addDebugLog(`Error processing offer / sending answer to ${senderId}: ${e.message}`);
              cleanupPeerConnection(senderId);
            });

        } else if (type === 'answer' && pc) {
          pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit))
            .then(() => addDebugLog(`Remote description (answer) set from ${senderId}`))
            .catch(e => addDebugLog(`Error setting remote desc (answer) from ${senderId}: ${e.message}`));
        } else if (type === 'candidate' && pc) {
          pc.addIceCandidate(new RTCIceCandidate(data as RTCIceCandidateInit))
            .catch(e => addDebugLog(`Error adding ICE candidate from ${senderId}: ${e.message}`));
        }
        // Remove processed signal
        if (signalKey) remove(child(mySignalsRef, signalKey)).catch(e => addDebugLog(`Failed to remove processed signal ${signalKey}: ${e.message}`));
      });
    };
    onValue(mySignalsRef, signalsCallback);
    firebaseListeners.current.set(mySignalsRefPath, { ref: mySignalsRef, callback: signalsCallback });

    // 2. Listen for participants joining/leaving
    const participantsRefPath = `conferenceRooms/${roomId}/participants`;
    const participantsRef = ref(db, participantsRefPath);
    const participantsCallback = (snapshot: any) => {
      const newParticipantsList: OnlineUser[] = [];
      snapshot.forEach((childSnapshot: any) => {
        newParticipantsList.push({ id: childSnapshot.key, ...childSnapshot.val() } as OnlineUser);
      });
      setParticipants(newParticipantsList);
      addDebugLog(`Participants updated: ${newParticipantsList.map(p => p.name).join(', ')}`);

      newParticipantsList.forEach(p => {
        if (p.id !== sessionUser.id && !peerConnectionsRef.current.has(p.id) && localStream) {
           // New participant joined who is not self and not already connected
           addDebugLog(`New participant ${p.name} (${p.id}) detected. Initializing connection.`);
           initializeAndSendOffer(p.id, p.name);
        }
      });
      
      // Check for participants who left
      peerConnectionsRef.current.forEach((pc, peerId) => {
        if (!newParticipantsList.find(p => p.id === peerId)) {
          addDebugLog(`Participant ${peerId} left. Cleaning up their connection.`);
          cleanupPeerConnection(peerId);
        }
      });
    };
    onValue(participantsRef, participantsCallback);
    firebaseListeners.current.set(participantsRefPath, { ref: participantsRef, callback: participantsCallback });

    return () => {
      addDebugLog(`Cleaning up Firebase listeners for room ${roomId}, user ${sessionUser.id}`);
      firebaseListeners.current.forEach(({ ref: fRef, callback }, path) => {
        off(fRef, 'value', callback);
        addDebugLog(`Detached listener for ${path}`);
      });
      firebaseListeners.current.clear();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInRoom, roomId, sessionUser, localStream, initializeAndSendOffer, cleanupPeerConnection, addDebugLog]); // participants removed to avoid loop with initializeAndSendOffer

  const handleJoinRoom = async () => {
    if (!sessionUser || !roomId) {
      toast({ title: "Error", description: "Session or Room ID missing.", variant: "destructive" });
      return;
    }
    addDebugLog(`Attempting to join room ${roomId} as ${sessionUser.name}`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setIsMicOn(true);
      setIsVideoOn(true);

      const participantRef = ref(db, `conferenceRooms/${roomId}/participants/${sessionUser.id}`);
      const participantData: OnlineUser = { ...sessionUser, timestamp: serverTimestamp() };
      await set(participantRef, participantData);
      participantRef.onDisconnect().remove(); // Set onDisconnect for self
      
      setIsInRoom(true);
      toast({ title: "Joined Room!", description: `You are now in room ${roomId}.` });
      addDebugLog("Successfully joined room and set presence.");
    } catch (err: any) {
      addDebugLog(`Error joining room or getting media: ${err.message}`);
      toast({ title: "Join Error", description: `Could not join room: ${err.message}`, variant: "destructive" });
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        setLocalStream(null);
      }
    }
  };

  const toggleMic = () => {
    if (localStream) {
      const enabled = !isMicOn;
      localStream.getAudioTracks().forEach(track => track.enabled = enabled);
      setIsMicOn(enabled);
      addDebugLog(`Mic toggled: ${enabled ? 'ON' : 'OFF'}`);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const enabled = !isVideoOn;
      localStream.getVideoTracks().forEach(track => track.enabled = enabled);
      setIsVideoOn(enabled);
      addDebugLog(`Video toggled: ${enabled ? 'ON' : 'OFF'}`);
    }
  };

  const copyRoomLinkToClipboard = () => {
    const link = window.location.href;
    navigator.clipboard.writeText(link)
      .then(() => toast({ title: "Link Copied!", description: "Room link copied to clipboard." }))
      .catch(err => toast({ title: "Copy Failed", description: "Could not copy link.", variant: "destructive" }));
  };
  
  const VideoFeed = ({ stream, user, isLocal }: { stream: MediaStream, user?: OnlineUser | {name?: string, photoUrl?: string, dataAiHint?: string, id?: string }, isLocal?: boolean}) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    useEffect(() => {
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
      }
    }, [stream]);

    const FallbackAvatar = () => (
      <Avatar className="w-16 h-16 border-2 border-muted">
          <AvatarImage src={user?.photoUrl} alt={user?.name || 'User'} data-ai-hint={user?.dataAiHint || "avatar abstract"} />
          <AvatarFallback>{user?.name ? user.name.charAt(0).toUpperCase() : <Users />}</AvatarFallback>
      </Avatar>
    );

    return (
      <Card className="overflow-hidden shadow-lg relative aspect-video flex flex-col justify-between bg-muted">
        <video ref={videoRef} autoPlay playsInline muted={isLocal} className="w-full h-full object-cover absolute inset-0" />
        {isLocal && !isVideoOn && (
           <div className="absolute inset-0 flex items-center justify-center bg-black/70">
             <VideoOff className="w-1/3 h-1/3 text-white" />
           </div>
        )}
        {!isLocal && !stream.getVideoTracks().find(t=>t.enabled) && ( // Heuristic for remote video off
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-white p-2">
                <FallbackAvatar />
                <p className="mt-2 text-sm truncate">{user?.name || user?.id || 'User'}</p>
                <p className="text-xs">Video Off</p>
            </div>
        )}
         {!isLocal && stream.getVideoTracks().length === 0 && ( // No video track at all
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-white p-2">
                <FallbackAvatar />
                <p className="mt-2 text-sm truncate">{user?.name || user?.id || 'User'}</p>
                <p className="text-xs">No Video</p>
            </div>
        )}
        <CardFooter className="p-2 bg-gradient-to-t from-black/50 to-transparent text-xs text-white z-10 mt-auto">
          <p className="truncate">{isLocal ? `${sessionUser?.name || 'You'} (You)` : user?.name || user?.id || 'Remote User'}</p>
          {/* Add mic status icon here if available */}
        </CardFooter>
      </Card>
    );
  };


  if (isLoading || !roomId) {
    return (
      <MainLayout>
        <Card className="w-full max-w-md p-8 text-center">
          <Skeleton className="h-8 w-3/4 mx-auto mb-4" />
          <Skeleton className="h-10 w-1/2 mx-auto" />
          <p className="mt-4 text-muted-foreground">Loading room...</p>
        </Card>
      </MainLayout>
    );
  }
  
  if (!sessionUser) {
     return (
      <MainLayout>
        <Card className="w-full max-w-md p-8 text-center">
            <AlertTriangle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <CardTitle className="text-xl mb-2">Session Error</CardTitle>
            <CardDescription>Could not establish a user session for the room. Please try again or return to the home page.</CardDescription>
            <Button onClick={() => router.push('/')} className="mt-6">Go to Home</Button>
        </Card>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="w-full max-w-6xl mx-auto">
        <Card className="mb-6 shadow-xl">
          <CardHeader className="flex flex-row justify-between items-center">
            <div>
              <CardTitle className="text-2xl">Conference Room: {roomId.substring(0,8)}...</CardTitle>
              <CardDescription>Currently {participants.length} participant(s) in the room.</CardDescription>
            </div>
            <div className="flex gap-2">
               <Button onClick={copyRoomLinkToClipboard} variant="outline" size="sm">
                <Copy className="mr-2 h-4 w-4" /> Copy Link
              </Button>
              {isInRoom ? (
                <Button onClick={handleLeaveRoom} variant="destructive" size="sm">
                  <PhoneOff className="mr-2 h-4 w-4" /> Leave Room
                </Button>
              ) : (
                <Button onClick={handleJoinRoom} size="sm">
                  <Users className="mr-2 h-4 w-4" /> Join Conference
                </Button>
              )}
            </div>
          </CardHeader>
           {isInRoom && (
            <CardFooter className="border-t pt-4 flex justify-center gap-3">
                <Button variant="outline" size="icon" onClick={toggleMic} disabled={!localStream} aria-label="Toggle Microphone">
                    {isMicOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
                </Button>
                <Button variant="outline" size="icon" onClick={toggleVideo} disabled={!localStream} aria-label="Toggle Camera">
                    {isVideoOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
                </Button>
                 <Button onClick={() => router.push('/')} variant="outline" size="sm">
                  <LogOut className="mr-2 h-4 w-4" /> Back to Home
                </Button>
            </CardFooter>
          )}
        </Card>

        {isInRoom ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {localStream && sessionUser && (
              <VideoFeed stream={localStream} user={sessionUser} isLocal />
            )}
            {Array.from(remoteStreams.entries()).map(([peerId, stream]) => {
                const participantUser = participants.find(p => p.id === peerId) || { id: peerId, name: `User ${peerId.substring(0,4)}`};
                return <VideoFeed key={peerId} stream={stream} user={participantUser} />;
            })}
             {/* Placeholders for empty slots up to a certain number for better grid appearance */}
            { Array.from({ length: Math.max(0, 1 - (Array.from(remoteStreams.keys()).length + (localStream ? 1: 0) )) }).map((_, i) => (
                <Card key={`placeholder-${i}`} className="aspect-video flex items-center justify-center bg-muted/50 border-dashed border-muted-foreground/50">
                    <Users className="w-12 h-12 text-muted-foreground/50" />
                </Card>
            ))}
          </div>
        ) : (
          <Card className="p-8 text-center">
            <Users className="w-16 h-16 mx-auto text-primary mb-4" />
            <CardTitle className="text-xl">Ready to join?</CardTitle>
            <CardDescription>Click "Join Conference" above to start your video and connect with others.</CardDescription>
          </Card>
        )}
        
        {/* Debug Log Panel (optional, can be removed for production) */}
        <div className="w-full max-w-2xl mt-8 mx-auto">
            <Card>
                <CardHeader className="p-3">
                    <CardTitle className="text-sm">Room Debug Log</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="max-h-[200px] overflow-y-auto p-2 text-xs space-y-1 bg-muted/30 rounded-b-md">
                    {debugLogs.map((log, index) => (
                        <div key={index} className="font-mono whitespace-pre-wrap break-all">
                        {log}
                        </div>
                    ))}
                    {debugLogs.length === 0 && <p className="text-muted-foreground italic">No logs yet.</p>}
                    </div>
                </CardContent>
            </Card>
        </div>

      </div>
    </MainLayout>
  );
}
