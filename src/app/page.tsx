
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { UserProfileCard } from '@/components/features/profile/user-profile-card';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { QueuedUsersPanel } from '@/components/features/queue/queued-users-panel';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { UserProfile } from '@/types';
import { Zap, Users, MessageSquare, Repeat } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, runTransaction, type Unsubscribe, type DatabaseReference, push } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';

type ChatState = 'idle' | 'searching' | 'connecting' | 'connected' | 'revealed';

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

const servers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export default function HomePage() {
  const [chatState, setChatState] = useState<ChatState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [currentUserProfile, setCurrentUserProfile] = useState<UserProfile>(mockCurrentUser);
  const [matchedUserProfile] = useState<UserProfile>(mockMatchedUser); 
  const [queuedUserIds, setQueuedUserIds] = useState<string[]>([]);

  const { toast } = useToast();

  const userIdRef = useRef<string | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);
  const firebaseListenersRef = useRef<Array<{ ref: DatabaseReference; unsubscribe: Unsubscribe }>>([]);
  const chatStateRef = useRef<ChatState>(chatState);

  useEffect(() => {
    chatStateRef.current = chatState;
  }, [chatState]);

  const cleanupFirebaseListeners = useCallback(() => {
    firebaseListenersRef.current.forEach(({ unsubscribe }) => {
      try {
        unsubscribe();
      } catch (error) {
        console.warn("Error unsubscribing Firebase listener:", error);
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
    if (userIdRef.current) {
      const userCallInfoRef = ref(db, `calls/${userIdRef.current}`);
      await remove(userCallInfoRef).catch(e => console.warn("Error removing user call info:", e));
    }
    if (roomIdRef.current) {
      const roomDataRef = ref(db, `rooms/${roomIdRef.current}`);
      if (isCallerRef.current || (roomIdRef.current && userIdRef.current && roomIdRef.current.startsWith(userIdRef.current))) {
         await remove(roomDataRef).catch(e => console.warn("Error removing room data:", e));
      }
    }
  }, []);

  useEffect(() => {
    const newUserId = `user_${Math.random().toString(36).substring(2, 10)}`;
    userIdRef.current = newUserId;
    setCurrentUserProfile(prev => ({ ...prev, id: newUserId }));

    // Listener for the queue
    const queueOverallRef = ref(db, 'queue');
    const queueListener = onValue(queueOverallRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const allIdsInQueue = Object.keys(data);
        // Filter out the current user's ID from the displayed list
        setQueuedUserIds(allIdsInQueue.filter(id => id !== userIdRef.current));
      } else {
        setQueuedUserIds([]);
      }
    });
    firebaseListenersRef.current.push({ ref: queueOverallRef, unsubscribe: queueListener });


    return () => {
      cleanupWebRTC();
      cleanupFirebaseListeners();
      if (userIdRef.current) {
        const queueRef = ref(db, `queue/${userIdRef.current}`);
        remove(queueRef); 
      }
      cleanupCallData();
    };
  }, [cleanupWebRTC, cleanupFirebaseListeners, cleanupCallData]);

  const handleEndCall = useCallback(async (showReveal = true) => {
    console.log("handleEndCall called, showReveal:", showReveal);
    cleanupWebRTC();
    // Keep queue listener active, but remove call-specific listeners
    const callSpecificListeners = firebaseListenersRef.current.filter(
        l => !l.ref.toString().includes('/queue') // Keep the overall queue listener
    );
    callSpecificListeners.forEach(({ unsubscribe }) => {
        try { unsubscribe(); } catch (e) { console.warn("Error unsubscribing call listener:", e); }
    });
    firebaseListenersRef.current = firebaseListenersRef.current.filter(
        l => l.ref.toString().includes('/queue')
    );
    
    await cleanupCallData();
    
    if (showReveal) {
        setChatState('revealed');
    } else {
        setChatState('idle');
    }
    roomIdRef.current = null;
    peerIdRef.current = null;
    isCallerRef.current = false;

  }, [cleanupWebRTC, cleanupFirebaseListeners, cleanupCallData]);

  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    if (!userIdRef.current) {
        console.error("initializePeerConnection: userIdRef is not set.");
        return null;
    }
    if (!currentLocalStream) {
        console.error("initializePeerConnection: currentLocalStream is null.");
        return null;
    }

    const pc = new RTCPeerConnection(servers);

    currentLocalStream.getTracks().forEach(track => {
      try {
        pc.addTrack(track, currentLocalStream);
      } catch (e) {
        console.error("Error adding track to PeerConnection:", e, track, currentLocalStream);
        toast({ title: "WebRTC Error", description: "Could not add media track to the connection.", variant: "destructive" });
      }
    });

    pc.ontrack = (event) => {
      console.log("Remote track received:", event.track, event.streams);
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      } else {
        const newStream = new MediaStream();
        newStream.addTrack(event.track);
        setRemoteStream(newStream);
      }
    };
    
    pc.oniceconnectionstatechange = () => {
      const currentPc = peerConnectionRef.current;
      if (!currentPc) return;

      console.log(`ICE connection state: ${currentPc.iceConnectionState}`);
      if (currentPc.iceConnectionState === 'connected') {
        setChatState('connected');
      } else if (
        currentPc.iceConnectionState === 'failed' || 
        currentPc.iceConnectionState === 'disconnected' || 
        currentPc.iceConnectionState === 'closed'
      ) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
            toast({ title: "Connection Issue", description: `Call state: ${currentPc.iceConnectionState}.`, variant: currentPc.iceConnectionState === 'failed' ? "destructive" : "default"});
        }
        if (currentPc.iceConnectionState === 'failed') {
            handleEndCall(false); 
        } else if (currentPc.iceConnectionState === 'closed' && chatStateRef.current !== 'revealed' && chatStateRef.current !== 'idle') {
            handleEndCall(false);
        }
      }
    };

    pc.onsignalingstatechange = () => {
        if(peerConnectionRef.current) {
            console.log(`Signaling state change: ${peerConnectionRef.current.signalingState}`);
        }
    };
    
    return pc;
  }, [toast, handleEndCall]);


  const initiateCallSequence = useCallback(async (currentRoomId: string, peerPc: RTCPeerConnection) => {
    if (!peerPc || !userIdRef.current || !peerIdRef.current) return;

    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const offerCandidatesCollectionRef = ref(db, `rooms/${currentRoomId}/callerCandidates`);
    const answerCandidatesCollectionRef = ref(db, `rooms/${currentRoomId}/calleeCandidates`);

    peerPc.onicecandidate = (event) => {
      if (event.candidate) {
        push(offerCandidatesCollectionRef, event.candidate.toJSON());
      }
    };

    const offerDescription = await peerPc.createOffer();
    await peerPc.setLocalDescription(offerDescription);
    await set(ref(roomRef, 'offer'), { sdp: offerDescription.sdp, type: offerDescription.type });

    const answerListenerRef = ref(roomRef, 'answer');
    const answerListener = onValue(answerListenerRef, async (snapshot) => {
      if (snapshot.exists()) {
        const answer = snapshot.val();
        if (peerPc.signalingState !== 'stable' && !peerPc.currentRemoteDescription) {
          try {
            await peerPc.setRemoteDescription(new RTCSessionDescription(answer));
          } catch (e) {
             console.error("Error setting remote description from answer:", e);
          }
        }
      }
    });
    firebaseListenersRef.current.push({ ref: answerListenerRef, unsubscribe: answerListener });

    const calleeIceCandidatesListenerRef = answerCandidatesCollectionRef;
    const calleeIceCandidatesListener = onValue(calleeIceCandidatesListenerRef, (snapshot) => {
      snapshot.forEach((childSnapshot) => {
        const candidate = childSnapshot.val();
        if (candidate && peerPc.currentRemoteDescription && peerPc.signalingState !== 'closed') {
          peerPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding received ICE candidate (callee):", e));
        }
      });
    });
    firebaseListenersRef.current.push({ ref: calleeIceCandidatesListenerRef, unsubscribe: calleeIceCandidatesListener });

  }, []);

  const answerCallSequence = useCallback(async (currentRoomId: string, peerPc: RTCPeerConnection) => {
    if (!peerPc || !userIdRef.current || !peerIdRef.current) return;

    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const offerCandidatesCollectionRef = ref(db, `rooms/${currentRoomId}/callerCandidates`);
    const answerCandidatesCollectionRef = ref(db, `rooms/${currentRoomId}/calleeCandidates`);

    peerPc.onicecandidate = (event) => {
      if (event.candidate) {
        push(answerCandidatesCollectionRef, event.candidate.toJSON());
      }
    };
    
    const offerListenerRef = ref(roomRef, 'offer');
    const offerListener = onValue(offerListenerRef, async (snapshot) => {
      if (snapshot.exists()) {
        const offer = snapshot.val();
         if (peerPc.signalingState !== 'stable' && !peerPc.currentRemoteDescription) {
            try {
                await peerPc.setRemoteDescription(new RTCSessionDescription(offer));
                const answerDescription = await peerPc.createAnswer();
                await peerPc.setLocalDescription(answerDescription);
                await set(ref(roomRef, 'answer'), { sdp: answerDescription.sdp, type: answerDescription.type });
            } catch (e) {
                console.error("Error during answer sequence:", e);
            }
        }
      }
    });
    firebaseListenersRef.current.push({ ref: offerListenerRef, unsubscribe: offerListener });
    
    const callerIceCandidatesListenerRef = offerCandidatesCollectionRef;
    const callerIceCandidatesListener = onValue(callerIceCandidatesListenerRef, (snapshot) => {
      snapshot.forEach((childSnapshot) => {
        const candidate = childSnapshot.val();
         if (candidate && peerPc.currentRemoteDescription && peerPc.signalingState !== 'closed') {
          peerPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding received ICE candidate (caller):", e));
        }
      });
    });
    firebaseListenersRef.current.push({ ref: callerIceCandidatesListenerRef, unsubscribe: callerIceCandidatesListener });

  }, []);

  const startLocalStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream); 
      setIsVideoOn(true);
      setIsMicOn(true);
      return stream; 
    } catch (err) {
      console.error("Error accessing media devices.", err);
      toast({ title: "Media Error", description: "Could not access camera/microphone. Please check permissions.", variant: "destructive" });
      return null;
    }
  };
  
  const handleStartChat = async () => {
    if (!userIdRef.current) return;
    
    console.log("Starting chat initiation...");
    await cleanupWebRTC(); 
    
    const callSpecificListeners = firebaseListenersRef.current.filter(
        l => !l.ref.toString().includes('/queue')
    );
    callSpecificListeners.forEach(({ unsubscribe }) => {
        try { unsubscribe(); } catch (e) { console.warn("Error unsubscribing call listener:", e); }
    });
    firebaseListenersRef.current = firebaseListenersRef.current.filter(
        l => l.ref.toString().includes('/queue')
    );

    await cleanupCallData(); 
    
    setChatState('searching');
    roomIdRef.current = null;
    peerIdRef.current = null;

    const stream = await startLocalStream();
    if (!stream) {
      setChatState('idle'); 
      return;
    }
    
    const pc = initializePeerConnection(stream); 
    if (!pc) {
      toast({ title: "Error", description: "Failed to initialize video call components.", variant: "destructive"});
      setChatState('idle');
      await cleanupWebRTC(); 
      return;
    }
    peerConnectionRef.current = pc; 

    const currentUserCallRef = ref(db, `calls/${userIdRef.current}`);
    const callListener = onValue(currentUserCallRef, (snapshot) => {
      if (snapshot.exists() && snapshot.val().role === 'callee' && !roomIdRef.current && chatStateRef.current === 'searching') { 
        const callData = snapshot.val();
        const listenerIndex = firebaseListenersRef.current.findIndex(l => l.ref.toString() === currentUserCallRef.toString());
        if (listenerIndex > -1) {
            firebaseListenersRef.current[listenerIndex].unsubscribe();
            firebaseListenersRef.current.splice(listenerIndex, 1);
        }
        
        const userInQueueRef = ref(db, `queue/${userIdRef.current!}`);
        remove(userInQueueRef);

        roomIdRef.current = callData.roomId;
        peerIdRef.current = callData.peerId;
        isCallerRef.current = false;
        setChatState('connecting');
        if (peerConnectionRef.current) { 
            answerCallSequence(callData.roomId, peerConnectionRef.current);
        } else {
            console.error("PeerConnection not available for answerCallSequence");
            handleEndCall(false);
        }
      }
    }, (error) => {
      console.error("Firebase onValue error for calls:", error);
      toast({title: "Error", description: "Connection to matching service failed.", variant: "destructive"});
    });
    firebaseListenersRef.current.push({ ref: currentUserCallRef, unsubscribe: callListener });

    const queueDbRef = ref(db, `queue`);
    runTransaction(queueDbRef, (currentQueueData) => {
      if (chatStateRef.current !== 'searching' && chatStateRef.current !== 'idle') { 
        return; 
      }
      if (currentQueueData === null) {
        return { [userIdRef.current!]: { timestamp: Date.now() } };
      }
      const availableUserIds = Object.keys(currentQueueData).filter(id => id !== userIdRef.current);
      
      if (availableUserIds.length > 0) {
        const peerToCall = availableUserIds.sort((a,b) => currentQueueData[a].timestamp - currentQueueData[b].timestamp)[0]; 
        delete currentQueueData[peerToCall];
        if (currentQueueData[userIdRef.current!]) delete currentQueueData[userIdRef.current!];

        isCallerRef.current = true;
        peerIdRef.current = peerToCall;
        const newRoomId = `${userIdRef.current}_${peerToCall}`;
        roomIdRef.current = newRoomId;
        
        Promise.all([
          set(ref(db, `calls/${peerToCall}`), { roomId: newRoomId, role: 'callee', peerId: userIdRef.current }),
          set(ref(db, `calls/${userIdRef.current!}`), { roomId: newRoomId, role: 'caller', peerId: peerToCall })
        ]).then(() => {
          setChatState('connecting');
           if (peerConnectionRef.current) { 
             initiateCallSequence(newRoomId, peerConnectionRef.current);
           } else {
            console.error("PeerConnection not available for initiateCallSequence");
            handleEndCall(false);
           }
        }).catch(e => {
            console.error("Error setting up call roles:", e);
            handleEndCall(false);
        });
        
        return currentQueueData;
      } else {
        currentQueueData[userIdRef.current!] = { timestamp: Date.now() };
        return currentQueueData;
      }
    }).catch(error => {
      console.error("Queue transaction error:", error);
      toast({ title: "Matching Error", description: "Could not join the matching queue.", variant: "destructive" });
      setChatState('idle');
      cleanupWebRTC(); 
    });
  };

  const handleFindNew = async () => {
    await handleEndCall(false); 
    setTimeout(() => {
        handleStartChat();
    }, 100);
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

  return (
    <MainLayout>
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-primary mb-2">BlindSpot Social</h1>
        <p className="text-lg text-foreground/80">Connect Anonymously. Reveal Meaningfully.</p>
      </div>

      {chatState === 'idle' && (
        <div className="flex flex-col items-center gap-6 p-8 bg-card rounded-xl shadow-lg w-full max-w-md">
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

      {(chatState === 'searching' || chatState === 'connecting' || chatState === 'connected') && (
        <div className="w-full flex flex-col items-center gap-6">
          <VideoChatPlaceholder 
            localStream={localStream}
            remoteStream={remoteStream}
            isMicOn={isMicOn}
            isVideoOn={isVideoOn}
            onToggleMic={toggleMic}
            onToggleVideo={toggleVideo}
            chatState={chatState}
          />
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
            <Button onClick={() => handleEndCall(true)} size="lg" className="flex-1" disabled={chatState !== 'connected'}>
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
            <UserProfileCard user={currentUserProfile} />
            <UserProfileCard user={matchedUserProfile} /> 
          </div>
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mt-4">
            <Button onClick={handleFindNew} size="lg" variant="secondary" className="flex-1">
              <Repeat className="mr-2 h-5 w-5" />
              Find Someone New
            </Button>
            <ReportDialog 
              reportedUser={matchedUserProfile} 
              triggerButtonText={`Report ${matchedUserProfile.name}`}
              triggerButtonVariant="destructive"
              triggerButtonFullWidth={true}
            />
          </div>
        </div>
      )}
      
      <QueuedUsersPanel queuedUserIds={queuedUserIds} />

    </MainLayout>
  );
}
