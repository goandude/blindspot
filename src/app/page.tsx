
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
import { ref, set, onValue, off, remove, runTransaction, type Unsubscribe, type DatabaseReference, push, serverTimestamp } from 'firebase/database';
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
    // Only the caller should remove the room data to simplify cleanup
    if (roomIdRef.current && isCallerRef.current) {
      const roomDataRef = ref(db, `rooms/${roomIdRef.current}`);
      await remove(roomDataRef).catch(e => console.warn("Error removing room data:", e));
    }
  }, []); // Note: isCallerRef, userIdRef, roomIdRef are refs, their .current value is used.

  useEffect(() => {
    const newUserId = `user_${Math.random().toString(36).substring(2, 10)}`;
    userIdRef.current = newUserId;
    setCurrentUserProfile(prev => ({ ...prev, id: newUserId }));

    const queueOverallRef = ref(db, 'queue');
    const queueListener = onValue(queueOverallRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        const allIdsInQueue = Object.keys(data);
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
        const queueUserRef = ref(db, `queue/${userIdRef.current}`);
        remove(queueUserRef);
      }
      cleanupCallData();
    };
  }, [cleanupWebRTC, cleanupFirebaseListeners, cleanupCallData]);


  const handleEndCall = useCallback(async (showReveal = true) => {
    console.log("handleEndCall called, showReveal:", showReveal, "Current role (isCaller):", isCallerRef.current, "Room ID:", roomIdRef.current);

    // Store current role and room ID before cleanup might clear them
    const wasCaller = isCallerRef.current;
    const endedRoomId = roomIdRef.current;

    cleanupWebRTC();
    
    const callSpecificListeners = firebaseListenersRef.current.filter(
        l => !l.ref.toString().includes('/queue')
    );
    callSpecificListeners.forEach(({ unsubscribe }) => {
        try { unsubscribe(); } catch (e) { console.warn("Error unsubscribing call listener:", e); }
    });
    firebaseListenersRef.current = firebaseListenersRef.current.filter(
        l => l.ref.toString().includes('/queue')
    );

    // Cleanup call data from Firebase
    if (userIdRef.current) {
        const userCallInfoRef = ref(db, `calls/${userIdRef.current}`);
        await remove(userCallInfoRef).catch(e => console.warn("Error removing user call info:", e));
    }
    if (endedRoomId && wasCaller) { // Caller removes the room
        const roomDataRef = ref(db, `rooms/${endedRoomId}`);
        await remove(roomDataRef).catch(e => console.warn("Error removing room data for caller:", e));
    }
    
    if (showReveal) {
        setChatState('revealed');
    } else {
        setChatState('idle');
    }
    roomIdRef.current = null;
    peerIdRef.current = null;
    isCallerRef.current = false;

  }, [cleanupWebRTC, cleanupFirebaseListeners]); // cleanupCallData removed as it's called internally now


  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    if (!userIdRef.current) {
        console.error("initializePeerConnection: userIdRef is not set.");
        toast({ title: "Initialization Error", description: "User ID not available for WebRTC.", variant: "destructive" });
        return null;
    }
    if (!currentLocalStream) {
        console.error("initializePeerConnection: currentLocalStream is null.");
        toast({ title: "Media Error", description: "Local media stream not available for WebRTC.", variant: "destructive" });
        return null;
    }

    const pc = new RTCPeerConnection(servers);

    currentLocalStream.getTracks().forEach(track => {
      try {
        pc.addTrack(track, currentLocalStream);
      } catch (e) {
        console.error("Error adding track to PeerConnection:", e, track, currentLocalStream);
        toast({ title: "WebRTC Error", description: "Could not add media track.", variant: "destructive" });
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
        if (chatStateRef.current === 'connecting') setChatState('connected');
      } else if (
        currentPc.iceConnectionState === 'failed' ||
        currentPc.iceConnectionState === 'disconnected' ||
        currentPc.iceConnectionState === 'closed'
      ) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
            toast({ title: "Connection Issue", description: `Call state: ${currentPc.iceConnectionState}. Ending call.`, variant: currentPc.iceConnectionState === 'failed' ? "destructive" : "default"});
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
    if (!peerPc || !userIdRef.current || !peerIdRef.current) {
        console.error("initiateCallSequence: Missing PC, userId, or peerId.", {pc: !!peerPc, userId: userIdRef.current, peerId: peerIdRef.current});
        return;
    }
    console.log(`Initiating call sequence for room ${currentRoomId} to peer ${peerIdRef.current}`);

    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const offerCandidatesCollectionRef = ref(db, `rooms/${currentRoomId}/callerCandidates`);

    peerPc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("Caller ICE candidate:", event.candidate);
        push(offerCandidatesCollectionRef, event.candidate.toJSON());
      }
    };

    try {
        const offerDescription = await peerPc.createOffer();
        await peerPc.setLocalDescription(offerDescription);
        await set(ref(roomRef, 'offer'), { sdp: offerDescription.sdp, type: offerDescription.type });
        console.log("Offer created and set for room:", currentRoomId);
    } catch (e) {
        console.error("Error creating or setting offer:", e);
        toast({ title: "Call Setup Error", description: "Failed to create call offer.", variant: "destructive" });
        handleEndCall(false);
        return;
    }

    const answerListenerRef = ref(roomRef, 'answer');
    const answerListener = onValue(answerListenerRef, async (snapshot) => {
      if (snapshot.exists()) {
        const answer = snapshot.val();
        console.log("Received answer:", answer);
        if (peerPc.signalingState !== 'stable' && !peerPc.currentRemoteDescription) {
          try {
            await peerPc.setRemoteDescription(new RTCSessionDescription(answer));
            console.log("Remote description (answer) set by caller.");
          } catch (e) {
             console.error("Error setting remote description from answer (caller):", e);
          }
        }
      }
    });
    firebaseListenersRef.current.push({ ref: answerListenerRef, unsubscribe: answerListener });

    const calleeIceCandidatesListenerRef = ref(db, `rooms/${currentRoomId}/calleeCandidates`);
    const calleeIceCandidatesListener = onValue(calleeIceCandidatesListenerRef, (snapshot) => {
      snapshot.forEach((childSnapshot) => {
        const candidate = childSnapshot.val();
        if (candidate && peerPc.currentRemoteDescription && peerPc.signalingState !== 'closed') {
          console.log("Caller received callee ICE candidate:", candidate);
          peerPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding received ICE candidate (callee for caller):", e));
        }
      });
    });
    firebaseListenersRef.current.push({ ref: calleeIceCandidatesListenerRef, unsubscribe: calleeIceCandidatesListener });
  }, [toast, handleEndCall]);

  const answerCallSequence = useCallback(async (currentRoomId: string, peerPc: RTCPeerConnection) => {
    if (!peerPc || !userIdRef.current || !peerIdRef.current) {
        console.error("answerCallSequence: Missing PC, userId, or peerId.", {pc: !!peerPc, userId: userIdRef.current, peerId: peerIdRef.current});
        return;
    }
    console.log(`Answering call sequence for room ${currentRoomId} from peer ${peerIdRef.current}`);

    const roomRef = ref(db, `rooms/${currentRoomId}`);
    const answerCandidatesCollectionRef = ref(db, `rooms/${currentRoomId}/calleeCandidates`);

    peerPc.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("Callee ICE candidate:", event.candidate);
        push(answerCandidatesCollectionRef, event.candidate.toJSON());
      }
    };

    const offerListenerRef = ref(roomRef, 'offer');
    const offerListener = onValue(offerListenerRef, async (snapshot) => {
      if (snapshot.exists()) {
        const offer = snapshot.val();
        console.log("Received offer:", offer);
         if (peerPc.signalingState !== 'stable' && !peerPc.currentRemoteDescription) { // Check if remote description not already set
            try {
                await peerPc.setRemoteDescription(new RTCSessionDescription(offer));
                console.log("Remote description (offer) set by callee.");
                const answerDescription = await peerPc.createAnswer();
                await peerPc.setLocalDescription(answerDescription);
                await set(ref(roomRef, 'answer'), { sdp: answerDescription.sdp, type: answerDescription.type });
                console.log("Answer created and set for room:", currentRoomId);
            } catch (e) {
                console.error("Error during answer sequence (setting offer/creating answer):", e);
                toast({ title: "Call Setup Error", description: "Failed to process call offer.", variant: "destructive" });
                handleEndCall(false);
            }
        }
      }
    }, (error) => {
        console.error("Error listening to offer:", error);
        toast({ title: "Connection Error", description: "Failed to receive call details.", variant: "destructive" });
        handleEndCall(false);
    });
    firebaseListenersRef.current.push({ ref: offerListenerRef, unsubscribe: offerListener });

    const callerIceCandidatesListenerRef = ref(db, `rooms/${currentRoomId}/callerCandidates`);
    const callerIceCandidatesListener = onValue(callerIceCandidatesListenerRef, (snapshot) => {
      snapshot.forEach((childSnapshot) => {
        const candidate = childSnapshot.val();
         if (candidate && peerPc.currentRemoteDescription && peerPc.signalingState !== 'closed') {
          console.log("Callee received caller ICE candidate:", candidate);
          peerPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding received ICE candidate (caller for callee):", e));
        }
      });
    });
    firebaseListenersRef.current.push({ ref: callerIceCandidatesListenerRef, unsubscribe: callerIceCandidatesListener });
  }, [toast, handleEndCall]);


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
    if (!userIdRef.current) {
        toast({ title: "Error", description: "User ID not available.", variant: "destructive" });
        return;
    }
    console.log(`User ${userIdRef.current} starting chat initiation...`);

    // 1. Cleanup previous state
    await handleEndCall(false); // Ensures clean state before starting new
    
    // Reset refs for new call attempt (handleEndCall might not have set them if it wasn't a "full" call)
    roomIdRef.current = null;
    peerIdRef.current = null;
    isCallerRef.current = false;

    // 2. Start local stream & initialize PeerConnection
    const stream = await startLocalStream();
    if (!stream) {
      // startLocalStream handles toast and sets chatState to 'idle' on failure
      return;
    }

    const pc = initializePeerConnection(stream);
    if (!pc) {
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components. Check console.", variant: "destructive"});
      setChatState('idle');
      await cleanupWebRTC();
      return;
    }
    peerConnectionRef.current = pc;

    // 3. Set up listener for incoming calls (for this user acting as callee)
    const currentUserCallRef = ref(db, `calls/${userIdRef.current}`);
    const callListener = onValue(currentUserCallRef, async (snapshot) => {
      if (snapshot.exists() && snapshot.val().role === 'callee' && chatStateRef.current === 'searching') {
        const callData = snapshot.val();
        console.log(`User ${userIdRef.current} received call offer (acting as callee):`, callData);
        
        // Unsubscribe this specific listener once the call is accepted/processed
        const listenerIndex = firebaseListenersRef.current.findIndex(l => l.ref.toString() === currentUserCallRef.toString());
        if (listenerIndex > -1) {
            firebaseListenersRef.current[listenerIndex].unsubscribe();
            firebaseListenersRef.current.splice(listenerIndex, 1);
        }
        
        const userInQueueRef = ref(db, `queue/${userIdRef.current!}`); // Remove self from queue
        await remove(userInQueueRef);

        roomIdRef.current = callData.roomId;
        peerIdRef.current = callData.peerId;
        isCallerRef.current = false; // This user is the callee
        setChatState('connecting');

        if (peerConnectionRef.current) {
            answerCallSequence(callData.roomId, peerConnectionRef.current);
        } else {
            console.error("Callee: PeerConnection not available for answerCallSequence.");
            toast({ title: "WebRTC Error", description: "Connection component missing for answering call.", variant: "destructive" });
            handleEndCall(false);
        }
      }
    }, (error) => {
      console.error("Firebase onValue error for calls listener:", error);
      toast({title: "Connection Error", description: "Failed to listen for incoming calls.", variant: "destructive"});
      handleEndCall(false);
    });
    firebaseListenersRef.current.push({ ref: currentUserCallRef, unsubscribe: callListener });


    // 4. Attempt to find a peer or join queue (Transaction)
    setChatState('searching'); // Optimistically set to searching
    const queueDbRef = ref(db, `queue`);
    let matchedPeerId: string | null = null;
    let newRoomIdForCaller: string | null = null;

    runTransaction(queueDbRef, (currentQueueData) => {
      if (chatStateRef.current !== 'searching') { // Abort if state changed (e.g. already connected by incoming call)
          console.log("Transaction aborted: Chat state is no longer 'searching'. Current state:", chatStateRef.current);
        return; // Abort transaction
      }
      if (currentQueueData === null) {
        currentQueueData = {};
      }
      // Filter out current user, just in case of weird race conditions
      const availableUserIds = Object.keys(currentQueueData).filter(id => id !== userIdRef.current);

      if (availableUserIds.length > 0) { // Match found
        const peerToCall = availableUserIds.sort((a,b) => currentQueueData[a].timestamp - currentQueueData[b].timestamp)[0];
        console.log(`Transaction: User ${userIdRef.current} found peer ${peerToCall} in queue.`);
        
        matchedPeerId = peerToCall; // Store for post-transaction logic
        newRoomIdForCaller = `${userIdRef.current}_${peerToCall}`;

        delete currentQueueData[peerToCall]; // Remove matched peer from queue
        if (currentQueueData[userIdRef.current!]) { // Remove self if accidentally added
             delete currentQueueData[userIdRef.current!];
        }
        return currentQueueData; // Commit changes (empty or reduced queue)
      } else { // No peer found, add self to queue
        console.log(`Transaction: User ${userIdRef.current} joining queue.`);
        currentQueueData[userIdRef.current!] = { timestamp: serverTimestamp(), status: 'waiting' };
        return currentQueueData; // Commit changes (user added to queue)
      }
    }).then(async (result) => {
      if (!result.committed) {
        console.warn("Queue transaction was not committed. Likely aborted due to state change or contention.");
        if(chatStateRef.current === 'searching') { // If still searching, means something else went wrong
            setChatState('idle');
            toast({ title: "Matching Error", description: "Could not join or find match in queue. Please try again.", variant: "destructive" });
        }
        return;
      }

      console.log("Queue transaction committed. Current user:", userIdRef.current, "Matched Peer:", matchedPeerId);

      if (matchedPeerId && newRoomIdForCaller) { // A peer was matched by this user (this user is the caller)
        isCallerRef.current = true;
        peerIdRef.current = matchedPeerId;
        roomIdRef.current = newRoomIdForCaller;
        
        console.log(`User ${userIdRef.current} (Caller) matched with ${peerIdRef.current}. Room: ${roomIdRef.current}`);
        setChatState('connecting');

        try {
            // Set up call signalling paths
            await set(ref(db, `calls/${peerIdRef.current}`), { roomId: roomIdRef.current, role: 'callee', peerId: userIdRef.current });
            await set(ref(db, `calls/${userIdRef.current!}`), { roomId: roomIdRef.current, role: 'caller', peerId: peerIdRef.current });
            console.log("Caller: Firebase call roles set.");

            if (peerConnectionRef.current) {
                initiateCallSequence(roomIdRef.current, peerConnectionRef.current);
            } else {
                console.error("Caller: PeerConnection not available for initiateCallSequence.");
                toast({ title: "WebRTC Error", description: "Connection component missing for starting call.", variant: "destructive" });
                handleEndCall(false);
            }
        } catch (e) {
            console.error("Error setting up call roles or initiating call:", e);
            toast({ title: "Call Setup Error", description: "Failed to establish call signalling.", variant: "destructive" });
            handleEndCall(false);
        }
      } else { // No peer was matched, this user was added to the queue
        console.log(`User ${userIdRef.current} added to queue, now searching.`);
        // chatState is already 'searching'
        toast({ title: "Searching...", description: "You've been added to the queue. Waiting for a peer." });
      }
    }).catch(error => {
      console.error("Queue transaction failed:", error);
      toast({ title: "Matching Error", description: "An error occurred with the matching queue. Please try again.", variant: "destructive" });
      setChatState('idle');
      cleanupWebRTC();
    });
  };


  const handleFindNew = async () => {
    await handleEndCall(false);
    setTimeout(() => { // Short delay to ensure cleanup completes
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

    