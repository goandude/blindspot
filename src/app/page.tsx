
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { OnlineUser, IncomingCallOffer, CallAnswer } from '@/types';
import { PhoneOff, Video as VideoIcon } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, push, child, Unsubscribe, onDisconnect } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { OnlineUsersPanel } from '@/components/features/online-users/online-users-panel';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '@/components/ui/card';

type ChatState = 'idle' | 'dialing' | 'connecting' | 'connected' | 'revealed';

const servers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

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
  const [peerInfo, setPeerInfo] = useState<OnlineUser | null>(null);
  const [loading, setLoading] = useState(true);

  const { toast } = useToast();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);
  const firebaseListeners = useRef<Map<string, Unsubscribe>>(new Map());
  const chatStateRef = useRef<ChatState>(chatState);

  useEffect(() => {
    chatStateRef.current = chatState;
    console.log(`[${sessionUser?.id || 'N/A'}] Chat state changed to: ${chatState}`);
  }, [chatState, sessionUser?.id]);

  useEffect(() => {
    const newSessionId = generateSessionId();
    setSessionId(newSessionId);
    console.log("Generated new session ID:", newSessionId);
  }, []);

  useEffect(() => {
    if (sessionId) {
      const user: OnlineUser = {
        id: sessionId,
        name: `User-${sessionId.substring(0, 4)}`,
        photoUrl: `https://placehold.co/96x96.png?text=${sessionId.charAt(0).toUpperCase()}`,
      };
      setSessionUser(user);
      setLoading(false);
      console.log("Session user created:", user);
    }
  }, [sessionId]);

  const addFirebaseListener = useCallback((path: string, callback: Unsubscribe) => {
    // Remove any existing listener for this path before adding a new one
    const existingListener = firebaseListeners.current.get(path);
    if (existingListener) {
      console.log(`[${sessionUser?.id || 'N/A'}] Removing existing listener for path: ${path}`);
      try {
        existingListener(); // This should be the off() function itself or similar
      } catch (e) {
        console.warn(`[${sessionUser?.id || 'N/A'}] Error trying to execute stored off() for ${path}`, e);
      }
      // More directly: if the Unsubscribe is `off(ref(db, path), listenerFunc)`
      // we need to ensure the listenerFunc is the one actually passed to off.
      // Simpler approach: store the listener function and call off(ref, func)
      // For now, assuming Unsubscribe is the complete detachment function.
    }
    firebaseListeners.current.set(path, callback);
    console.log(`[${sessionUser?.id || 'N/A'}] Added Firebase listener for path: ${path}`);
  }, [sessionUser?.id]);
  
  const removeFirebaseListener = useCallback((path: string) => {
    const unsubscribe = firebaseListeners.current.get(path);
    if (unsubscribe) {
      try {
        unsubscribe(); // Call the stored unsubscribe function
        console.log(`[${sessionUser?.id || 'N/A'}] Removed Firebase listener for path: ${path}`);
      } catch (error) {
        console.warn(`[${sessionUser?.id || 'N/A'}] Error unsubscribing Firebase listener for path: ${path}`, error);
      }
      firebaseListeners.current.delete(path);
    }
  }, [sessionUser?.id]);

  const cleanupAllFirebaseListeners = useCallback(() => {
    console.log(`[${sessionUser?.id || 'N/A'}] Cleaning up all Firebase listeners.`);
    firebaseListeners.current.forEach((unsubscribe, path) => {
      try {
        unsubscribe();
      } catch (error) {
        console.warn(`[${sessionUser?.id || 'N/A'}] Error unsubscribing Firebase listener during general cleanup for path: ${path}`, error);
      }
    });
    firebaseListeners.current.clear();
  }, [sessionUser?.id]);

  const cleanupWebRTC = useCallback(() => {
    console.log(`[${sessionUser?.id || 'N/A'}] Cleaning up WebRTC resources.`);
    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.onsignalingstatechange = null;
      localStream?.getTracks().forEach(track => {
        peerConnectionRef.current?.getSenders().forEach(sender => {
          if (sender.track === track) {
            try {
              peerConnectionRef.current?.removeTrack(sender);
            } catch (e) { console.warn("Error removing track:", e); }
          }
        });
      });
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    setRemoteStream(null);
  }, [localStream, sessionUser?.id]);

  const cleanupCallData = useCallback(async () => {
    console.log(`[${sessionUser?.id || 'N/A'}] Cleaning up call data. Room: ${roomIdRef.current}, Peer: ${peerIdRef.current}`);
    const currentRoomId = roomIdRef.current;
    const currentPeerId = peerIdRef.current; // The ID of the other user in the call
    const myId = sessionUser?.id;

    if (currentRoomId) {
      // Specific paths to clean up
      remove(ref(db, `callSignals/${currentRoomId}/answer`)).catch(e => console.warn("Error removing room answer:", e));
      remove(ref(db, `iceCandidates/${currentRoomId}/${myId}`)).catch(e => console.warn("Error removing my ICE candidates for room:", e));
      if (currentPeerId) {
         remove(ref(db, `iceCandidates/${currentRoomId}/${currentPeerId}`)).catch(e => console.warn("Error removing peer ICE candidates for room:", e));
      }
    }
    
    // Remove pending offer for self, if any (e.g., if call was declined or aborted before full setup)
    if (myId) {
      remove(ref(db, `callSignals/${myId}/pendingOffer`)).catch(e => console.warn("Error removing my pending offer:", e));
    }

    // If this user was the caller and an offer was sent to a specific peer, ensure it's cleaned up
    // This is more complex if the call was never established or the room ID wasn't set for the callee.
    // The pendingOffer should ideally be removed by the callee upon processing or by the caller if they cancel.
    // For now, the callee removes it upon processing. The caller might remove it in handleEndCall if dialing is interrupted.
    if (isCallerRef.current && currentPeerId) {
        remove(ref(db, `callSignals/${currentPeerId}/pendingOffer`)).catch(e => console.warn("Caller: Error removing pending offer for peer:", e));
    }


  }, [sessionUser?.id]);

  const handleEndCall = useCallback(async (showReveal = true) => {
    console.log(`[${sessionUser?.id || 'N/A'}] Handling end call. Show reveal: ${showReveal}. Current chat state: ${chatStateRef.current}`);
    const wasConnected = ['connected', 'connecting', 'dialing'].includes(chatStateRef.current);
    
    cleanupWebRTC();
    
    if (roomIdRef.current && sessionUser?.id) {
        removeFirebaseListener(`callSignals/${roomIdRef.current}/answer`);
        removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${peerIdRef.current}`);
        removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${sessionUser.id}`);
    }
    
    await cleanupCallData();

    if (showReveal && peerIdRef.current && wasConnected) {
        const peer = onlineUsers.find(u => u.id === peerIdRef.current) || 
                     (peerInfo?.id === peerIdRef.current ? peerInfo : null); // Use existing peerInfo if available
        setPeerInfo(peer); // This might be null if peer left onlineUsers
        setChatState('revealed');
    } else {
        setChatState('idle');
        setPeerInfo(null);
    }
    
    roomIdRef.current = null;
    // peerIdRef.current = null; // Keep peerIdRef for 'revealed' state, clear it when going back to idle from revealed
    isCallerRef.current = false;

  }, [cleanupWebRTC, cleanupCallData, sessionUser?.id, onlineUsers, peerInfo, removeFirebaseListener]);


  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    if (!sessionUser?.id || !currentLocalStream) {
        console.error(`[${sessionUser?.id || 'N/A'}] InitializePeerConnection: Missing sessionUser ID or local stream.`);
        return null;
    }
    console.log(`[${sessionUser.id}] Initializing RTCPeerConnection.`);
    const pc = new RTCPeerConnection(servers);
    currentLocalStream.getTracks().forEach(track => pc.addTrack(track, currentLocalStream));

    pc.ontrack = (event) => {
      console.log(`[${sessionUser.id}] Remote track received:`, event.track);
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      } else {
        const newStream = new MediaStream();
        newStream.addTrack(event.track);
        setRemoteStream(newStream);
      }
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate && roomIdRef.current && sessionUser?.id) {
            console.log(`[${sessionUser.id}] Generated ICE candidate:`, event.candidate, `for room ${roomIdRef.current}`);
            const candidatesRef = ref(db, `iceCandidates/${roomIdRef.current}/${sessionUser.id}`);
            push(candidatesRef, event.candidate.toJSON());
        }
    };

    pc.oniceconnectionstatechange = () => {
      if (!pc) return;
      console.log(`[${sessionUser.id}] ICE connection state changed: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected') {
        if (['connecting', 'dialing'].includes(chatStateRef.current)) {
            setChatState('connected');
        }
      } else if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
          toast({ title: "Connection Issue", description: `Call state: ${pc.iceConnectionState}. Ending call.`, variant: "default" });
          handleEndCall(false);
        }
      }
    };
    pc.onsignalingstatechange = () => {
        if (!pc) return;
        console.log(`[${sessionUser.id}] Signaling state changed: ${pc.signalingState}`);
    };
    return pc;
  }, [sessionUser?.id, handleEndCall, toast]);

  const startLocalStream = useCallback(async (): Promise<MediaStream | null> => {
    console.log(`[${sessionUser?.id || 'N/A'}] Attempting to start local stream.`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setIsVideoOn(true);
      setIsMicOn(true);
      console.log(`[${sessionUser?.id || 'N/A'}] Local stream started successfully.`);
      return stream;
    } catch (err) {
      console.error(`[${sessionUser?.id || 'N/A'}] Error accessing media devices:`, err);
      toast({ title: "Media Error", description: "Could not access camera/microphone. Please check permissions.", variant: "destructive" });
      setChatState('idle');
      return null;
    }
  }, [toast, sessionUser?.id]);


  const initiateDirectCall = useCallback(async (targetUser: OnlineUser) => {
    if (!sessionUser || targetUser.id === sessionUser.id) {
      toast({title: "Cannot call self", variant: "destructive"});
      return;
    }
    console.log(`[${sessionUser.id}] Initiating direct call to ${targetUser.name} (${targetUser.id}).`);
    
    await handleEndCall(false); // Clean up any previous call state first

    const stream = await startLocalStream();
    if (!stream) return;

    const pc = initializePeerConnection(stream);
    if (!pc) {
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      cleanupWebRTC(); // Ensure stream is stopped if pc init fails
      return;
    }
    peerConnectionRef.current = pc;
    
    isCallerRef.current = true;
    peerIdRef.current = targetUser.id;
    setPeerInfo(targetUser);
    const newRoomId = push(child(ref(db), 'callRooms')).key; // Using a different root for rooms
    if (!newRoomId) {
        toast({title: "Error", description: "Could not create a call room.", variant: "destructive"});
        return;
    }
    roomIdRef.current = newRoomId;
    setChatState('dialing');
    console.log(`[${sessionUser.id}] Assigned new room ID: ${newRoomId} for call with ${targetUser.id}`);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(`[${sessionUser.id}] Offer created and local description set.`);

      const offerPayload: IncomingCallOffer = {
        roomId: newRoomId,
        offer,
        callerId: sessionUser.id,
        callerName: sessionUser.name,
        callerPhotoUrl: sessionUser.photoUrl || '',
      };
      const offerPath = `callSignals/${targetUser.id}/pendingOffer`;
      await set(ref(db, offerPath), offerPayload);
      toast({ title: "Calling...", description: `Calling ${targetUser.name}...` });
      console.log(`[${sessionUser.id}] Offer sent to ${targetUser.id} at ${offerPath}. Room: ${newRoomId}`);

      const answerPath = `callSignals/${newRoomId}/answer`;
      const answerListenerCallback = onValue(ref(db, answerPath), async (snapshot) => {
        if (snapshot.exists()) {
          const { answer: answerSdp } = snapshot.val() as CallAnswer;
          console.log(`[${sessionUser.id}] Received answer from ${targetUser.id} for room ${newRoomId}.`);
          if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') { // Or check if remoteDescription is already set
             if (pc.remoteDescription) {
                console.warn(`[${sessionUser.id}] Remote description already set before receiving answer. Current signaling state: ${pc.signalingState}`);
             }
            await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
            console.log(`[${sessionUser.id}] Remote description (answer) set.`);
            removeFirebaseListener(answerPath); // Clean up this specific listener
            remove(ref(db, answerPath)).catch(e => console.warn("Error removing answer from DB:", e)); // Clean up answer from DB
          } else {
            console.warn(`[${sessionUser.id}] Received answer but PC signaling state is ${pc.signalingState}. Offer not yet set?`);
          }
        }
      }, (error) => {
        console.error(`[${sessionUser.id}] Firebase error on answer listener for ${answerPath}:`, error);
      });
      addFirebaseListener(answerPath, () => off(ref(db, answerPath), answerListenerCallback));


      const calleeIcePath = `iceCandidates/${newRoomId}/${targetUser.id}`;
      const calleeIceCallback = onValue(ref(db, calleeIcePath), (snapshot) => {
        snapshot.forEach((childSnapshot) => {
          const candidate = childSnapshot.val();
          if (candidate && pc.remoteDescription) { 
            console.log(`[${sessionUser.id}] Adding ICE candidate from callee ${targetUser.id}:`, candidate);
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding callee ICE candidate:", e));
          }
        });
      });
      addFirebaseListener(calleeIcePath, () => off(ref(db, calleeIcePath), calleeIceCallback));

    } catch (error) {
      console.error(`[${sessionUser.id}] Error initiating call:`, error);
      toast({ title: "Call Error", description: "Could not initiate the call.", variant: "destructive" });
      handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, removeFirebaseListener, cleanupWebRTC, startLocalStream]);


  const processIncomingOfferAndAnswer = useCallback(async (offerData: IncomingCallOffer) => {
    if (!sessionUser || chatStateRef.current !== 'idle') {
      console.warn(`[${sessionUser?.id}] processIncomingOfferAndAnswer called but state is ${chatStateRef.current} or no sessionUser.`);
      // If an offer is being processed, but we are not idle, we should remove the offer to avoid conflicts
      if (sessionUser?.id) remove(ref(db, `callSignals/${sessionUser.id}/pendingOffer`));
      return;
    }
    console.log(`[${sessionUser.id}] processIncomingOfferAndAnswer: Starting for offer from ${offerData.callerId}`);

    setChatState('connecting');
    peerIdRef.current = offerData.callerId;
    roomIdRef.current = offerData.roomId;
    isCallerRef.current = false;
    
    const peer = onlineUsers.find(u => u.id === offerData.callerId) || 
                 {id: offerData.callerId, name: offerData.callerName, photoUrl: offerData.callerPhotoUrl};
    setPeerInfo(peer);

    const stream = await startLocalStream();
    if (!stream) {
      toast({ title: "Media Error", description: "Could not access camera/microphone.", variant: "destructive" });
      await handleEndCall(false);
      return;
    }
    console.log(`[${sessionUser.id}] Callee: Local stream started.`);

    const pc = initializePeerConnection(stream);
    if (!pc) {
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      await handleEndCall(false);
      return;
    }
    peerConnectionRef.current = pc;
    console.log(`[${sessionUser.id}] Callee: Peer connection initialized.`);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerData.offer));
      console.log(`[${sessionUser.id}] Callee: Remote description (offer) set.`);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log(`[${sessionUser.id}] Callee: Local description (answer) created and set.`);

      const answerPayload: CallAnswer = {
        answer,
        calleeId: sessionUser.id,
      };
      const answerPath = `callSignals/${offerData.roomId}/answer`;
      await set(ref(db, answerPath), answerPayload);
      console.log(`[${sessionUser.id}] Callee: Answer sent to room ${offerData.roomId} via ${answerPath}.`);
      
      // Remove the processed pending offer for this user
      const myOfferPath = `callSignals/${sessionUser.id}/pendingOffer`;
      await remove(ref(db, myOfferPath));
      console.log(`[${sessionUser.id}] Callee: Removed pending offer from ${myOfferPath}.`);

      const callerIcePath = `iceCandidates/${offerData.roomId}/${offerData.callerId}`;
      const callerIceCallback = onValue(ref(db, callerIcePath), (snapshot) => {
        snapshot.forEach((childSnapshot) => {
          const candidate = childSnapshot.val();
          if (candidate && pc.remoteDescription) { 
             console.log(`[${sessionUser.id}] Callee: Adding ICE candidate from caller ${offerData.callerId}:`, candidate);
             pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding caller ICE candidate:", e));
          }
        });
      });
      addFirebaseListener(callerIcePath, () => off(ref(db, callerIcePath), callerIceCallback));
      console.log(`[${sessionUser.id}] Callee: Listening for ICE candidates from caller at ${callerIcePath}.`);

    } catch (error) {
      console.error(`[${sessionUser.id}] Callee: Error processing incoming offer:`, error);
      toast({ title: "Call Error", description: "Could not connect the call.", variant: "destructive" });
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, onlineUsers, toast, addFirebaseListener, startLocalStream]);

  // Presence system and online users listener
  useEffect(() => {
    if (!sessionUser) return;
    console.log(`[${sessionUser.id}] Setting up presence system.`);

    const userStatusRef = ref(db, `onlineUsers/${sessionUser.id}`);
    const connectedRef = ref(db, '.info/connected');

    const presenceConnection = onValue(connectedRef, (snapshot) => {
      if (snapshot.val() === true) {
        console.log(`[${sessionUser.id}] Connected to Firebase. Setting presence.`);
        set(userStatusRef, sessionUser);
        onDisconnect(userStatusRef).remove();
      } else {
        console.log(`[${sessionUser.id}] Disconnected from Firebase.`);
      }
    });
    addFirebaseListener('.info/connected', () => off(connectedRef, presenceConnection));


    const onlineUsersRefPath = 'onlineUsers';
    const onlineUsersListenerCallback = onValue(ref(db, onlineUsersRefPath), (snapshot) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = usersData ? Object.values(usersData) : [];
      setOnlineUsers(userList.filter(u => u.id !== sessionUser.id)); 
      console.log(`[${sessionUser.id}] Online users updated:`, userList.filter(u => u.id !== sessionUser.id).map(u=>u.name));
    }, (error) => {
        console.error(`[${sessionUser.id}] Firebase error on online users listener:`, error);
    });
    addFirebaseListener(onlineUsersRefPath, () => off(ref(db, onlineUsersRefPath), onlineUsersListenerCallback));


    return () => {
      console.log(`[${sessionUser.id}] Cleaning up presence for session user effect.`);
      removeFirebaseListener('.info/connected');
      removeFirebaseListener(onlineUsersRefPath);
      // remove(userStatusRef).catch(err => console.warn("Error removing user status on effect unmount:", err));
      // onDisconnect().cancel() might be needed if set previously without storing the handler
    };
  }, [sessionUser, addFirebaseListener, removeFirebaseListener]);


  // Listener for incoming calls (now auto-accepted)
  useEffect(() => {
    if (!sessionUser?.id) {
      // console.log("No sessionUser.id, not setting up incoming call listener.");
      return;
    }

    const incomingCallPath = `callSignals/${sessionUser.id}/pendingOffer`;
    let listenerFunction: Unsubscribe | null = null; // To store the actual listener function

    const setupListener = () => {
      removeFirebaseListener(incomingCallPath); // Clean up previous one for this path just in case

      console.log(`[${sessionUser.id}] Attempting to attach incoming call listener at ${incomingCallPath}`);
      
      listenerFunction = onValue(ref(db, incomingCallPath), async (snapshot) => {
        const offerData = snapshot.val() as IncomingCallOffer | null;
        console.log(`[${sessionUser.id}] Offer listener at ${incomingCallPath} triggered. Data:`, offerData, `Current chat state: ${chatStateRef.current}`);

        if (offerData && chatStateRef.current === 'idle') {
          toast({ title: "Call Received", description: `Connecting to ${offerData.callerName}...` });
          console.log(`[${sessionUser.id}] Processing offer from ${offerData.callerId}, roomId: ${offerData.roomId}`);
          await processIncomingOfferAndAnswer(offerData);
        } else if (offerData && chatStateRef.current !== 'idle') {
          console.warn(`[${sessionUser.id}] Received offer from ${offerData.callerId} while in state ${chatStateRef.current}. Removing stale offer.`);
          remove(ref(db, incomingCallPath)).catch(e => console.warn("Error removing stale offer:", e));
        } else if (!offerData) {
            // console.log(`[${sessionUser.id}] Offer listener at ${incomingCallPath} received null data (offer likely removed or declined).`);
        }
      }, (error) => {
        console.error(`[${sessionUser.id}] Firebase error on incoming call listener for ${incomingCallPath}:`, error);
        toast({title: "Listener Error", description: "Could not listen for incoming calls.", variant: "destructive"});
      });
      
      // The Unsubscribe function for onValue is `() => off(ref(db, path), listenerFunction)`
      // So we store this complete unsubscribe action.
      addFirebaseListener(incomingCallPath, () => {
        if (listenerFunction) { // Ensure listenerFunction was set
             off(ref(db, incomingCallPath), listenerFunction);
        }
      });
      console.log(`[${sessionUser.id}] Successfully attached incoming call listener at ${incomingCallPath}`);
    };

    setupListener();

    // The return function from useEffect will use the `removeFirebaseListener` which calls the stored unsubscribe.
    return () => {
        removeFirebaseListener(incomingCallPath);
    };
  }, [sessionUser?.id, processIncomingOfferAndAnswer, toast, addFirebaseListener, removeFirebaseListener]);


  // Cleanup effect when component unmounts
  useEffect(() => {
    return () => {
      console.log(`[${sessionUser?.id || 'N/A'}] HomePage unmounting. Performing full cleanup.`);
      cleanupWebRTC();
      cleanupAllFirebaseListeners();
      if (sessionUser?.id) {
        // Attempt to remove presence synchronously if possible, though onDisconnect should handle it.
        remove(ref(db, `onlineUsers/${sessionUser.id}`)).catch(e => console.warn("Error removing user from onlineUsers on unmount:", e));
      }
      cleanupCallData(); 
    };
  }, [cleanupWebRTC, cleanupAllFirebaseListeners, cleanupCallData, sessionUser?.id]);


  const handleBackToOnlineUsers = async () => {
    console.log(`[${sessionUser?.id || 'N/A'}] Handling back to online users from revealed state.`);
    await handleEndCall(false); 
    peerIdRef.current = null; // Clear peerId when going back to idle from revealed
    setPeerInfo(null);
  };

  const toggleMic = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => track.enabled = !isMicOn);
      setIsMicOn(!isMicOn);
      console.log(`[${sessionUser?.id || 'N/A'}] Mic toggled to: ${!isMicOn ? 'ON' : 'OFF'}`);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => track.enabled = !isVideoOn);
      setIsVideoOn(!isVideoOn);
      console.log(`[${sessionUser?.id || 'N/A'}] Video toggled to: ${!isVideoOn ? 'ON' : 'OFF'}`);
    }
  };

  if (loading || !sessionUser) {
    return (
      <MainLayout>
        <div className="flex flex-col items-center gap-4 p-8 bg-card rounded-xl shadow-lg w-full max-w-lg">
          <Skeleton className="h-20 w-20 rounded-full" />
          <Skeleton className="h-6 w-[280px] mt-3" />
          <Skeleton className="h-4 w-[200px] mt-1" />
          <p className="mt-4 text-muted-foreground">Initializing your anonymous session...</p>
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
        <div className="flex flex-col items-center gap-6 p-6 bg-card rounded-xl shadow-xl w-full max-w-lg">
           <Card className="w-full max-w-md shadow-md border-primary/50">
            <CardHeader className="items-center text-center pb-4">
                <Avatar className="w-20 h-20 mb-3 border-2 border-primary shadow-sm">
                    <AvatarImage src={sessionUser.photoUrl} alt={sessionUser.name} data-ai-hint="avatar abstract" />
                    <AvatarFallback>{sessionUser.name.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <CardTitle className="text-xl">{sessionUser.name}</CardTitle>
                <CardDescription className="text-sm text-muted-foreground">Your current session ID: {sessionUser.id}</CardDescription>
            </CardHeader>
          </Card>
          <div className="w-full mt-4">
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
            peerName={peerInfo?.name || (chatState === 'dialing' ? 'Dialing...' : (chatState === 'connecting' ? 'Connecting...' : 'Peer'))}
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
        <div className="w-full flex flex-col items-center gap-8 p-6 bg-card rounded-xl shadow-xl max-w-lg">
          <h2 className="text-3xl font-semibold text-primary">Call Ended</h2>
          {peerInfo ? (
            <>
              <p className="text-muted-foreground">You chatted with {peerInfo.name}.</p>
              <Card className="w-full max-w-sm p-6 bg-background shadow-lg rounded-xl border-primary/50">
                <div className="flex flex-col items-center text-center">
                    <Avatar className="w-24 h-24 mb-4 border-2 border-primary shadow-md">
                        <AvatarImage src={peerInfo.photoUrl} alt={peerInfo.name} data-ai-hint="avatar abstract"/>
                        <AvatarFallback>{peerInfo.name.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <h3 className="text-2xl font-semibold">{peerInfo.name}</h3>
                    <p className="text-sm text-muted-foreground">ID: {peerInfo.id}</p>
                </div>
              </Card>
            </>
          ) : (
            <p className="text-muted-foreground">The other user's information could not be loaded or they disconnected.</p>
          )}
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mt-4">
            <Button onClick={handleBackToOnlineUsers} size="lg" variant="secondary" className="flex-1">
              <VideoIcon className="mr-2 h-5 w-5" />
              Back to Online Users
            </Button>
            {peerInfo && ( // Only show report if peerInfo is available
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
    </MainLayout>
  );
}
      
      
