
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { UserProfileCard } from '@/components/features/profile/user-profile-card';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { UserProfile } from '@/types';
import { Zap, Users, MessageSquare, Repeat, VideoOff, MicOff, Video, Mic } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, runTransaction, type Unsubscribe, type DatabaseReference } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';

type ChatState = 'idle' | 'searching' | 'connecting' | 'connected' | 'revealed';

const mockCurrentUser: UserProfile = {
  id: 'user1', // This will be overridden by dynamic userId
  name: 'Alex Miller',
  photoUrl: 'https://placehold.co/300x300.png',
  dataAiHint: 'man smiling',
  bio: 'Enjoys coding, reading sci-fi, and exploring new tech. Always up for an interesting conversation.',
};

const mockMatchedUser: UserProfile = {
  id: 'user2', // This will be dynamic if we fetch profile later
  name: 'Samira Jones',
  photoUrl: 'https://placehold.co/300x300.png',
  dataAiHint: 'woman laughing',
  bio: 'Loves painting, long walks in nature, and discovering hidden gems in the city. Creative soul.',
};

// For WebRTC
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
  // Matched user profile could be fetched if we store profile data against user IDs
  const [matchedUserProfile] = useState<UserProfile>(mockMatchedUser); 

  const { toast } = useToast();

  const userIdRef = useRef<string | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);
  const firebaseListenersRef = useRef<Array<{ ref: DatabaseReference; unsubscribe: Unsubscribe }>>([]);

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
      remove(userCallInfoRef);
    }
    if (roomIdRef.current) {
      const roomDataRef = ref(db, `rooms/${roomIdRef.current}`);
      // Only the caller (or first part of room ID) should ideally clear the room, or use a 'disconnected' flag.
      // For simplicity, both attempt to remove. This might cause a benign "permission_denied" if already removed.
      if (isCallerRef.current || (roomIdRef.current && userIdRef.current && roomIdRef.current.startsWith(userIdRef.current))) {
         remove(roomDataRef);
      }
    }
  }, []);


  useEffect(() => {
    // Generate a unique ID for this user session
    const newUserId = `user_${Math.random().toString(36).substring(2, 10)}`;
    userIdRef.current = newUserId;
    setCurrentUserProfile(prev => ({ ...prev, id: newUserId }));

    return () => {
      // Global cleanup on component unmount
      cleanupWebRTC();
      cleanupFirebaseListeners();
      if (userIdRef.current) {
        const queueRef = ref(db, `queue/${userIdRef.current}`);
        remove(queueRef); // Remove from queue if still there
      }
      cleanupCallData();
    };
  }, [cleanupWebRTC, cleanupFirebaseListeners, cleanupCallData]);


  const initializePeerConnection = useCallback(() => {
    if (!localStream || !userIdRef.current) return null;

    const pc = new RTCPeerConnection(servers);

    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };
    
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === 'connected') {
        setChatState('connected');
      } else if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'closed') {
        toast({ title: "Connection Lost", description: "The connection with the peer was lost.", variant: "destructive"});
        handleEndCall(false); // Don't show reveal screen on connection drop
      }
    };

    peerConnectionRef.current = pc;
    return pc;
  }, [localStream, toast]);


  const initiateCallSequence = useCallback(async (currentRoomId: string, peerPc: RTCPeerConnection) => {
    if (!peerPc || !userIdRef.current || !peerIdRef.current) return;

    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const offerCandidatesRef = ref(db, `rooms/${currentRoomId}/callerCandidates`);
    const answerCandidatesRef = ref(db, `rooms/${currentRoomId}/calleeCandidates`);

    peerPc.onicecandidate = (event) => {
      if (event.candidate) {
        set(ref(db, `rooms/${currentRoomId}/callerCandidates/${event.candidate.sdpMid}_${event.candidate.sdpMLineIndex}`), event.candidate.toJSON());
      }
    };

    const offerDescription = await peerPc.createOffer();
    await peerPc.setLocalDescription(offerDescription);
    await set(ref(roomRef, 'offer'), { sdp: offerDescription.sdp, type: offerDescription.type });

    const answerListener = onValue(ref(roomRef, 'answer'), async (snapshot) => {
      if (snapshot.exists()) {
        const answer = snapshot.val();
        if (peerPc.signalingState !== 'stable' && !peerPc.currentRemoteDescription) { // Check signalingState
          try {
            await peerPc.setRemoteDescription(new RTCSessionDescription(answer));
          } catch (e) {
             console.error("Error setting remote description from answer:", e);
          }
        }
      }
    });
    firebaseListenersRef.current.push({ ref: ref(roomRef, 'answer'), unsubscribe: answerListener });

    const calleeIceCandidatesListener = onValue(answerCandidatesRef, (snapshot) => {
      snapshot.forEach((childSnapshot) => {
        const candidate = childSnapshot.val();
        if (candidate && peerPc.currentRemoteDescription) { // Only add if remote description is set
          peerPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding received ICE candidate (callee):", e));
        }
      });
    });
    firebaseListenersRef.current.push({ ref: answerCandidatesRef, unsubscribe: calleeIceCandidatesListener });

  }, []);

  const answerCallSequence = useCallback(async (currentRoomId: string, peerPc: RTCPeerConnection) => {
    if (!peerPc || !userIdRef.current || !peerIdRef.current) return;

    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const offerCandidatesRef = ref(db, `rooms/${currentRoomId}/callerCandidates`);
    const answerCandidatesRef = ref(db, `rooms/${currentRoomId}/calleeCandidates`);

    peerPc.onicecandidate = (event) => {
      if (event.candidate) {
        set(ref(db, `rooms/${currentRoomId}/calleeCandidates/${event.candidate.sdpMid}_${event.candidate.sdpMLineIndex}`), event.candidate.toJSON());
      }
    };
    
    const offerListener = onValue(ref(roomRef, 'offer'), async (snapshot) => {
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
    firebaseListenersRef.current.push({ ref: ref(roomRef, 'offer'), unsubscribe: offerListener });

    const callerIceCandidatesListener = onValue(offerCandidatesRef, (snapshot) => {
      snapshot.forEach((childSnapshot) => {
        const candidate = childSnapshot.val();
         if (candidate && peerPc.currentRemoteDescription) {
          peerPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding received ICE candidate (caller):", e));
        }
      });
    });
    firebaseListenersRef.current.push({ ref: offerCandidatesRef, unsubscribe: callerIceCandidatesListener });

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
      setChatState('idle');
      return null;
    }
  };
  
  const handleStartChat = async () => {
    if (!userIdRef.current) return;
    
    cleanupWebRTC();
    cleanupFirebaseListeners();
    await cleanupCallData();
    
    setChatState('searching');
    roomIdRef.current = null;
    peerIdRef.current = null;

    const stream = await startLocalStream();
    if (!stream) return;
    
    const pc = initializePeerConnection(); // Initialize with the new local stream
    if (!pc) {
      toast({ title: "Error", description: "Failed to initialize video call components.", variant: "destructive"});
      setChatState('idle');
      return;
    }

    // Listen for incoming calls
    const currentUserCallRef = ref(db, `calls/${userIdRef.current}`);
    const callListener = onValue(currentUserCallRef, (snapshot) => {
      if (snapshot.exists() && snapshot.val().role === 'callee' && !roomIdRef.current) { // Ensure not already in a room
        const callData = snapshot.val();
        // Detach this specific listener once triggered
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
        answerCallSequence(callData.roomId, pc);
      }
    }, (error) => {
      console.error("Firebase onValue error for calls:", error);
      toast({title: "Error", description: "Connection to matching service failed.", variant: "destructive"});
    });
    firebaseListenersRef.current.push({ ref: currentUserCallRef, unsubscribe: callListener });


    // Attempt to find a match or join the queue
    const queueDbRef = ref(db, `queue`);
    runTransaction(queueDbRef, (currentQueueData) => {
      if (currentQueueData === null) {
        return { [userIdRef.current!]: { timestamp: Date.now() } };
      }
      const availableUserIds = Object.keys(currentQueueData).filter(id => id !== userIdRef.current);
      
      if (availableUserIds.length > 0) {
        const peerToCall = availableUserIds.sort((a,b) => currentQueueData[a].timestamp - currentQueueData[b].timestamp)[0]; // Oldest user
        delete currentQueueData[peerToCall];
        if (currentQueueData[userIdRef.current!]) delete currentQueueData[userIdRef.current!]; // remove self too if added previously

        isCallerRef.current = true;
        peerIdRef.current = peerToCall;
        const newRoomId = `${userIdRef.current}_${peerToCall}`;
        roomIdRef.current = newRoomId;
        
        // Perform these writes outside transaction to avoid nesting
        Promise.all([
          set(ref(db, `calls/${peerToCall}`), { roomId: newRoomId, role: 'callee', peerId: userIdRef.current }),
          set(ref(db, `calls/${userIdRef.current!}`), { roomId: newRoomId, role: 'caller', peerId: peerToCall })
        ]).then(() => {
          setChatState('connecting');
          initiateCallSequence(newRoomId, pc);
        }).catch(e => console.error("Error setting up call roles:", e));
        
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

  const handleEndCall = useCallback((showReveal = true) => {
    cleanupWebRTC();
    cleanupFirebaseListeners(); // Detach all active listeners
    cleanupCallData();
    
    if (showReveal) {
        setChatState('revealed');
    } else {
        setChatState('idle');
    }
    // Reset refs for next call
    roomIdRef.current = null;
    peerIdRef.current = null;
    isCallerRef.current = false;

  }, [cleanupWebRTC, cleanupFirebaseListeners, cleanupCallData]);


  const handleFindNew = () => {
    handleEndCall(false); // Clean up current state without revealing
    // Delay slightly to allow cleanup then start new chat
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
              reportedUser={null} // For anonymous phase
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
            <UserProfileCard user={matchedUserProfile} /> {/* Using mock matched user */}
          </div>
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mt-4">
            <Button onClick={handleFindNew} size="lg" variant="secondary" className="flex-1">
              <Repeat className="mr-2 h-5 w-5" />
              Find Someone New
            </Button>
            <ReportDialog 
              reportedUser={matchedUserProfile} // Use actual matched user data if available
              triggerButtonText={`Report ${matchedUserProfile.name}`}
              triggerButtonVariant="destructive"
              triggerButtonFullWidth={true}
            />
          </div>
        </div>
      )}
    </MainLayout>
  );
}
