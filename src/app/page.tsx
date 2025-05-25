
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { UserProfileCard } from '@/components/features/profile/user-profile-card';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { QueuedUsersPanel } from '@/components/features/queue/queued-users-panel';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { UserProfile } from '@/types';
import { Zap, Users, MessageSquare, Repeat, LogIn, LogOut, UserCircle, Edit3 } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, runTransaction, type Unsubscribe, type DatabaseReference, push, serverTimestamp } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';


type ChatState = 'idle' | 'searching' | 'connecting' | 'connected' | 'revealed';

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
  const { user: firebaseUser, profile: currentUserProfile, loading: authLoading, signInWithGoogle, signOut, updateUserProfile } = useAuth();
  const [chatState, setChatState] = useState<ChatState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [queuedUserIds, setQueuedUserIds] = useState<string[]>([]);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [editableProfile, setEditableProfile] = useState<Partial<UserProfile>>({});


  const { toast } = useToast();

  const userIdRef = useRef<string | null>(null); // Will be set to firebaseUser.uid
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);
  const firebaseListenersRef = useRef<Array<{ ref: DatabaseReference; unsubscribe: Unsubscribe }>>([]);
  const chatStateRef = useRef<ChatState>(chatState);

  useEffect(() => {
    chatStateRef.current = chatState;
  }, [chatState]);

  useEffect(() => {
    if (currentUserProfile) {
      userIdRef.current = currentUserProfile.id;
       // Pre-fill editable profile when current user profile loads or changes
      setEditableProfile({
        name: currentUserProfile.name,
        bio: currentUserProfile.bio,
      });
    } else {
      userIdRef.current = null;
    }
  }, [currentUserProfile]);
  
  const handleOpenProfileModal = () => {
    if (currentUserProfile) {
      setEditableProfile({
        name: currentUserProfile.name,
        bio: currentUserProfile.bio,
        // photoUrl can be added if you implement photo uploads
      });
      setIsProfileModalOpen(true);
    }
  };

  const handleSaveProfile = async () => {
    if (!currentUserProfile || !firebaseUser) return;
    const updates: Partial<UserProfile> = {};
    if (editableProfile.name && editableProfile.name !== currentUserProfile.name) {
      updates.name = editableProfile.name;
    }
    if (editableProfile.bio && editableProfile.bio !== currentUserProfile.bio) {
      updates.bio = editableProfile.bio;
    }

    if (Object.keys(updates).length > 0) {
      await updateUserProfile(firebaseUser.uid, updates);
    }
    setIsProfileModalOpen(false);
  };


  // Firebase queue listener setup
  useEffect(() => {
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
      firebaseListenersRef.current.find(l => l.ref === queueOverallRef)?.unsubscribe();
      firebaseListenersRef.current = firebaseListenersRef.current.filter(l => l.ref !== queueOverallRef);
    };
  }, []); // Empty dependency: sets up general queue listener once

  const cleanupFirebaseListeners = useCallback(() => {
    const callSpecificListeners = firebaseListenersRef.current.filter(
        l => !l.ref.toString().includes('/queue') // Keep the general queue listener
    );
    callSpecificListeners.forEach(({ unsubscribe }) => {
      try {
        unsubscribe();
      } catch (error) {
        console.warn("Error unsubscribing Firebase listener:", error);
      }
    });
    firebaseListenersRef.current = firebaseListenersRef.current.filter(
        l => l.ref.toString().includes('/queue')
    );
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
    // User specific call data cleanup
    if (userIdRef.current) {
      const userCallInfoRef = ref(db, `calls/${userIdRef.current}`);
      await remove(userCallInfoRef).catch(e => console.warn("Error removing user call info:", e));
    }
    // Room data cleanup (caller responsibility)
    if (roomIdRef.current && isCallerRef.current) {
      const roomDataRef = ref(db, `rooms/${roomIdRef.current}`);
      await remove(roomDataRef).catch(e => console.warn("Error removing room data:", e));
    }
  }, []); // isCallerRef, userIdRef, roomIdRef are refs


  // General cleanup on unmount or when firebaseUser changes (logout)
  useEffect(() => {
    return () => {
      cleanupWebRTC();
      cleanupFirebaseListeners(); // This now only cleans call-specific ones
      if (userIdRef.current) { // If user was logged in and in queue
        const queueUserRef = ref(db, `queue/${userIdRef.current}`);
        remove(queueUserRef);
      }
      cleanupCallData();
    };
  }, [cleanupWebRTC, cleanupFirebaseListeners, cleanupCallData, firebaseUser]);


  const handleEndCall = useCallback(async (showReveal = true) => {
    console.log("handleEndCall called, showReveal:", showReveal, "Current role (isCaller):", isCallerRef.current, "Room ID:", roomIdRef.current);
    
    const wasCaller = isCallerRef.current;
    const endedRoomId = roomIdRef.current;

    cleanupWebRTC();
    cleanupFirebaseListeners(); // Clean up call-specific listeners

    // Cleanup call data from Firebase
    if (userIdRef.current) {
        const userCallInfoRef = ref(db, `calls/${userIdRef.current}`);
        await remove(userCallInfoRef).catch(e => console.warn("Error removing user call info:", e));
    }
     if (endedRoomId && wasCaller) { 
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

  }, [cleanupWebRTC, cleanupFirebaseListeners]);


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
         if (peerPc.signalingState !== 'stable' && !peerPc.currentRemoteDescription) { 
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
    if (!userIdRef.current || !currentUserProfile) {
        toast({ title: "Not Logged In", description: "Please log in to start chatting.", variant: "destructive" });
        return;
    }
    console.log(`User ${userIdRef.current} starting chat initiation...`);

    await handleEndCall(false); 
    
    roomIdRef.current = null;
    peerIdRef.current = null;
    isCallerRef.current = false;

    const stream = await startLocalStream();
    if (!stream) return;

    const pc = initializePeerConnection(stream);
    if (!pc) {
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive"});
      setChatState('idle');
      await cleanupWebRTC();
      return;
    }
    peerConnectionRef.current = pc;

    const currentUserCallPath = `calls/${userIdRef.current}`;
    const currentUserCallRef = ref(db, currentUserCallPath);
    
    // Remove any previous listener for this exact path to avoid duplicates
    firebaseListenersRef.current = firebaseListenersRef.current.filter(l => {
        if (l.ref.toString().endsWith(currentUserCallPath)) {
            try { l.unsubscribe(); } catch (e) { console.warn("Error unsubscribing old call listener:", e); }
            return false;
        }
        return true;
    });

    const callListener = onValue(currentUserCallRef, async (snapshot) => {
      if (snapshot.exists() && snapshot.val().role === 'callee' && chatStateRef.current === 'searching') {
        const callData = snapshot.val();
        console.log(`User ${userIdRef.current} received call offer (acting as callee):`, callData);
        
        const listenerIndex = firebaseListenersRef.current.findIndex(l => l.ref.toString().endsWith(currentUserCallPath));
        if (listenerIndex > -1) {
            firebaseListenersRef.current[listenerIndex].unsubscribe();
            firebaseListenersRef.current.splice(listenerIndex, 1);
        }
        
        const userInQueueRef = ref(db, `queue/${userIdRef.current!}`);
        await remove(userInQueueRef);

        roomIdRef.current = callData.roomId;
        peerIdRef.current = callData.peerId;
        isCallerRef.current = false;
        setChatState('connecting');

        if (peerConnectionRef.current) {
            answerCallSequence(callData.roomId, peerConnectionRef.current);
        } else {
            console.error("Callee: PeerConnection not available for answerCallSequence.");
            toast({ title: "WebRTC Error", description: "Connection component missing.", variant: "destructive" });
            handleEndCall(false);
        }
      }
    }, (error) => {
      console.error("Firebase onValue error for calls listener:", error);
      toast({title: "Connection Error", description: "Failed to listen for calls.", variant: "destructive"});
      handleEndCall(false);
    });
    firebaseListenersRef.current.push({ ref: currentUserCallRef, unsubscribe: callListener });


    setChatState('searching');
    const queueDbRef = ref(db, `queue`);
    let matchedPeerId: string | null = null;
    let newRoomIdForCaller: string | null = null;

    runTransaction(queueDbRef, (currentQueueData) => {
      if (chatStateRef.current !== 'searching') {
          console.log("Transaction aborted: Chat state no longer 'searching'. State:", chatStateRef.current);
        return; 
      }
      currentQueueData = currentQueueData || {};
      const availableUserIds = Object.keys(currentQueueData).filter(id => id !== userIdRef.current);

      if (availableUserIds.length > 0) {
        const peerToCall = availableUserIds.sort((a,b) => currentQueueData[a].timestamp - currentQueueData[b].timestamp)[0];
        console.log(`Transaction: User ${userIdRef.current} found peer ${peerToCall}.`);
        
        matchedPeerId = peerToCall; 
        newRoomIdForCaller = `${userIdRef.current}_${peerToCall}`;

        delete currentQueueData[peerToCall]; 
        if (currentQueueData[userIdRef.current!]) {
             delete currentQueueData[userIdRef.current!];
        }
        return currentQueueData;
      } else { 
        console.log(`Transaction: User ${userIdRef.current} joining queue.`);
        currentQueueData[userIdRef.current!] = { timestamp: serverTimestamp(), userId: userIdRef.current, name: currentUserProfile.name };
        return currentQueueData;
      }
    }).then(async (result) => {
      if (!result.committed) {
        console.warn("Queue transaction not committed. State:", chatStateRef.current);
        if(chatStateRef.current === 'searching') {
            setChatState('idle');
            toast({ title: "Matching Error", description: "Could not join queue. Try again.", variant: "destructive" });
        }
        return;
      }

      console.log("Queue transaction committed. User:", userIdRef.current, "Matched Peer:", matchedPeerId);

      if (matchedPeerId && newRoomIdForCaller) { 
        isCallerRef.current = true;
        peerIdRef.current = matchedPeerId;
        roomIdRef.current = newRoomIdForCaller;
        
        console.log(`User ${userIdRef.current} (Caller) matched with ${peerIdRef.current}. Room: ${roomIdRef.current}`);
        setChatState('connecting');

        try {
            await set(ref(db, `calls/${peerIdRef.current}`), { roomId: roomIdRef.current, role: 'callee', peerId: userIdRef.current });
            await set(ref(db, `calls/${userIdRef.current!}`), { roomId: roomIdRef.current, role: 'caller', peerId: peerIdRef.current });
            console.log("Caller: Firebase call roles set.");

            if (peerConnectionRef.current) {
                initiateCallSequence(roomIdRef.current, peerConnectionRef.current);
            } else {
                console.error("Caller: PeerConnection not available for initiateCallSequence.");
                toast({ title: "WebRTC Error", description: "Connection component missing.", variant: "destructive" });
                handleEndCall(false);
            }
        } catch (e) {
            console.error("Error setting up call roles or initiating call:", e);
            toast({ title: "Call Setup Error", description: "Failed to establish call signalling.", variant: "destructive" });
            handleEndCall(false);
        }
      } else { 
        console.log(`User ${userIdRef.current} added to queue, searching.`);
        toast({ title: "Searching...", description: "You're in the queue. Waiting for a peer." });
      }
    }).catch(error => {
      console.error("Queue transaction failed:", error);
      toast({ title: "Matching Error", description: "Error with matching queue. Try again.", variant: "destructive" });
      setChatState('idle');
      cleanupWebRTC();
    });
  };


  const handleFindNew = async () => {
    await handleEndCall(false);
    setTimeout(() => { 
        if (firebaseUser) handleStartChat();
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

  if (authLoading) {
    return (
      <MainLayout>
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-[250px]" />
          <Skeleton className="h-4 w-[200px]" />
        </div>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="text-center mb-4">
        <h1 className="text-4xl font-bold text-primary mb-2">BlindSpot Social</h1>
        <p className="text-lg text-foreground/80">Connect Anonymously. Reveal Meaningfully.</p>
      </div>

      {!firebaseUser ? (
        <div className="flex flex-col items-center gap-6 p-8 bg-card rounded-xl shadow-lg w-full max-w-md">
            <UserCircle className="w-16 h-16 text-accent" />
            <h2 className="text-2xl font-semibold text-foreground">Welcome!</h2>
            <p className="text-center text-muted-foreground max-w-sm">
                Sign in with Google to start connecting with others anonymously.
            </p>
            <Button onClick={signInWithGoogle} size="lg" className="w-full max-w-xs">
                <LogIn className="mr-2 h-5 w-5" />
                Sign in with Google
            </Button>
        </div>
      ) : chatState === 'idle' && currentUserProfile ? (
        <div className="flex flex-col items-center gap-6 p-8 bg-card rounded-xl shadow-lg w-full max-w-md">
          <div className='flex flex-row justify-between w-full items-center'>
            <Button onClick={handleOpenProfileModal} variant="ghost" size="sm" className="text-sm">
                <Edit3 className="mr-2 h-4 w-4" /> Edit Profile
            </Button>
            <Button onClick={signOut} variant="outline" size="sm">
                <LogOut className="mr-2 h-4 w-4" /> Sign Out
            </Button>
          </div>
          <UserProfileCard user={currentUserProfile} />
          <Zap className="w-12 h-12 text-accent mt-4" />
          <h2 className="text-2xl font-semibold text-foreground">Ready for a Spark, {currentUserProfile.name}?</h2>
          <p className="text-center text-muted-foreground max-w-sm">
            Dive into an anonymous video chat. If you click, you might just meet someone amazing.
          </p>
          <Button onClick={handleStartChat} size="lg" className="w-full max-w-xs">
            <MessageSquare className="mr-2 h-5 w-5" />
            Start Anonymous Chat
          </Button>
        </div>
      ) : null}

      {(chatState === 'searching' || chatState === 'connecting' || chatState === 'connected') && currentUserProfile && (
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
              reportedUser={null} // Matched user profile not yet available here for anonymous reporting
              triggerButtonText="Report Anonymous User"
              triggerButtonVariant="destructive"
              triggerButtonFullWidth={true}
            />
          </div>
        </div>
      )}

      {chatState === 'revealed' && currentUserProfile && (
        <div className="w-full flex flex-col items-center gap-8">
          <h2 className="text-3xl font-semibold text-primary">Profiles Revealed!</h2>
          <div className="grid md:grid-cols-2 gap-8 w-full">
            <UserProfileCard user={currentUserProfile} />
            <UserProfileCard user={mockMatchedUser} /> {/* Matched user is still mock */}
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
           <Button onClick={signOut} variant="outline" size="lg" className="mt-4">
                <LogOut className="mr-2 h-5 w-5" /> Sign Out
            </Button>
        </div>
      )}
      
      {firebaseUser && <QueuedUsersPanel queuedUserIds={queuedUserIds} />}

      {/* Profile Edit Modal */}
      <Dialog open={isProfileModalOpen} onOpenChange={setIsProfileModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Your Profile</DialogTitle>
            <DialogDescription>
              Make changes to your public profile information.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                value={editableProfile.name || ''}
                onChange={(e) => setEditableProfile(p => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="profile-bio">Bio</Label>
              <Textarea
                id="profile-bio"
                value={editableProfile.bio || ''}
                onChange={(e) => setEditableProfile(p => ({ ...p, bio: e.target.value }))}
                placeholder="Tell us a bit about yourself..."
                className="min-h-[100px]"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={handleSaveProfile}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </MainLayout>
  );
}
