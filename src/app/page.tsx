
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { OnlineUser, IncomingCallOffer, CallAnswer, UserProfile } from '@/types';
import { PhoneIncoming, PhoneOff, Video as VideoIcon } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, push, child, get, Unsubscribe, onDisconnect } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { OnlineUsersPanel } from '@/components/features/online-users/online-users-panel';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '@/components/ui/card';

type ChatState = 'idle' | 'dialing' | 'connecting' | 'connected' | 'revealed' | 'receiving_call';

const servers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// Helper to generate a simple unique ID for the session
const generateSessionId = () => Math.random().toString(36).substring(2, 10);

export default function HomePage() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<OnlineUser | null>(null);
  const [chatState, setChatState] = useState<ChatState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [incomingCall, setIncomingCall] = useState<IncomingCallOffer | null>(null);
  const [peerInfo, setPeerInfo] = useState<OnlineUser | null>(null); // Simplified from UserProfile
  const [loading, setLoading] = useState(true);


  const { toast } = useToast();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null); 
  const isCallerRef = useRef<boolean>(false);
  const firebaseListenersRef = useRef<Array<{ path: string; unsubscribe: Unsubscribe }>>([]);
  const chatStateRef = useRef<ChatState>(chatState);

  useEffect(() => {
    chatStateRef.current = chatState;
  }, [chatState]);

  // Generate session ID on component mount
  useEffect(() => {
    const newSessionId = generateSessionId();
    setSessionId(newSessionId);
    const user: OnlineUser = {
      id: newSessionId,
      name: `User-${newSessionId.substring(0, 4)}`,
      photoUrl: `https://placehold.co/96x96.png?text=${newSessionId.charAt(0).toUpperCase()}`,
    };
    setSessionUser(user);
    setLoading(false);
  }, []);
  
  // Presence system and online users listener
  useEffect(() => {
    if (!sessionUser) return;

    const userStatusRef = ref(db, `onlineUsers/${sessionUser.id}`);
    
    // Set presence and onDisconnect handler
    onValue(ref(db, '.info/connected'), (snapshot) => {
      if (snapshot.val() === true) {
        set(userStatusRef, sessionUser);
        onDisconnect(userStatusRef).remove();
      }
    });

    const onlineUsersRefPath = 'onlineUsers';
    const onlineUsersListener = onValue(ref(db, onlineUsersRefPath), (snapshot) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = usersData ? Object.values(usersData) : [];
      setOnlineUsers(userList.filter(u => u.id !== sessionUser.id)); // Exclude self
    });
    addFirebaseListener(onlineUsersRefPath, onlineUsersListener);

    return () => {
      // Component unmount or sessionUser changes
      removeFirebaseListener(onlineUsersRefPath);
      remove(userStatusRef).catch(err => console.warn("Error removing user status on unmount:", err));
    };
  }, [sessionUser]);

  // Listener for incoming calls
  useEffect(() => {
    if (!sessionUser) return;
    const incomingCallPath = `callSignals/${sessionUser.id}/pendingOffer`;
    const incomingCallListener = onValue(ref(db, incomingCallPath), (snapshot) => {
      const offerData = snapshot.val() as IncomingCallOffer | null;
      if (offerData && chatStateRef.current === 'idle') {
        setIncomingCall(offerData);
        setChatState('receiving_call');
      } else if (!offerData && chatStateRef.current === 'receiving_call') {
        setIncomingCall(null);
        setChatState('idle');
      }
    });
    addFirebaseListener(incomingCallPath, incomingCallListener);
    return () => removeFirebaseListener(incomingCallPath);
  }, [sessionUser]);

  const addFirebaseListener = (path: string, unsubscribe: Unsubscribe) => {
    removeFirebaseListener(path); 
    firebaseListenersRef.current.push({ path, unsubscribe });
  };

  const removeFirebaseListener = (path: string) => {
    const listenerIndex = firebaseListenersRef.current.findIndex(l => l.path === path);
    if (listenerIndex > -1) {
      try {
        firebaseListenersRef.current[listenerIndex].unsubscribe();
      } catch (error) {
        console.warn("Error unsubscribing Firebase listener for path:", path, error);
      }
      firebaseListenersRef.current.splice(listenerIndex, 1);
    }
  };
  
  const cleanupAllFirebaseListeners = useCallback(() => {
    firebaseListenersRef.current.forEach(({ unsubscribe, path }) => {
      try {
        unsubscribe();
      } catch (error) {
        console.warn("Error unsubscribing Firebase listener during general cleanup:", path, error);
      }
    });
    firebaseListenersRef.current = [];
  }, []);


  const cleanupWebRTC = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.onsignalingstatechange = null;
      localStream?.getTracks().forEach(track => {
        if (peerConnectionRef.current?.getSenders) {
          peerConnectionRef.current.getSenders().forEach(sender => {
            if (sender.track === track) {
              try {
                peerConnectionRef.current?.removeTrack(sender);
              } catch (e) { console.warn("Error removing track:", e); }
            }
          });
        }
      });
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    setRemoteStream(null);
  }, [localStream]);

  const cleanupCallData = useCallback(async () => {
    const currentRoomId = roomIdRef.current;
    const currentPeerId = peerIdRef.current;

    if (currentRoomId) {
      remove(ref(db, `callSignals/${currentRoomId}`)).catch(e => console.warn("Error removing room signals:", e));
      remove(ref(db, `iceCandidates/${currentRoomId}`)).catch(e => console.warn("Error removing ICE candidates for room:", e));
    }
    if (isCallerRef.current && currentPeerId) {
      remove(ref(db, `callSignals/${currentPeerId}/pendingOffer`)).catch(e => console.warn("Error removing pending offer by caller:", e));
    }
    if (!isCallerRef.current && sessionUser?.id && peerIdRef.current) {
         remove(ref(db, `callSignals/${sessionUser.id}/pendingOffer`)).catch(e => console.warn("Error removing pending offer by callee:", e));
    }
  }, [sessionUser?.id]);

  useEffect(() => {
    return () => {
      cleanupWebRTC();
      cleanupAllFirebaseListeners();
      if (sessionUser?.id) {
        remove(ref(db, `onlineUsers/${sessionUser.id}`));
      }
      cleanupCallData(); 
    };
  }, [cleanupWebRTC, cleanupAllFirebaseListeners, cleanupCallData, sessionUser?.id]);

  const handleEndCall = useCallback(async (showReveal = true) => {
    const wasConnected = chatStateRef.current === 'connected' || chatStateRef.current === 'connecting' || chatStateRef.current === 'dialing';
    
    cleanupWebRTC();
    
    if (roomIdRef.current && sessionUser?.id) {
        removeFirebaseListener(`callSignals/${roomIdRef.current}/answer`);
        removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${peerIdRef.current}`);
        removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${sessionUser.id}`);
    }
    
    await cleanupCallData();

    if (showReveal && peerIdRef.current && wasConnected) {
        const peer = onlineUsers.find(u => u.id === peerIdRef.current) || 
                     (incomingCall?.callerId === peerIdRef.current ? 
                        {id: incomingCall.callerId, name: incomingCall.callerName, photoUrl: incomingCall.callerPhotoUrl} : null);
        setPeerInfo(peer);
        setChatState('revealed');
    } else {
        setChatState('idle');
        setPeerInfo(null);
    }
    
    roomIdRef.current = null;
    peerIdRef.current = null;
    isCallerRef.current = false;
    setIncomingCall(null);

  }, [cleanupWebRTC, cleanupCallData, sessionUser?.id, onlineUsers, incomingCall]);


  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    if (!sessionUser?.id || !currentLocalStream) return null;

    const pc = new RTCPeerConnection(servers);
    currentLocalStream.getTracks().forEach(track => pc.addTrack(track, currentLocalStream));

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      } else {
        const newStream = new MediaStream();
        newStream.addTrack(event.track);
        setRemoteStream(newStream);
      }
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate && roomIdRef.current && sessionUser?.id && peerIdRef.current) {
            const candidatesRef = ref(db, `iceCandidates/${roomIdRef.current}/${sessionUser.id}`);
            push(candidatesRef, event.candidate.toJSON());
        }
    };

    pc.oniceconnectionstatechange = () => {
      if (!pc) return;
      if (pc.iceConnectionState === 'connected') {
        if (chatStateRef.current === 'connecting' || chatStateRef.current === 'dialing') setChatState('connected');
      } else if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
          toast({ title: "Connection Issue", description: `Call state: ${pc.iceConnectionState}. Ending call.`, variant: "default" });
          handleEndCall(false);
        }
      }
    };
    return pc;
  }, [sessionUser?.id, handleEndCall, toast]);

  const startLocalStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setIsVideoOn(true);
      setIsMicOn(true);
      return stream;
    } catch (err) {
      console.error("Error accessing media devices.", err);
      toast({ title: "Media Error", description: "Could not access camera/microphone.", variant: "destructive" });
      setChatState('idle');
      return null;
    }
  };

  const initiateDirectCall = async (targetUser: OnlineUser) => {
    if (!sessionUser || targetUser.id === sessionUser.id) {
      toast({title: "Cannot call self", variant: "destructive"});
      return;
    }
    await handleEndCall(false); 

    const stream = await startLocalStream();
    if (!stream) return;

    const pc = initializePeerConnection(stream);
    if (!pc) {
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      cleanupWebRTC();
      return;
    }
    peerConnectionRef.current = pc;
    
    isCallerRef.current = true;
    peerIdRef.current = targetUser.id;
    setPeerInfo(targetUser); // Set peer info early for dialing state
    const newRoomId = push(child(ref(db), 'rooms')).key; 
    if (!newRoomId) {
        toast({title: "Error", description: "Could not create a call room.", variant: "destructive"});
        return;
    }
    roomIdRef.current = newRoomId;
    setChatState('dialing');

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const offerPayload: IncomingCallOffer = {
        roomId: newRoomId,
        offer,
        callerId: sessionUser.id,
        callerName: sessionUser.name,
        callerPhotoUrl: sessionUser.photoUrl || '',
      };
      await set(ref(db, `callSignals/${targetUser.id}/pendingOffer`), offerPayload);
      toast({ title: "Calling...", description: `Calling ${targetUser.name}...` });

      const answerPath = `callSignals/${newRoomId}/answer`;
      const answerListener = onValue(ref(db, answerPath), async (snapshot) => {
        if (snapshot.exists()) {
          const { answer: answerSdp, calleeId } = snapshot.val() as CallAnswer;
          if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') {
            await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
            remove(ref(db, answerPath)); 
            removeFirebaseListener(answerPath);
          }
        }
      });
      addFirebaseListener(answerPath, answerListener);

      const calleeIcePath = `iceCandidates/${newRoomId}/${targetUser.id}`;
      const calleeIceListener = onValue(ref(db, calleeIcePath), (snapshot) => {
        snapshot.forEach((childSnapshot) => {
          const candidate = childSnapshot.val();
          if (candidate && pc.remoteDescription) { 
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding callee ICE candidate:", e));
          }
        });
      });
      addFirebaseListener(calleeIcePath, calleeIceListener);

    } catch (error) {
      console.error("Error initiating call:", error);
      toast({ title: "Call Error", description: "Could not initiate the call.", variant: "destructive" });
      handleEndCall(false);
    }
  };

  const handleAcceptCall = async () => {
    if (!incomingCall || !sessionUser) return;
    
    await handleEndCall(false); 

    const stream = await startLocalStream();
    if (!stream) {
      setIncomingCall(null);
      setChatState('idle');
      return;
    }

    const pc = initializePeerConnection(stream);
    if (!pc) {
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      setIncomingCall(null);
      setChatState('idle');
      cleanupWebRTC();
      return;
    }
    peerConnectionRef.current = pc;

    isCallerRef.current = false;
    peerIdRef.current = incomingCall.callerId;
    setPeerInfo({ id: incomingCall.callerId, name: incomingCall.callerName, photoUrl: incomingCall.callerPhotoUrl });
    roomIdRef.current = incomingCall.roomId;
    setChatState('connecting');

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const answerPayload: CallAnswer = {
        answer,
        calleeId: sessionUser.id,
      };
      await set(ref(db, `callSignals/${incomingCall.roomId}/answer`), answerPayload);
      
      await remove(ref(db, `callSignals/${sessionUser.id}/pendingOffer`));
      setIncomingCall(null); 

      const callerIcePath = `iceCandidates/${incomingCall.roomId}/${incomingCall.callerId}`;
      const callerIceListener = onValue(ref(db, callerIcePath), (snapshot) => {
        snapshot.forEach((childSnapshot) => {
          const candidate = childSnapshot.val();
          if (candidate && pc.remoteDescription) { 
             pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding caller ICE candidate:", e));
          }
        });
      });
      addFirebaseListener(callerIcePath, callerIceListener);

    } catch (error) {
      console.error("Error accepting call:", error);
      toast({ title: "Call Error", description: "Could not accept the call.", variant: "destructive" });
      handleEndCall(false);
    }
  };

  const handleDeclineCall = async () => {
    if (!incomingCall || !sessionUser) return;
    await remove(ref(db, `callSignals/${sessionUser.id}/pendingOffer`));
    setIncomingCall(null);
    setChatState('idle');
    toast({title: "Call Declined"});
  };

  const handleBackToOnlineUsers = async () => {
    await handleEndCall(false); 
    setPeerInfo(null);
  };

  const toggleMic = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => track.enabled = !isMicOn);
      setIsMicOn(!isMicOn);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => track.enabled = !isVideoOn);
      setIsVideoOn(!isVideoOn);
    }
  };

  if (loading || !sessionUser) {
    return (
      <MainLayout>
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-[250px]" />
          <p>Initializing session...</p>
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="text-center mb-4">
        <h1 className="text-4xl font-bold text-primary mb-2">BlindSpot Social</h1>
        <p className="text-lg text-foreground/80">Connect Directly. Chat Visually.</p>
      </div>

      {chatState === 'idle' && (
        <div className="flex flex-col items-center gap-6 p-8 bg-card rounded-xl shadow-lg w-full max-w-lg">
           <Card className="w-full max-w-md shadow-md">
            <CardHeader className="items-center text-center">
                <Avatar className="w-20 h-20 mb-3 border-2 border-primary">
                    <AvatarImage src={sessionUser.photoUrl} alt={sessionUser.name} data-ai-hint="avatar abstract" />
                    <AvatarFallback>{sessionUser.name.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <CardTitle className="text-xl">{sessionUser.name}</CardTitle>
                <CardDescription className="text-sm text-muted-foreground">Your current session ID: {sessionUser.id}</CardDescription>
            </CardHeader>
          </Card>
          <div className="w-full mt-6">
            <OnlineUsersPanel 
                onlineUsers={onlineUsers} 
                onInitiateCall={initiateDirectCall}
                currentUserId={sessionUser.id}
            />
          </div>
        </div>
      )}

      {(chatState === 'dialing' || chatState === 'connecting' || chatState === 'connected') && (
        <div className="w-full flex flex-col items-center gap-6">
          <VideoChatPlaceholder
            localStream={localStream}
            remoteStream={remoteStream}
            isMicOn={isMicOn}
            isVideoOn={isVideoOn}
            onToggleMic={toggleMic}
            onToggleVideo={toggleVideo}
            chatState={chatState}
            peerName={peerInfo?.name || (chatState === 'dialing' ? 'Dialing...' : 'Connecting...')}
          />
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
            <Button onClick={() => handleEndCall(true)} size="lg" className="flex-1" variant="destructive">
              <PhoneOff className="mr-2 h-5 w-5" />
              End Call
            </Button>
             {chatState === 'connected' && peerInfo && ( 
                <ReportDialog
                reportedUser={{id: peerInfo.id, name: peerInfo.name, photoUrl: peerInfo.photoUrl || '', bio: ''}} 
                triggerButtonText="Report User"
                triggerButtonVariant="outline"
                triggerButtonFullWidth={true}
                />
            )}
          </div>
        </div>
      )}

      {chatState === 'revealed' && (
        <div className="w-full flex flex-col items-center gap-8">
          <h2 className="text-3xl font-semibold text-primary">Call Ended</h2>
          {peerInfo ? (
            <>
              <p className="text-muted-foreground">You chatted with {peerInfo.name} (ID: {peerInfo.id}).</p>
              <Card className="w-full max-w-sm p-6 bg-card shadow-lg rounded-xl">
                <div className="flex flex-col items-center text-center">
                    <Avatar className="w-24 h-24 mb-4 border-2 border-primary">
                        <AvatarImage src={peerInfo.photoUrl} alt={peerInfo.name} data-ai-hint="avatar abstract"/>
                        <AvatarFallback>{peerInfo.name.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <h3 className="text-2xl font-semibold">{peerInfo.name}</h3>
                    <p className="text-sm text-muted-foreground">ID: {peerInfo.id}</p>
                </div>
              </Card>
            </>
          ) : (
            <p className="text-muted-foreground">The other user's information could not be loaded.</p>
          )}
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mt-4">
            <Button onClick={handleBackToOnlineUsers} size="lg" variant="secondary" className="flex-1">
              <VideoIcon className="mr-2 h-5 w-5" />
              Back to Online Users
            </Button>
            {peerInfo && (
                 <ReportDialog
                 reportedUser={{id: peerInfo.id, name: peerInfo.name, photoUrl: peerInfo.photoUrl || '', bio: ''}} 
                 triggerButtonText={`Report ${peerInfo.name}`}
                 triggerButtonVariant="destructive"
                 triggerButtonFullWidth={true}
               />
            )}
          </div>
        </div>
      )}
      
      {/* Incoming Call Dialog */}
      <AlertDialog open={chatState === 'receiving_call' && !!incomingCall}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
                <PhoneIncoming className="text-primary h-6 w-6" />
                Incoming Call
            </AlertDialogTitle>
            <AlertDialogDescription>
              You have an incoming call from:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-3 my-4 p-3 bg-muted/50 rounded-md">
            <Avatar className="h-12 w-12">
                <AvatarImage src={incomingCall?.callerPhotoUrl} alt={incomingCall?.callerName} data-ai-hint="avatar abstract"/>
                <AvatarFallback>{incomingCall?.callerName?.charAt(0) || 'U'}</AvatarFallback>
            </Avatar>
            <span className="font-semibold text-lg">{incomingCall?.callerName || 'Unknown Caller'}</span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDeclineCall}>Decline</AlertDialogCancel>
            <AlertDialogAction onClick={handleAcceptCall}>Accept</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </MainLayout>
  );
}

    