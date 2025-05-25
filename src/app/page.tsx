
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { OnlineUser, IncomingCallOffer, CallAnswer } from '@/types';
import { PhoneOff, Video as VideoIcon } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, push, child, Unsubscribe, onDisconnect, serverTimestamp } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { OnlineUsersPanel } from '@/components/features/online-users/online-users-panel';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { DebugLogPanel } from '@/components/features/debug/debug-log-panel';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';


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
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const { toast } = useToast();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);
  
  const firebaseListeners = useRef<Map<string, { unsubscribe: () => void, path: string }>>(new Map());
  
  const chatStateRef = useRef<ChatState>(chatState);
  const sessionIdRef = useRef<string | null>(null);
  const sessionUserIdRef = useRef<string | null>(null);


  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    sessionUserIdRef.current = sessionUser?.id || null;
  }, [sessionUser?.id]);

  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const currentSId = sessionIdRef.current; // Read from ref
    const currentUserId = sessionUserIdRef.current; // Read from ref
    
    let prefix = '[N/A] ';
    if (currentUserId) {
      prefix = `[${currentUserId.substring(0,4)}] `;
    } else if (currentSId) {
      prefix = `[${currentSId.substring(0,4)}] `;
    }
    
    const logEntry = `[${timestamp}] ${prefix}${message}`;
    setDebugLogs(prevLogs => [...prevLogs, logEntry].slice(-100)); // Keep last 100 logs
  }, []); // Empty dependency array makes addDebugLog stable

  useEffect(() => {
    chatStateRef.current = chatState;
    addDebugLog(`Chat state changed to: ${chatState}`);
  }, [chatState, addDebugLog]);

  useEffect(() => {
    // Runs only once on mount
    const newSessionId = generateSessionId();
    setSessionId(newSessionId);
  }, []);

  useEffect(() => {
    if (sessionId) {
      addDebugLog(`Generated new session ID: ${sessionId}`);
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


 const addFirebaseListener = useCallback((path: string, listenerFunc: (snapshot: any) => void, eventType: string = 'value') => {
    if (firebaseListeners.current.has(path)) {
        addDebugLog(`Listener for path ${path} already exists. Removing old one first.`);
        removeFirebaseListener(path);
    }
    const dbRef = ref(db, path);
    const internalCallback = (snapshot: any) => {
        listenerFunc(snapshot);
    };
    onValue(dbRef, internalCallback, (error) => {
        addDebugLog(`ERROR reading from ${path}: ${error.message}`);
        toast({ title: "Firebase Error", description: `Failed to listen to ${path}. Check console.`, variant: "destructive" });
    });
    // Store the function that will actually perform the unsubscribe
    const unsubscribe = () => off(dbRef, eventType as any, internalCallback);
    firebaseListeners.current.set(path, { unsubscribe, path });
    addDebugLog(`Added Firebase listener for path: ${path} with eventType: ${eventType}`);
  }, [addDebugLog, toast]); // toast is stable, addDebugLog is now stable

  const removeFirebaseListener = useCallback((path: string) => {
    const listenerEntry = firebaseListeners.current.get(path);
    if (listenerEntry) {
        try {
            listenerEntry.unsubscribe(); // Call the stored unsubscribe function
            addDebugLog(`Successfully removed Firebase listener for path: ${path}`);
        } catch (error: any) {
            addDebugLog(`WARN: Error unsubscribing Firebase listener for path ${path}: ${error.message || error}`);
        }
        firebaseListeners.current.delete(path);
    } else {
        addDebugLog(`WARN: No listener found for path ${path} to remove.`);
    }
  }, [addDebugLog]);


  const cleanupAllFirebaseListeners = useCallback(() => {
    addDebugLog(`Cleaning up ALL (${firebaseListeners.current.size}) Firebase listeners.`);
    firebaseListeners.current.forEach((listenerEntry, path) => {
      try {
        listenerEntry.unsubscribe();
        addDebugLog(`Cleaned up listener for ${listenerEntry.path}`);
      } catch (error: any) {
        addDebugLog(`WARN: Error unsubscribing Firebase listener during general cleanup for path: ${listenerEntry.path} - ${error.message || error}`);
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
      
      peerConnectionRef.current.getSenders().forEach(sender => {
        if (sender.track) {
          sender.track.stop();
        }
        if (peerConnectionRef.current && peerConnectionRef.current.signalingState !== 'closed') {
            try {
                peerConnectionRef.current.removeTrack(sender);
            } catch(e: any) {
                addDebugLog(`WARN: Error removing track from sender: ${e.message || e}`);
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
    setRemoteStream(null);
  }, [localStream, addDebugLog]);


  const cleanupCallData = useCallback(async () => {
    const myId = sessionUser?.id;
    const currentRoomId = roomIdRef.current;
    const currentPeerId = peerIdRef.current;
    addDebugLog(`Cleaning up call data. MyID: ${myId}, Room: ${currentRoomId}, Peer: ${currentPeerId}`);

    if (currentRoomId) {
        remove(ref(db, `callSignals/${currentRoomId}`)).catch(e => addDebugLog(`WARN: Error removing room signals for ${currentRoomId}: ${e}`));
        if (myId) remove(ref(db, `iceCandidates/${currentRoomId}/${myId}`)).catch(e => addDebugLog(`WARN: Error removing my ICE for room: ${e}`));
        if (currentPeerId) remove(ref(db, `iceCandidates/${currentRoomId}/${currentPeerId}`)).catch(e => addDebugLog(`WARN: Error removing peer ICE for room: ${e}`));
    }
    
    if (myId) {
      remove(ref(db, `callSignals/${myId}/pendingOffer`)).catch(e => addDebugLog(`WARN: Error removing my pending offer: ${e}`));
    }

    if (isCallerRef.current && currentPeerId) {
        remove(ref(db, `callSignals/${currentPeerId}/pendingOffer`)).catch(e => addDebugLog(`WARN: Caller: Error removing pending offer for peer ${currentPeerId}: ${e}`));
    }
     addDebugLog("Call data cleanup attempt finished.");

  }, [sessionUser?.id, addDebugLog]);


const handleEndCall = useCallback(async (showReveal = true) => {
    addDebugLog(`Handling end call. Show reveal: ${showReveal}. Current chat state: ${chatStateRef.current}`);
    const wasConnected = ['connected', 'connecting', 'dialing'].includes(chatStateRef.current);
    
    cleanupWebRTC(); 
    
    if (roomIdRef.current) {
        removeFirebaseListener(`callSignals/${roomIdRef.current}/answer`);
        removeFirebaseListener(`callSignals/${roomIdRef.current}/offer`);
        if (peerIdRef.current) removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${peerIdRef.current}`);
        if (sessionUser?.id) removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${sessionUser.id}`);
    }
    if (sessionUser?.id) removeFirebaseListener(`callSignals/${sessionUser.id}/pendingOffer`);


    await cleanupCallData(); 

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
    // peerIdRef.current = null; // Keep for 'revealed' state if needed, cleared on back to online users
    isCallerRef.current = false;

  }, [cleanupWebRTC, cleanupCallData, sessionUser?.id, onlineUsers, peerInfo, removeFirebaseListener, addDebugLog]);


  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    const currentSessionId = sessionUser?.id;
    if (!currentSessionId || !currentLocalStream) {
        addDebugLog(`ERROR: InitializePeerConnection: Missing sessionUser ID (${currentSessionId}) or local stream.`);
        return null;
    }
    addDebugLog(`Initializing RTCPeerConnection.`);
    const pc = new RTCPeerConnection(servers);

    currentLocalStream.getTracks().forEach(track => {
        try {
            pc.addTrack(track, currentLocalStream);
            addDebugLog(`Added local track: ${track.kind}`);
        } catch (e: any) {
            addDebugLog(`ERROR adding local track ${track.kind}: ${e.message || e}`);
        }
    });

    pc.ontrack = (event) => {
      addDebugLog(`Remote track received: Kind: ${event.track.kind}, ID: ${event.track.id}`);
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      } else {
        const newStream = new MediaStream();
        newStream.addTrack(event.track);
        setRemoteStream(newStream);
      }
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate && roomIdRef.current && currentSessionId) {
            addDebugLog(`Generated ICE candidate: ${event.candidate.candidate.substring(0,30)}... for room ${roomIdRef.current}`);
            const candidatesRefPath = `iceCandidates/${roomIdRef.current}/${currentSessionId}`;
            // Check if listener exists before pushing, ensure it's set up for the other party.
            push(ref(db, candidatesRefPath), event.candidate.toJSON())
                .catch(e => addDebugLog(`ERROR pushing ICE candidate to ${candidatesRefPath}: ${e}`));
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
        }
      } else if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
          addDebugLog(`ICE state: ${pc.iceConnectionState}. Ending call.`);
          toast({ title: "Connection Issue", description: `Call state: ${pc.iceConnectionState}. Ending call.`, variant: "default" });
          handleEndCall(false); 
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
    } catch (err: any) {
      addDebugLog(`ERROR accessing media devices: ${err.message || err}`);
      toast({ title: "Media Error", description: "Could not access camera/microphone. Please check permissions.", variant: "destructive" });
      setChatState('idle'); 
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
      cleanupWebRTC(); 
      return;
    }
    peerConnectionRef.current = pc;
    
    isCallerRef.current = true;
    peerIdRef.current = targetUser.id;
    setPeerInfo(targetUser); 
    
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
      addDebugLog(`Offer created and local description set for room ${newRoomId}.`);

      const offerPayload: IncomingCallOffer = {
        roomId: newRoomId, 
        offer: pc.localDescription!.toJSON(),
        callerId: sessionUser.id,
        callerName: sessionUser.name,
        callerPhotoUrl: sessionUser.photoUrl || '',
      };
      const offerPath = `callSignals/${targetUser.id}/pendingOffer`;
      await set(ref(db, offerPath), offerPayload);
      toast({ title: "Calling...", description: `Calling ${targetUser.name}...` });
      addDebugLog(`Offer sent to ${targetUser.id} at ${offerPath}. Room: ${newRoomId}`);

      const answerPath = `callSignals/${newRoomId}/answer`;
      const answerListenerCallback = async (snapshot: any) => {
        if (snapshot.exists() && peerConnectionRef.current) { // Check pc still exists
          const answerData = snapshot.val() as CallAnswer;
          addDebugLog(`Received answer from ${answerData.calleeId} for room ${newRoomId}.`);
          if (peerConnectionRef.current.signalingState === 'have-local-offer' || peerConnectionRef.current.signalingState === 'stable') { // Ensure not already processing
            if (peerConnectionRef.current.remoteDescription) {
                addDebugLog(`WARN: Caller: Remote description already set before processing this answer. Current signaling state: ${peerConnectionRef.current.signalingState}`);
            }
            try {
                await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answerData.answer));
                addDebugLog(`Caller: Remote description (answer) set successfully.`);
            } catch (e: any) {
                addDebugLog(`ERROR: Caller: setting remote description from answer: ${e.message || e}`);
                handleEndCall(false);
                return;
            }
            removeFirebaseListener(answerPath); 
            remove(ref(db, answerPath)).catch(e => addDebugLog(`WARN: Error removing answer from DB: ${e}`));
          } else {
            addDebugLog(`WARN: Caller: Received answer but PC signaling state is ${peerConnectionRef.current.signalingState}. Remote desc: ${peerConnectionRef.current.remoteDescription}`);
          }
        }
      };
      addFirebaseListener(answerPath, answerListenerCallback);


      const calleeIcePath = `iceCandidates/${newRoomId}/${targetUser.id}`;
      const calleeIceCallback = (snapshot: any) => { // This should be child_added
          const candidate = snapshot.val();
          if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription) { 
            addDebugLog(`Caller: Adding ICE candidate from callee ${targetUser.id}: ${candidate.candidate?.substring(0,30)}...`);
            peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => addDebugLog(`ERROR: Caller adding callee ICE candidate: ${e}`));
          } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
            addDebugLog(`WARN: Caller received callee ICE for room ${newRoomId} but remote description not yet set.`);
          }
      };
      addFirebaseListener(calleeIcePath, calleeIceCallback, 'child_added');

    } catch (error: any) {
      addDebugLog(`ERROR initiating call: ${error.message || error}`);
      toast({ title: "Call Error", description: "Could not initiate the call.", variant: "destructive" });
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, removeFirebaseListener, cleanupWebRTC, startLocalStream, addDebugLog]);


  const processIncomingOfferAndAnswer = useCallback(async (offerData: IncomingCallOffer) => {
    if (!sessionUser || chatStateRef.current !== 'idle') {
      addDebugLog(`processIncomingOfferAndAnswer called but state is ${chatStateRef.current} or no sessionUser. Offer from ${offerData.callerId}.`);
      if (sessionUser?.id) {
         remove(ref(db, `callSignals/${sessionUser.id}/pendingOffer`)).catch(e => addDebugLog(`WARN: Callee: Error removing (likely stale) pending offer: ${e}`));
      }
      return;
    }
    addDebugLog(`Processing incoming offer from ${offerData.callerName} (${offerData.callerId}). Room: ${offerData.roomId}.`);

    setChatState('connecting');
    peerIdRef.current = offerData.callerId;
    roomIdRef.current = offerData.roomId;
    isCallerRef.current = false;
    
    const peer = onlineUsers.find(u => u.id === offerData.callerId) || 
                 {id: offerData.callerId, name: offerData.callerName, photoUrl: offerData.callerPhotoUrl};
    setPeerInfo(peer);
    toast({ title: "Incoming Call", description: `Connecting to ${offerData.callerName}...` });

    const stream = await startLocalStream();
    if (!stream) {
      addDebugLog("Callee: Failed to start local stream for incoming call.");
      await handleEndCall(false);
      return;
    }

    const pc = initializePeerConnection(stream);
    if (!pc) {
      addDebugLog("Callee: ERROR: Failed to initialize peer connection.");
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      await handleEndCall(false);
      return;
    }
    peerConnectionRef.current = pc;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerData.offer));
      addDebugLog(`Callee: Remote description (offer from ${offerData.callerId}) set successfully for room ${offerData.roomId}.`);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      addDebugLog(`Callee: Local description (answer) created and set for room ${offerData.roomId}.`);

      const answerPayload: CallAnswer = {
        answer: pc.localDescription!.toJSON(),
        calleeId: sessionUser.id,
      };
      const answerPath = `callSignals/${offerData.roomId}/answer`;
      await set(ref(db, answerPath), answerPayload);
      addDebugLog(`Callee: Answer sent to room ${offerData.roomId} via ${answerPath}.`);
      
      const myOfferPath = `callSignals/${sessionUser.id}/pendingOffer`;
      await remove(ref(db, myOfferPath)); 
      addDebugLog(`Callee: Removed processed pending offer from ${myOfferPath}.`);

      const callerIcePath = `iceCandidates/${offerData.roomId}/${offerData.callerId}`;
      const callerIceCallback = (snapshot: any) => { // This should be child_added
          const candidate = snapshot.val();
          if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription) { 
             addDebugLog(`Callee: Adding ICE candidate from caller ${offerData.callerId} for room ${offerData.roomId}: ${candidate.candidate?.substring(0,30)}...`);
             peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => addDebugLog(`ERROR: Callee adding caller ICE candidate: ${e}`));
          } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
            addDebugLog(`WARN: Callee received caller ICE for room ${offerData.roomId} but remote description not yet set.`);
          }
      };
      addFirebaseListener(callerIcePath, callerIceCallback, 'child_added');

    } catch (error: any) {
      addDebugLog(`Callee: ERROR processing incoming offer for room ${offerData.roomId}: ${error.message || error}`);
      toast({ title: "Call Error", description: "Could not connect the call.", variant: "destructive" });
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, onlineUsers, toast, addFirebaseListener, startLocalStream, addDebugLog]);

  // Presence system
  useEffect(() => {
    if (!sessionUser?.id) return;
    const myId = sessionUser.id;
    addDebugLog(`Setting up presence system for ${myId}.`);

    const userStatusRef = ref(db, `onlineUsers/${myId}`);
    const connectedRefPath = '.info/connected';

    const presenceConnectionCallback = (snapshot: any) => {
      if (snapshot.val() === true) {
        addDebugLog(`Firebase connection established. Setting presence for ${myId}.`);
        set(userStatusRef, sessionUser).catch(e => addDebugLog(`ERROR setting presence for ${myId}: ${e}`));
        onDisconnect(userStatusRef).remove().catch(e => addDebugLog(`ERROR setting onDisconnect for ${myId}: ${e}`));
      } else {
        addDebugLog(`Firebase connection lost for ${myId}.`);
      }
    };
    addFirebaseListener(connectedRefPath, presenceConnectionCallback);

    const onlineUsersRefPath = 'onlineUsers';
    const onlineUsersListenerCallback = (snapshot: any) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = usersData ? Object.values(usersData) : [];
      setOnlineUsers(userList.filter(u => u.id !== myId)); 
      addDebugLog(`Online users updated: ${userList.filter(u => u.id !== myId).length} other users.`);
    };
    addFirebaseListener(onlineUsersRefPath, onlineUsersListenerCallback);

    return () => {
      addDebugLog(`Cleaning up presence for session user effect: ${myId}`);
      removeFirebaseListener(connectedRefPath);
      removeFirebaseListener(onlineUsersRefPath);
      // onDisconnect should handle removal, but as a fallback, you could explicitly remove here if needed.
      // remove(userStatusRef).catch(e => addDebugLog(`WARN: Error removing user on presence cleanup: ${e}`));
    };
  }, [sessionUser, addFirebaseListener, removeFirebaseListener, addDebugLog]);


  // Listener for incoming calls (auto-accepted)
  useEffect(() => {
    if (!sessionUser?.id) return;
    
    const myId = sessionUser.id;
    const incomingCallPath = `callSignals/${myId}/pendingOffer`;
    addDebugLog(`Attempting to attach incoming call listener at ${incomingCallPath}`);
    
    const incomingCallListenerCallback = async (snapshot: any) => {
      const offerData = snapshot.val() as IncomingCallOffer | null;
      addDebugLog(`Offer listener at ${incomingCallPath} triggered. Data exists: ${!!offerData}. Current chat state: ${chatStateRef.current}`);

      if (offerData) {
        if (chatStateRef.current === 'idle') {
          addDebugLog(`Valid offer received from ${offerData.callerName} (room ${offerData.roomId}). Processing...`);
          await processIncomingOfferAndAnswer(offerData);
        } else {
          addDebugLog(`WARN: Received offer from ${offerData.callerId} (room ${offerData.roomId}) while in state ${chatStateRef.current}. Removing stale offer.`);
          remove(ref(db, incomingCallPath)).catch(e => addDebugLog(`WARN: Error removing stale offer: ${e}`));
        }
      } else {
          addDebugLog(`Offer listener at ${incomingCallPath} received null data (offer likely removed/processed).`);
      }
    };
    
    addFirebaseListener(incomingCallPath, incomingCallListenerCallback);

    return () => {
        addDebugLog(`Cleaning up incoming call listener for path: ${incomingCallPath}`);
        removeFirebaseListener(incomingCallPath);
    };
  }, [sessionUser?.id, processIncomingOfferAndAnswer, addFirebaseListener, removeFirebaseListener, addDebugLog]); // toast removed as it's stable via useToast


  // Cleanup effect for component unmount
  useEffect(() => {
    const myId = sessionUser?.id; 
    return () => {
      addDebugLog(`HomePage unmounting for user ${myId || 'N/A'}. Performing full cleanup.`);
      cleanupWebRTC();
      cleanupAllFirebaseListeners();
      
      if (myId) {
        // This is secondary to onDisconnect but can help in some scenarios
        remove(ref(db, `onlineUsers/${myId}`)).catch(e => addDebugLog(`WARN: Error removing user ${myId} from onlineUsers on unmount: ${e}`));
      }
      cleanupCallData(); 
      addDebugLog(`Full cleanup on unmount complete for ${myId || 'N/A'}.`);
    };
  }, [sessionUser?.id, cleanupWebRTC, cleanupAllFirebaseListeners, cleanupCallData, addDebugLog]);


  const handleBackToOnlineUsers = async () => {
    addDebugLog(`Handling back to online users from revealed state.`);
    // No need to call handleEndCall here as it would have been called to get to revealed state.
    // If called again, it might try to cleanup already cleaned resources.
    setChatState('idle');
    setPeerInfo(null);
    peerIdRef.current = null; // Crucial to clear peerId here
    roomIdRef.current = null;
    isCallerRef.current = false;
    // Ensure WebRTC resources are definitely cleaned, in case of edge case
    cleanupWebRTC();
    // Ensure call data is cleaned if it somehow persisted
    await cleanupCallData();
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
      
      
