
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
import { DebugLogPanel } from '@/components/features/debug/debug-log-panel'; // New import

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
  const [debugLogs, setDebugLogs] = useState<string[]>([]); // New state for debug logs

  const { toast } = useToast();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null); // ID of the user we are in a call with
  const isCallerRef = useRef<boolean>(false);
  const firebaseListeners = useRef<Map<string, { unsubscribe: Unsubscribe, path: string }>>(new Map());
  const chatStateRef = useRef<ChatState>(chatState);

  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const logEntry = `[${timestamp}] ${sessionUser?.id ? `[${sessionUser.id.substring(0,4)}] ` : '[N/A] '}${message}`;
    setDebugLogs(prevLogs => [...prevLogs, logEntry].slice(-100)); // Keep last 100 logs
  }, [sessionUser?.id]);


  useEffect(() => {
    chatStateRef.current = chatState;
    addDebugLog(`Chat state changed to: ${chatState}`);
  }, [chatState, addDebugLog]);

  useEffect(() => {
    const newSessionId = generateSessionId();
    setSessionId(newSessionId);
    addDebugLog(`Generated new session ID: ${newSessionId}`);
  }, [addDebugLog]); // addDebugLog added to dependencies

  useEffect(() => {
    if (sessionId) {
      const user: OnlineUser = {
        id: sessionId,
        name: `User-${sessionId.substring(0, 4)}`,
        photoUrl: `https://placehold.co/96x96.png?text=${sessionId.charAt(0).toUpperCase()}`,
      };
      setSessionUser(user);
      setLoading(false);
      addDebugLog(`Session user created: ${user.name} (${user.id})`);
    }
  }, [sessionId, addDebugLog]);

 const addFirebaseListener = useCallback((path: string, listenerFunc: any, eventType: string = 'value') => {
    if (firebaseListeners.current.has(path)) {
        addDebugLog(`Listener for path ${path} already exists. Removing old one.`);
        removeFirebaseListener(path);
    }
    const dbRef = ref(db, path);
    onValue(dbRef, listenerFunc, (error) => {
        addDebugLog(`ERROR reading from ${path}: ${error.message}`);
        toast({ title: "Firebase Error", description: `Failed to listen to ${path}. Check console.`, variant: "destructive" });
    });
    const unsubscribe = () => off(dbRef, eventType as any, listenerFunc); // Casting eventType for Firebase off function
    firebaseListeners.current.set(path, { unsubscribe, path });
    addDebugLog(`Added Firebase listener for path: ${path}`);
}, [addDebugLog, toast]); // addDebugLog added

const removeFirebaseListener = useCallback((path: string) => {
    const listenerEntry = firebaseListeners.current.get(path);
    if (listenerEntry) {
        try {
            listenerEntry.unsubscribe();
            addDebugLog(`Successfully removed Firebase listener for path: ${path}`);
        } catch (error) {
            addDebugLog(`WARN: Error unsubscribing Firebase listener for path ${path}: ${error}`);
        }
        firebaseListeners.current.delete(path);
    } else {
        addDebugLog(`WARN: No listener found for path ${path} to remove.`);
    }
}, [addDebugLog]);


  const cleanupAllFirebaseListeners = useCallback(() => {
    addDebugLog(`Cleaning up ALL (${firebaseListeners.current.size}) Firebase listeners.`);
    firebaseListeners.current.forEach((listenerEntry) => {
      try {
        listenerEntry.unsubscribe();
        addDebugLog(`Cleaned up listener for ${listenerEntry.path}`);
      } catch (error) {
        addDebugLog(`WARN: Error unsubscribing Firebase listener during general cleanup for path: ${listenerEntry.path} - ${error}`);
      }
    });
    firebaseListeners.current.clear();
  }, [addDebugLog]);

  const cleanupWebRTC = useCallback(() => {
    addDebugLog(`Cleaning up WebRTC resources.`);
    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.onsignalingstatechange = null;
      
      // Stop senders and remove tracks
      peerConnectionRef.current.getSenders().forEach(sender => {
        if (sender.track) {
          sender.track.stop();
        }
        // Try removing the sender if the track was successfully stopped or if there's no track
        // This check avoids errors if the track is already null or removed.
        if (peerConnectionRef.current && peerConnectionRef.current.signalingState !== 'closed') {
            try {
                peerConnectionRef.current.removeTrack(sender);
            } catch(e) {
                addDebugLog(`WARN: Error removing track from sender: ${e}`);
            }
        }
      });

      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
      addDebugLog(`Peer connection closed.`);
    } else {
      addDebugLog(`No active peer connection to cleanup.`);
    }

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
      addDebugLog(`Local stream stopped.`);
    }
    setRemoteStream(null); // Clear remote stream
  }, [localStream, addDebugLog]);


  const cleanupCallData = useCallback(async () => {
    const myId = sessionUser?.id;
    const currentRoomId = roomIdRef.current;
    const currentPeerId = peerIdRef.current;
    addDebugLog(`Cleaning up call data. MyID: ${myId}, Room: ${currentRoomId}, Peer: ${currentPeerId}`);

    if (currentRoomId) {
        remove(ref(db, `callSignals/${currentRoomId}/answer`)).catch(e => addDebugLog(`WARN: Error removing room answer: ${e}`));
        remove(ref(db, `callSignals/${currentRoomId}/offer`)).catch(e => addDebugLog(`WARN: Error removing room offer: ${e}`)); // Also clear offer for the room
        if (myId) remove(ref(db, `iceCandidates/${currentRoomId}/${myId}`)).catch(e => addDebugLog(`WARN: Error removing my ICE for room: ${e}`));
        if (currentPeerId) remove(ref(db, `iceCandidates/${currentRoomId}/${currentPeerId}`)).catch(e => addDebugLog(`WARN: Error removing peer ICE for room: ${e}`));
    }
    
    if (myId) {
      // Remove any pending offer directed TO me.
      remove(ref(db, `callSignals/${myId}/pendingOffer`)).catch(e => addDebugLog(`WARN: Error removing my pending offer: ${e}`));
    }

    if (isCallerRef.current && currentPeerId) {
        // If I was the caller, ensure the offer I sent to the peer is removed if the call didn't establish or was aborted.
        // The callee should remove this upon processing, but this is a fallback.
        remove(ref(db, `callSignals/${currentPeerId}/pendingOffer`)).catch(e => addDebugLog(`WARN: Caller: Error removing pending offer for peer ${currentPeerId}: ${e}`));
    }
     addDebugLog("Call data cleanup attempt finished.");

  }, [sessionUser?.id, addDebugLog]);


const handleEndCall = useCallback(async (showReveal = true) => {
    addDebugLog(`Handling end call. Show reveal: ${showReveal}. Current chat state: ${chatStateRef.current}`);
    const wasConnected = ['connected', 'connecting', 'dialing'].includes(chatStateRef.current);
    
    cleanupWebRTC(); // Stop streams, close peer connection
    
    // Specific listener cleanup related to the call
    if (roomIdRef.current) {
        removeFirebaseListener(`callSignals/${roomIdRef.current}/answer`);
        removeFirebaseListener(`callSignals/${roomIdRef.current}/offer`); // Also offer if we created a room-specific offer
        if (peerIdRef.current) removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${peerIdRef.current}`);
        if (sessionUser?.id) removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${sessionUser.id}`);
    }
    // Remove listener for pending offers TO ME, if it exists and wasn't cleaned by successful call setup
    if (sessionUser?.id) removeFirebaseListener(`callSignals/${sessionUser.id}/pendingOffer`);


    await cleanupCallData(); // Remove call-related data from Firebase

    if (showReveal && peerIdRef.current && wasConnected) {
        const peer = onlineUsers.find(u => u.id === peerIdRef.current) || 
                     (peerInfo?.id === peerIdRef.current ? peerInfo : null);
        setPeerInfo(peer);
        setChatState('revealed');
        addDebugLog(`Call ended. Transitioning to 'revealed' state with peer ${peer?.name || peerIdRef.current}.`);
    } else {
        setChatState('idle');
        setPeerInfo(null);
        addDebugLog(`Call ended. Transitioning to 'idle' state.`);
    }
    
    roomIdRef.current = null;
    // peerIdRef.current = null; // Keep for 'revealed', clear in handleBackToOnlineUsers
    isCallerRef.current = false;

  }, [cleanupWebRTC, cleanupCallData, sessionUser?.id, onlineUsers, peerInfo, removeFirebaseListener, addDebugLog]);


  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    if (!sessionUser?.id || !currentLocalStream) {
        addDebugLog(`ERROR: InitializePeerConnection: Missing sessionUser ID or local stream.`);
        return null;
    }
    addDebugLog(`Initializing RTCPeerConnection.`);
    const pc = new RTCPeerConnection(servers);

    // Add tracks from local stream
    currentLocalStream.getTracks().forEach(track => {
        try {
            pc.addTrack(track, currentLocalStream);
            addDebugLog(`Added local track: ${track.kind}`);
        } catch (e) {
            addDebugLog(`ERROR adding local track ${track.kind}: ${e}`);
        }
    });

    pc.ontrack = (event) => {
      addDebugLog(`Remote track received: Kind: ${event.track.kind}, ID: ${event.track.id}`);
      if (event.streams && event.streams[0]) {
        addDebugLog(`Attaching remote stream ${event.streams[0].id} directly.`);
        setRemoteStream(event.streams[0]);
      } else {
        // Fallback if event.streams[0] is not available (e.g. older browsers or specific scenarios)
        const newStream = new MediaStream();
        newStream.addTrack(event.track);
        addDebugLog(`Created new remote stream ${newStream.id} and added track ${event.track.id}.`);
        setRemoteStream(newStream);
      }
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate && roomIdRef.current && sessionUser?.id) {
            addDebugLog(`Generated ICE candidate: ${event.candidate.candidate.substring(0,30)}... for room ${roomIdRef.current}`);
            const candidatesRef = ref(db, `iceCandidates/${roomIdRef.current}/${sessionUser.id}`);
            push(candidatesRef, event.candidate.toJSON())
                .catch(e => addDebugLog(`ERROR pushing ICE candidate: ${e}`));
        } else if (!event.candidate) {
            addDebugLog("ICE gathering complete.");
        }
    };

    pc.oniceconnectionstatechange = () => {
      if (!pc) return;
      addDebugLog(`ICE connection state changed: ${pc.iceConnectionState}`);
      if (pc.iceConnectionState === 'connected') {
        if (['connecting', 'dialing'].includes(chatStateRef.current)) {
            setChatState('connected');
            addDebugLog("ICE connected. Chat state set to 'connected'.");
        }
      } else if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
          addDebugLog(`ICE state: ${pc.iceConnectionState}. Ending call.`);
          toast({ title: "Connection Issue", description: `Call state: ${pc.iceConnectionState}. Ending call.`, variant: "default" });
          handleEndCall(false); // Don't show reveal if connection failed
        }
      }
    };
    pc.onsignalingstatechange = () => {
        if (!pc) return;
        addDebugLog(`Signaling state changed: ${pc.signalingState}`);
    };
    return pc;
  }, [sessionUser?.id, handleEndCall, toast, addDebugLog]);

  const startLocalStream = useCallback(async (): Promise<MediaStream | null> => {
    addDebugLog(`Attempting to start local stream.`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setIsVideoOn(true);
      setIsMicOn(true);
      addDebugLog(`Local stream started successfully. Stream ID: ${stream.id}`);
      return stream;
    } catch (err) {
      addDebugLog(`ERROR accessing media devices: ${err}`);
      toast({ title: "Media Error", description: "Could not access camera/microphone. Please check permissions.", variant: "destructive" });
      setChatState('idle'); // Ensure state reset if media fails
      return null;
    }
  }, [toast, addDebugLog]);


  const initiateDirectCall = useCallback(async (targetUser: OnlineUser) => {
    if (!sessionUser || targetUser.id === sessionUser.id) {
      addDebugLog(`Cannot call self or sessionUser is null.`);
      toast({title: "Call Error", description: "Cannot call self.", variant: "destructive"});
      return;
    }
    addDebugLog(`Initiating direct call to ${targetUser.name} (${targetUser.id}).`);
    
    await handleEndCall(false); 

    const stream = await startLocalStream();
    if (!stream) {
        addDebugLog("Failed to start local stream for outgoing call.");
        return;
    }

    const pc = initializePeerConnection(stream);
    if (!pc) {
      addDebugLog("ERROR: Failed to initialize peer connection for outgoing call.");
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      cleanupWebRTC(); // Ensure stream is stopped if pc init fails
      return;
    }
    peerConnectionRef.current = pc;
    
    isCallerRef.current = true;
    peerIdRef.current = targetUser.id; // Set peerId for the user being called
    setPeerInfo(targetUser); // Set peer info for UI display
    
    // Create a unique room ID for this call. Both users will use this.
    const newRoomId = push(child(ref(db), 'callRooms')).key; 
    if (!newRoomId) {
        addDebugLog("ERROR: Could not create a call room ID.");
        toast({title: "Error", description: "Could not create a call room.", variant: "destructive"});
        await handleEndCall(false);
        return;
    }
    roomIdRef.current = newRoomId;
    addDebugLog(`Assigned new room ID: ${newRoomId} for call with ${targetUser.id}`);
    setChatState('dialing');

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      addDebugLog(`Offer created and local description set. Offer SDP: ${offer.sdp?.substring(0,50)}...`);

      const offerPayload: IncomingCallOffer = {
        roomId: newRoomId, // Caller creates the room and includes it in the offer
        offer: pc.localDescription!.toJSON(), // Send the full local description
        callerId: sessionUser.id,
        callerName: sessionUser.name,
        callerPhotoUrl: sessionUser.photoUrl || '',
      };
      const offerPath = `callSignals/${targetUser.id}/pendingOffer`; // Offer sent to targetUser's specific path
      await set(ref(db, offerPath), offerPayload);
      toast({ title: "Calling...", description: `Calling ${targetUser.name}...` });
      addDebugLog(`Offer sent to ${targetUser.id} at ${offerPath}. Room: ${newRoomId}`);

      // Listen for the answer in the specific room
      const answerPath = `callSignals/${newRoomId}/answer`;
      const answerListenerCallback = async (snapshot: any) => {
        if (snapshot.exists()) {
          const answerData = snapshot.val() as CallAnswer;
          addDebugLog(`Received answer from ${answerData.calleeId} for room ${newRoomId}. SDP: ${answerData.answer.sdp?.substring(0,50)}...`);
          if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') {
            if (pc.remoteDescription) {
                addDebugLog(`WARN: Remote description already set before processing this answer. Current signaling state: ${pc.signalingState}`);
            }
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(answerData.answer));
                addDebugLog(`Remote description (answer) set successfully.`);
            } catch (e) {
                addDebugLog(`ERROR setting remote description from answer: ${e}`);
                handleEndCall(false);
                return;
            }
            removeFirebaseListener(answerPath); 
            remove(ref(db, answerPath)).catch(e => addDebugLog(`WARN: Error removing answer from DB: ${e}`));
          } else {
            addDebugLog(`WARN: Received answer but PC signaling state is ${pc.signalingState}. Current remote desc: ${pc.remoteDescription}`);
          }
        }
      };
      addFirebaseListener(answerPath, answerListenerCallback);


      // Listen for ICE candidates from the callee in the specific room
      const calleeIcePath = `iceCandidates/${newRoomId}/${targetUser.id}`;
      const calleeIceCallback = (snapshot: any) => {
        snapshot.forEach((childSnapshot: any) => {
          const candidate = childSnapshot.val();
          if (candidate && pc.remoteDescription) { 
            addDebugLog(`Caller: Adding ICE candidate from callee ${targetUser.id}: ${candidate.candidate?.substring(0,30)}...`);
            pc.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => addDebugLog(`ERROR: Caller adding callee ICE candidate: ${e}`));
          } else if (candidate && !pc.remoteDescription) {
            addDebugLog(`WARN: Caller received callee ICE candidate but remote description not yet set.`);
          }
        });
      };
      addFirebaseListener(calleeIcePath, calleeIceCallback);

    } catch (error) {
      addDebugLog(`ERROR initiating call: ${error}`);
      toast({ title: "Call Error", description: "Could not initiate the call.", variant: "destructive" });
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, removeFirebaseListener, cleanupWebRTC, startLocalStream, addDebugLog]);


  const processIncomingOfferAndAnswer = useCallback(async (offerData: IncomingCallOffer) => {
    if (!sessionUser || chatStateRef.current !== 'idle') {
      addDebugLog(`processIncomingOfferAndAnswer called but state is ${chatStateRef.current} or no sessionUser. Offer from ${offerData.callerId}.`);
      if (sessionUser?.id) remove(ref(db, `callSignals/${sessionUser.id}/pendingOffer`)); // Clean up stale offer
      return;
    }
    addDebugLog(`Processing incoming offer from ${offerData.callerName} (${offerData.callerId}). Room: ${offerData.roomId}. Offer SDP: ${offerData.offer.sdp?.substring(0,50)}...`);

    setChatState('connecting');
    peerIdRef.current = offerData.callerId;
    roomIdRef.current = offerData.roomId; // Callee gets room ID from offer
    isCallerRef.current = false;
    
    const peer = onlineUsers.find(u => u.id === offerData.callerId) || 
                 {id: offerData.callerId, name: offerData.callerName, photoUrl: offerData.callerPhotoUrl};
    setPeerInfo(peer);
    toast({ title: "Incoming Call", description: `Connecting to ${offerData.callerName}...` });

    const stream = await startLocalStream();
    if (!stream) {
      addDebugLog("Callee: Failed to start local stream for incoming call.");
      await handleEndCall(false); // Pass false to avoid reveal state
      return;
    }
    addDebugLog(`Callee: Local stream started.`);

    const pc = initializePeerConnection(stream);
    if (!pc) {
      addDebugLog("Callee: ERROR: Failed to initialize peer connection.");
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      await handleEndCall(false);
      return;
    }
    peerConnectionRef.current = pc;
    addDebugLog(`Callee: Peer connection initialized.`);

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerData.offer));
      addDebugLog(`Callee: Remote description (offer) set successfully.`);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      addDebugLog(`Callee: Local description (answer) created and set. Answer SDP: ${answer.sdp?.substring(0,50)}...`);

      const answerPayload: CallAnswer = {
        answer: pc.localDescription!.toJSON(),
        calleeId: sessionUser.id,
      };
      const answerPath = `callSignals/${offerData.roomId}/answer`; // Answer sent to the room-specific path
      await set(ref(db, answerPath), answerPayload);
      addDebugLog(`Callee: Answer sent to room ${offerData.roomId} via ${answerPath}.`);
      
      const myOfferPath = `callSignals/${sessionUser.id}/pendingOffer`;
      await remove(ref(db, myOfferPath)); // Remove the processed pending offer for this user
      addDebugLog(`Callee: Removed processed pending offer from ${myOfferPath}.`);

      // Listen for ICE candidates from the caller in the specific room
      const callerIcePath = `iceCandidates/${offerData.roomId}/${offerData.callerId}`;
      const callerIceCallback = (snapshot: any) => {
        snapshot.forEach((childSnapshot: any) => {
          const candidate = childSnapshot.val();
          if (candidate && pc.remoteDescription) { 
             addDebugLog(`Callee: Adding ICE candidate from caller ${offerData.callerId}: ${candidate.candidate?.substring(0,30)}...`);
             pc.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => addDebugLog(`ERROR: Callee adding caller ICE candidate: ${e}`));
          } else if (candidate && !pc.remoteDescription) {
            addDebugLog(`WARN: Callee received caller ICE candidate but remote description not yet set.`);
          }
        });
      };
      addFirebaseListener(callerIcePath, callerIceCallback);
      addDebugLog(`Callee: Listening for ICE candidates from caller at ${callerIcePath}.`);

    } catch (error) {
      addDebugLog(`Callee: ERROR processing incoming offer: ${error}`);
      toast({ title: "Call Error", description: "Could not connect the call.", variant: "destructive" });
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, onlineUsers, toast, addFirebaseListener, startLocalStream, addDebugLog]);

  // Presence system and online users listener
  useEffect(() => {
    if (!sessionUser) return;
    addDebugLog(`Setting up presence system for ${sessionUser.id}.`);

    const userStatusRef = ref(db, `onlineUsers/${sessionUser.id}`);
    const connectedRef = ref(db, '.info/connected');

    const presenceConnectionCallback = (snapshot: any) => {
      if (snapshot.val() === true) {
        addDebugLog(`Connected to Firebase. Setting presence for ${sessionUser.id}.`);
        set(userStatusRef, sessionUser); // Set user online
        onDisconnect(userStatusRef).remove(); // Set up removal on disconnect
      } else {
        addDebugLog(`Disconnected from Firebase.`);
        // No need to explicitly set offline here, onDisconnect handles it.
      }
    };
    addFirebaseListener('.info/connected', presenceConnectionCallback);

    const onlineUsersRefPath = 'onlineUsers';
    const onlineUsersListenerCallback = (snapshot: any) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = usersData ? Object.values(usersData) : [];
      setOnlineUsers(userList.filter(u => u.id !== sessionUser.id)); 
      addDebugLog(`Online users updated: ${userList.filter(u => u.id !== sessionUser.id).length} other users.`);
    };
    addFirebaseListener(onlineUsersRefPath, onlineUsersListenerCallback);

    return () => {
      addDebugLog(`Cleaning up presence for session user effect: ${sessionUser?.id}`);
      removeFirebaseListener('.info/connected');
      removeFirebaseListener(onlineUsersRefPath);
      // Deliberately not removing userStatusRef here on component unmount for this specific effect,
      // as onDisconnect() should handle it. Window close/refresh is handled by onDisconnect.
      // Explicit removal happens on sign-out or full cleanup.
    };
  }, [sessionUser, addFirebaseListener, removeFirebaseListener, addDebugLog]);


  // Listener for incoming calls (now auto-accepted)
  useEffect(() => {
    if (!sessionUser?.id) {
      return;
    }
    const incomingCallPath = `callSignals/${sessionUser.id}/pendingOffer`;
    
    addDebugLog(`Attempting to attach incoming call listener at ${incomingCallPath}`);
    
    const incomingCallListenerCallback = async (snapshot: any) => {
      const offerData = snapshot.val() as IncomingCallOffer | null;
      addDebugLog(`Offer listener at ${incomingCallPath} triggered. Data exists: ${!!offerData}. Current chat state: ${chatStateRef.current}`);

      if (offerData && chatStateRef.current === 'idle') {
        addDebugLog(`Valid offer received from ${offerData.callerName}. Processing...`);
        await processIncomingOfferAndAnswer(offerData);
      } else if (offerData && chatStateRef.current !== 'idle') {
        addDebugLog(`WARN: Received offer from ${offerData.callerId} while in state ${chatStateRef.current}. Removing stale offer.`);
        remove(ref(db, incomingCallPath)).catch(e => addDebugLog(`WARN: Error removing stale offer: ${e}`));
      } else if (!offerData) {
          addDebugLog(`Offer listener at ${incomingCallPath} received null data (offer likely removed, declined, or processed).`);
      }
    };
    
    addFirebaseListener(incomingCallPath, incomingCallListenerCallback);
    addDebugLog(`Successfully attached incoming call listener at ${incomingCallPath}`);

    return () => {
        addDebugLog(`Cleaning up incoming call listener for path: ${incomingCallPath}`);
        removeFirebaseListener(incomingCallPath);
    };
  }, [sessionUser?.id, processIncomingOfferAndAnswer, toast, addFirebaseListener, removeFirebaseListener, addDebugLog]);


  // Cleanup effect when component unmounts (e.g. browser tab closed)
  useEffect(() => {
    const myId = sessionUser?.id; // Capture at effect setup
    return () => {
      addDebugLog(`HomePage unmounting for user ${myId || 'N/A'}. Performing full cleanup.`);
      cleanupWebRTC();
      cleanupAllFirebaseListeners(); // This includes presence, onlineUsers, and any active call listeners
      
      if (myId) {
        // This is a more forceful removal attempt, onDisconnect should be primary for tab close
        remove(ref(db, `onlineUsers/${myId}`)).catch(e => addDebugLog(`WARN: Error removing user from onlineUsers on unmount: ${e}`));
      }
      cleanupCallData(); // Final attempt to clean any call-specific data
      addDebugLog(`Full cleanup on unmount complete for ${myId || 'N/A'}.`);
    };
  }, [sessionUser?.id, cleanupWebRTC, cleanupAllFirebaseListeners, cleanupCallData, addDebugLog]); // sessionUser?.id ensures it re-runs if user changes (though not expected here)


  const handleBackToOnlineUsers = async () => {
    addDebugLog(`Handling back to online users from revealed state.`);
    await handleEndCall(false); // End call logic, don't show reveal again
    peerIdRef.current = null; // Clear peerId when going back to idle from revealed
    setPeerInfo(null);
  };

  const toggleMic = () => {
    if (localStream) {
      const audioEnabled = !isMicOn;
      localStream.getAudioTracks().forEach(track => track.enabled = audioEnabled);
      setIsMicOn(audioEnabled);
      addDebugLog(`Mic toggled to: ${audioEnabled ? 'ON' : 'OFF'}`);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const videoEnabled = !isVideoOn;
      localStream.getVideoTracks().forEach(track => track.enabled = videoEnabled);
      setIsVideoOn(videoEnabled);
      addDebugLog(`Video toggled to: ${videoEnabled ? 'ON' : 'OFF'}`);
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
      <div className="w-full max-w-2xl mt-8">
        <DebugLogPanel logs={debugLogs} />
      </div>
    </MainLayout>
  );
}
      
      
