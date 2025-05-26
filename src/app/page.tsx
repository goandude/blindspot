
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { OnlineUser, IncomingCallOffer, CallAnswer } from '@/types';
import { PhoneOff, Video as VideoIcon } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, push, child, serverTimestamp, DatabaseReference } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { OnlineUsersPanel } from '@/components/features/online-users/online-users-panel';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { DebugLogPanel } from '@/components/features/debug/debug-log-panel';

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
  
  const firebaseListeners = useRef<Map<string, { unsubscribe: () => void, path: string, eventType: string }>>(new Map());
  
  const chatStateRef = useRef<ChatState>(chatState);
  const sessionIdRef = useRef<string | null>(sessionId);
  const sessionUserIdRef = useRef<string | null>(sessionUser?.id || null);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  useEffect(() => {
    sessionUserIdRef.current = sessionUser?.id || null;
  }, [sessionUser?.id]);

  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const currentSId = sessionIdRef.current; 
    const currentUserId = sessionUserIdRef.current; 
    
    let prefix = '[N/A] ';
    if (currentUserId) {
      prefix = `[${currentUserId.substring(0,4)}] `;
    } else if (currentSId) {
      prefix = `[${currentSId.substring(0,4)}] `;
    }
    
    const logEntry = `[${timestamp}] ${prefix}${message}`;
    setDebugLogs(prevLogs => [logEntry, ...prevLogs].slice(0, 100)); 
  }, []); 

  useEffect(() => {
    chatStateRef.current = chatState;
    addDebugLog(`Chat state changed to: ${chatState}`);
  }, [chatState, addDebugLog]);

  useEffect(() => {
    // This effect runs only once on mount to generate the initial session ID
    const newSessionId = generateSessionId();
    setSessionId(newSessionId);
    // Logging for sessionId generation is moved to the effect that consumes it
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

  const removeFirebaseListener = useCallback((path: string) => {
    const listenerEntry = firebaseListeners.current.get(path);
    if (listenerEntry) {
        try {
            listenerEntry.unsubscribe();
            addDebugLog(`Successfully removed Firebase listener for path: ${path} (type: ${listenerEntry.eventType})`);
        } catch (error: any) {
            addDebugLog(`WARN: Error unsubscribing Firebase listener for path ${path} (type: ${listenerEntry.eventType}): ${error.message || error}`);
        }
        firebaseListeners.current.delete(path);
    } else {
        addDebugLog(`WARN: No listener found for path ${path} to remove.`);
    }
  }, [addDebugLog]);

 const addFirebaseListener = useCallback((path: string, listenerFunc: (snapshot: any) => void, eventType: string = 'value') => {
    if (firebaseListeners.current.has(path)) {
        addDebugLog(`Listener for path ${path} (type: ${eventType}) already exists. Removing old one first.`);
        removeFirebaseListener(path);
    }
    const dbRef = ref(db, path);
    
    let firebaseCallback: (snapshot: any) => void;
    let unsubscribeFunction: () => void;

    if (eventType === 'child_added') {
        firebaseCallback = (snapshot) => { // For child_added, snapshot is the child data
            listenerFunc(snapshot);
        };
        const actualListener = onValue(dbRef, (snapshot) => { // onValue gives the parent, then we iterate children for initial load
            snapshot.forEach((childSnapshot) => {
                 // This is a workaround. Firebase 'onValue' for 'child_added' is not direct.
                 // Usually, you'd fetch initial, then use 'onChildAdded'.
                 // For this simplified model, we'll just re-process all children if 'value' is used,
                 // or if using 'child_added' like this, it will be tricky for initial + new.
                 // Sticking to 'value' and processing the list is simpler for ICE.
            });
        }, (error) => {
             addDebugLog(`ERROR reading from ${path} (event: ${eventType} - initial setup): ${error.message}`);
             toast({ title: "Firebase Error", description: `Failed to listen to ${path}. Check console.`, variant: "destructive" });
        });
        // For 'child_added' specifically, this is not straightforward with 'onValue' to get only new children.
        // A proper 'onChildAdded' implementation is more complex.
        // Let's use 'value' for ICE candidates and process the list, as it's simpler for this case.
        // The provided code structure uses 'value' then iterates, which is fine.
        // Let's revert to simpler 'value' for ICE listeners to avoid confusion or stick to current.
        // The current code uses 'value' for ICE and iterates with snapshot.forEach(), which is effectively handling a list.
         unsubscribeFunction = onValue(dbRef, listenerFunc, (error) => {
            addDebugLog(`ERROR reading from ${path} (event: ${eventType}): ${error.message}`);
            toast({ title: "Firebase Error", description: `Failed to listen to ${path}. Check console.`, variant: "destructive" });
        });

    } else { // For 'value' or other types (though we mostly use 'value')
        firebaseCallback = (snapshot: any) => {
            listenerFunc(snapshot);
        };
         unsubscribeFunction = onValue(dbRef, firebaseCallback, (error) => {
            addDebugLog(`ERROR reading from ${path} (event: ${eventType}): ${error.message}`);
            toast({ title: "Firebase Error", description: `Failed to listen to ${path}. Check console.`, variant: "destructive" });
        });
    }
        
    firebaseListeners.current.set(path, { unsubscribe: unsubscribeFunction, path, eventType });
    addDebugLog(`Added Firebase listener for path: ${path} with eventType: ${eventType}`);
  }, [addDebugLog, toast, removeFirebaseListener]); 


  const cleanupAllFirebaseListeners = useCallback(() => {
    addDebugLog(`Cleaning up ALL (${firebaseListeners.current.size}) Firebase listeners.`);
    firebaseListeners.current.forEach((listenerEntry, path) => {
      try {
        listenerEntry.unsubscribe();
        addDebugLog(`Cleaned up listener for ${listenerEntry.path} (type: ${listenerEntry.eventType})`);
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
      addDebugLog(`No active peer connection to cleanup for WebRTC.`);
    }

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
      addDebugLog(`Local stream stopped.`);
    }
    setRemoteStream(null);
  }, [localStream, addDebugLog]);


  const cleanupCallData = useCallback(async () => {
    const myId = sessionUserIdRef.current; 
    const currentRoomId = roomIdRef.current;
    const currentPeerId = peerIdRef.current;
    addDebugLog(`Cleaning up call data. MyID: ${myId}, Room: ${currentRoomId}, Peer: ${currentPeerId}`);

    if (currentRoomId) {
        const roomSignalsPath = `callSignals/${currentRoomId}`;
        remove(ref(db, roomSignalsPath)).catch(e => addDebugLog(`WARN: Error removing room signals for ${roomSignalsPath}: ${e.message || e}`));
        
        const myIceCandidatesPath = `iceCandidates/${currentRoomId}/${myId}`;
        if (myId) remove(ref(db, myIceCandidatesPath)).catch(e => addDebugLog(`WARN: Error removing my ICE for room ${myIceCandidatesPath}: ${e.message || e}`));
        
        const peerIceCandidatesPath = `iceCandidates/${currentRoomId}/${currentPeerId}`;
        if (currentPeerId) remove(ref(db, peerIceCandidatesPath)).catch(e => addDebugLog(`WARN: Error removing peer ICE for room ${peerIceCandidatesPath}: ${e.message || e}`));
    }
    
    const myPendingOfferPath = `callSignals/${myId}/pendingOffer`;
    if (myId) {
      remove(ref(db, myPendingOfferPath)).catch(e => addDebugLog(`WARN: Error removing my pending offer from ${myPendingOfferPath}: ${e.message || e}`));
    }

    if (isCallerRef.current && currentPeerId) {
        const peerPendingOfferPath = `callSignals/${currentPeerId}/pendingOffer`;
        remove(ref(db, peerPendingOfferPath)).catch(e => addDebugLog(`WARN: Caller: Error removing pending offer for peer ${peerPendingOfferPath}: ${e.message || e}`));
    }
     addDebugLog("Call data cleanup attempt finished.");

  }, [addDebugLog]); 


const handleEndCall = useCallback(async (showReveal = true) => {
    addDebugLog(`Handling end call. Show reveal: ${showReveal}. Current chat state: ${chatStateRef.current}. PeerId: ${peerIdRef.current}`);
    const wasConnected = ['connected', 'connecting', 'dialing'].includes(chatStateRef.current);
    
    cleanupWebRTC(); 
    
    if (roomIdRef.current) {
        removeFirebaseListener(`callSignals/${roomIdRef.current}/answer`);
        if (peerIdRef.current) removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${peerIdRef.current}`);
        const currentSessionUserId = sessionUserIdRef.current;
        if (currentSessionUserId) removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${currentSessionUserId}`);
    }
    const currentSessionUserIdForOffer = sessionUserIdRef.current;
    if (currentSessionUserIdForOffer) removeFirebaseListener(`callSignals/${currentSessionUserIdForOffer}/pendingOffer`);


    await cleanupCallData(); 

    if (showReveal && peerIdRef.current && wasConnected) {
        const peer = onlineUsers.find(u => u.id === peerIdRef.current) || 
                     (peerInfo?.id === peerIdRef.current ? peerInfo : null) ||
                     (peerIdRef.current ? { id: peerIdRef.current, name: `User-${peerIdRef.current.substring(0,4)}`, photoUrl: `https://placehold.co/96x96.png?text=${peerIdRef.current.charAt(0).toUpperCase()}` } : null);

        setPeerInfo(peer); 
        setChatState('revealed');
        addDebugLog(`Call ended. Transitioning to 'revealed' state with peer ${peer?.name || peerIdRef.current}.`);
    } else {
        setChatState('idle');
        setPeerInfo(null); 
        addDebugLog(`Call ended. Transitioning to 'idle' state.`);
    }
    
    roomIdRef.current = null; 
    if (chatStateRef.current === 'idle') {
        peerIdRef.current = null;
    }
    isCallerRef.current = false;

  }, [cleanupWebRTC, cleanupCallData, onlineUsers, peerInfo, removeFirebaseListener, addDebugLog]); 


  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    const currentSId = sessionUserIdRef.current;
    if (!currentSId || !currentLocalStream) {
        addDebugLog(`ERROR: InitializePeerConnection: Missing sessionUser ID (${currentSId}) or local stream.`);
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
      addDebugLog(`Remote track received: Kind: ${event.track.kind}, ID: ${event.track.id}, Streams: ${event.streams.length}`);
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      } else {
        const newStream = new MediaStream();
        newStream.addTrack(event.track);
        setRemoteStream(newStream);
         addDebugLog(`Remote track added to new stream. Stream ID: ${newStream.id}`);
      }
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate && roomIdRef.current && currentSId) {
            addDebugLog(`Generated ICE candidate: ${event.candidate.candidate?.substring(0,30)}... for room ${roomIdRef.current}`);
            const candidatesRefPath = `iceCandidates/${roomIdRef.current}/${currentSId}`;
            push(ref(db, candidatesRefPath), event.candidate.toJSON())
                .catch(e => addDebugLog(`ERROR pushing ICE candidate to ${candidatesRefPath}: ${e.message || e}`));
        } else if (!event.candidate) {
            addDebugLog("ICE gathering complete.");
        }
    };

    pc.oniceconnectionstatechange = () => {
      if (!peerConnectionRef.current) { 
          addDebugLog("ICE state change but peerConnectionRef.current is null.");
          return;
      }
      addDebugLog(`ICE connection state changed: ${peerConnectionRef.current.iceConnectionState}`);
      if (peerConnectionRef.current.iceConnectionState === 'connected') {
        if (['connecting', 'dialing'].includes(chatStateRef.current)) {
            addDebugLog("ICE connected, setting chat state to 'connected'.");
            setChatState('connected');
        }
      } else if (['failed', 'disconnected', 'closed'].includes(peerConnectionRef.current.iceConnectionState)) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
          addDebugLog(`ICE state: ${peerConnectionRef.current.iceConnectionState}. Ending call (showReveal=false).`);
          toast({ title: "Connection Issue", description: `Call state: ${peerConnectionRef.current.iceConnectionState}. Ending call.`, variant: "default" });
          handleEndCall(false); 
        }
      }
    };
    pc.onsignalingstatechange = () => {
        if (!peerConnectionRef.current) {
            addDebugLog("Signaling state change but peerConnectionRef.current is null.");
            return;
        }
        addDebugLog(`Signaling state changed: ${peerConnectionRef.current.signalingState}`);
    };
    return pc;
  }, [handleEndCall, toast, addDebugLog]); 

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
      if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
         handleEndCall(false); 
      } else {
         setChatState('idle'); 
      }
      return null;
    }
  }, [toast, addDebugLog, handleEndCall]);


  const initiateDirectCall = useCallback(async (targetUser: OnlineUser) => {
    const currentSessionUserId = sessionUserIdRef.current;
    if (!currentSessionUserId || targetUser.id === currentSessionUserId) {
      addDebugLog(`Cannot call self or sessionUser is null.`);
      toast({title: "Call Error", description: "Cannot call self.", variant: "destructive"});
      return;
    }
    
    addDebugLog(`Initiating direct call to ${targetUser.name} (${targetUser.id}). Current chat state: ${chatStateRef.current}`);
    
    if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
        addDebugLog(`In non-idle state (${chatStateRef.current}), ending existing call before initiating new one.`);
        await handleEndCall(false); 
    }
    
    setChatState('dialing'); 
    setPeerInfo(targetUser); 
    peerIdRef.current = targetUser.id;
    isCallerRef.current = true;

    const stream = await startLocalStream();
    if (!stream) {
        addDebugLog("Failed to start local stream for outgoing call.");
        await handleEndCall(false); 
        return;
    }

    const pc = initializePeerConnection(stream);
    if (!pc) {
      addDebugLog("ERROR: Failed to initialize peer connection for outgoing call.");
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      await handleEndCall(false); 
      return;
    }
    peerConnectionRef.current = pc;
    
    const newRoomId = push(child(ref(db), 'callRooms')).key; 
    if (!newRoomId) {
        addDebugLog("ERROR: Could not create a call room ID.");
        toast({title: "Error", description: "Could not create a call room.", variant: "destructive"});
        await handleEndCall(false);
        return;
    }
    roomIdRef.current = newRoomId;
    addDebugLog(`Assigned new room ID: ${newRoomId} for call with ${targetUser.id}`);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      addDebugLog(`Offer created and local description set for room ${newRoomId}.`);

      const offerPayload: IncomingCallOffer = {
        roomId: newRoomId, 
        offer: pc.localDescription!.toJSON(),
        callerId: currentSessionUserId, 
        callerName: sessionUser?.name || `User-${currentSessionUserId.substring(0,4)}`, 
        callerPhotoUrl: sessionUser?.photoUrl || `https://placehold.co/96x96.png?text=${currentSessionUserId.charAt(0).toUpperCase()}`,
      };
      const offerPath = `callSignals/${targetUser.id}/pendingOffer`;
      await set(ref(db, offerPath), offerPayload);
      toast({ title: "Calling...", description: `Calling ${targetUser.name}...` });
      addDebugLog(`Offer sent to ${targetUser.id} at ${offerPath}. Room: ${newRoomId}`);

      const answerPath = `callSignals/${newRoomId}/answer`;
      addFirebaseListener(answerPath, async (snapshot: any) => {
        if (snapshot.exists() && peerConnectionRef.current) { 
          const answerData = snapshot.val() as CallAnswer;
          addDebugLog(`Caller: Received answer from ${answerData.calleeId} for room ${newRoomId}. PC Signaling State: ${peerConnectionRef.current.signalingState}`);
          if (peerConnectionRef.current.signalingState === 'have-local-offer' || peerConnectionRef.current.signalingState === 'stable') { 
            if (peerConnectionRef.current.remoteDescription) {
                addDebugLog(`WARN: Caller: Remote description already set before processing this answer.`);
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
            remove(ref(db, answerPath)).catch(e => addDebugLog(`WARN: Error removing answer from DB: ${e.message || e}`));
          } else {
            addDebugLog(`WARN: Caller: Received answer but PC signaling state is ${peerConnectionRef.current.signalingState}. Remote desc: ${!!peerConnectionRef.current.remoteDescription}`);
          }
        }
      }, 'value');


      const calleeIcePath = `iceCandidates/${newRoomId}/${targetUser.id}`;
      addFirebaseListener(calleeIcePath, (snapshot: any) => {
        snapshot.forEach((childSnapshot: any) => { 
          const candidate = childSnapshot.val();
          if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription) { 
            addDebugLog(`Caller: Received ICE candidate object from callee ${targetUser.id}: ${JSON.stringify(candidate)}`);
            if (candidate.sdpMid === null && candidate.sdpMLineIndex === null && candidate.candidate !==null && candidate.candidate !== "") { 
                addDebugLog(`WARN: Caller: Received ICE candidate with both sdpMid and sdpMLineIndex as null from callee ${targetUser.id}. Candidate: ${candidate.candidate?.substring(0,30)}...`);
            } else if (candidate.candidate) { 
                addDebugLog(`Caller: Adding ICE candidate from callee ${targetUser.id}: ${candidate.candidate?.substring(0,30)}...`);
                peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                    .catch(e => addDebugLog(`ERROR: Caller adding callee ICE candidate: ${e.message || e}`));
            } else {
                 addDebugLog(`Caller: Received empty/invalid ICE candidate from callee ${targetUser.id}. Skipping. ${JSON.stringify(candidate)}`);
            }
          } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
            addDebugLog(`WARN: Caller received callee ICE for room ${newRoomId} but remote description not yet set.`);
          }
        });
      }, 'value');

    } catch (error: any) {
      addDebugLog(`ERROR initiating call sequence: ${error.message || error}`);
      toast({ title: "Call Error", description: "Could not initiate the call.", variant: "destructive" });
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, removeFirebaseListener, startLocalStream, addDebugLog]);


  const processIncomingOfferAndAnswer = useCallback(async (offerData: IncomingCallOffer) => {
    const currentSessionUserId = sessionUserIdRef.current; 
    if (!currentSessionUserId || chatStateRef.current !== 'idle') {
      addDebugLog(`processIncomingOfferAndAnswer called but state is ${chatStateRef.current} or no sessionUser. Offer from ${offerData.callerId}. Removing stale offer.`);
      if (currentSessionUserId) {
         remove(ref(db, `callSignals/${currentSessionUserId}/pendingOffer`)).catch(e => addDebugLog(`WARN: Callee: Error removing (likely stale) pending offer: ${e.message || e}`));
      }
      return;
    }
    addDebugLog(`Processing incoming offer from ${offerData.callerName} (${offerData.callerId}). Room: ${offerData.roomId}.`);

    setChatState('connecting');
    peerIdRef.current = offerData.callerId;
    roomIdRef.current = offerData.roomId;
    isCallerRef.current = false;
    
    const peerForInfo: OnlineUser = {
        id: offerData.callerId,
        name: offerData.callerName,
        photoUrl: offerData.callerPhotoUrl
    };
    setPeerInfo(peerForInfo);
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
        calleeId: currentSessionUserId,
      };
      const answerPath = `callSignals/${offerData.roomId}/answer`;
      await set(ref(db, answerPath), answerPayload);
      addDebugLog(`Callee: Answer sent to room ${offerData.roomId} via ${answerPath}.`);
      
      const myOfferPath = `callSignals/${currentSessionUserId}/pendingOffer`;
      await remove(ref(db, myOfferPath)); 
      addDebugLog(`Callee: Removed processed pending offer from ${myOfferPath}.`);

      const callerIcePath = `iceCandidates/${offerData.roomId}/${offerData.callerId}`;
      addFirebaseListener(callerIcePath, (snapshot: any) => { 
        snapshot.forEach((childSnapshot: any) => { 
            const candidate = childSnapshot.val();
            if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription) { 
                addDebugLog(`Callee: Received ICE candidate object from caller ${offerData.callerId}: ${JSON.stringify(candidate)}`);
                if (candidate.sdpMid === null && candidate.sdpMLineIndex === null && candidate.candidate !== null && candidate.candidate !== "") {
                    addDebugLog(`WARN: Callee: Received ICE candidate with both sdpMid and sdpMLineIndex as null from caller ${offerData.callerId}. Candidate: ${candidate.candidate?.substring(0,30)}...`);
                } else if (candidate.candidate) {
                    addDebugLog(`Callee: Adding ICE candidate from caller ${offerData.callerId} for room ${offerData.roomId}: ${candidate.candidate?.substring(0,30)}...`);
                    peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                        .catch(e => addDebugLog(`ERROR: Callee adding caller ICE candidate: ${e.message || e}`));
                } else {
                    addDebugLog(`Callee: Received empty/invalid ICE candidate from caller ${offerData.callerId}. Skipping. ${JSON.stringify(candidate)}`);
                }
            } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
                addDebugLog(`WARN: Callee received caller ICE for room ${offerData.roomId} but remote description not yet set.`);
            }
        });
      }, 'value'); 

    } catch (error: any) {
      addDebugLog(`Callee: ERROR processing incoming offer for room ${offerData.roomId}: ${error.message || error}`);
      toast({ title: "Call Error", description: "Could not connect the call.", variant: "destructive" });
      await handleEndCall(false);
    }
  }, [initializePeerConnection, handleEndCall, toast, addFirebaseListener, startLocalStream, addDebugLog]); 

  // Presence system
  useEffect(() => {
    const currentSessionUserForPresence = sessionUser; 
    if (!currentSessionUserForPresence?.id) return;
    const myId = currentSessionUserForPresence.id;
    addDebugLog(`Setting up presence system for ${myId}.`);

    const userStatusRef: DatabaseReference = ref(db, `onlineUsers/${myId}`);
    const connectedRefPath = '.info/connected';

    const presenceConnectionCallback = (snapshot: any) => {
      if (snapshot.val() === true) {
        addDebugLog(`Firebase connection established. Setting presence for ${myId}.`);
        const presenceData = { ...currentSessionUserForPresence, timestamp: serverTimestamp() }; 
        set(userStatusRef, presenceData)
          .then(() => {
             userStatusRef.onDisconnect().remove().catch(e => addDebugLog(`ERROR setting onDisconnect for ${myId}: ${e.message || e}`));
             addDebugLog(`onDisconnect handler set for ${myId}.`);
          })
          .catch(e => addDebugLog(`ERROR setting presence for ${myId}: ${e.message || e}`));
      } else {
        addDebugLog(`Firebase connection lost for ${myId}.`);
      }
    };
    addFirebaseListener(connectedRefPath, presenceConnectionCallback, 'value');

    const onlineUsersRefPath = 'onlineUsers';
    const onlineUsersListenerCallback = (snapshot: any) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = usersData ? Object.values(usersData) : [];
      setOnlineUsers(userList.filter(u => u.id !== myId)); 
      addDebugLog(`Online users updated: ${userList.filter(u => u.id !== myId).length} other users.`);
    };
    addFirebaseListener(onlineUsersRefPath, onlineUsersListenerCallback, 'value');

    return () => {
      addDebugLog(`Cleaning up presence for session user effect: ${myId}`);
      removeFirebaseListener(connectedRefPath);
      removeFirebaseListener(onlineUsersRefPath);
      // onDisconnect handles removal from onlineUsers. Explicit remove here could be redundant or cause issues if disconnect handler hasn't fired.
      // remove(userStatusRef).catch(e => addDebugLog(`WARN: Error removing user ${myId} from onlineUsers on presence cleanup: ${e.message || e}`));
    };
  }, [sessionUser, addFirebaseListener, removeFirebaseListener, addDebugLog]); 


  // Listener for incoming calls (auto-accepted)
  useEffect(() => {
    const currentSessionIdForOfferListener = sessionUserIdRef.current;
    if (!currentSessionIdForOfferListener) {
        addDebugLog(`Incoming call listener: No sessionUser.id, cannot attach listener.`);
        return;
    }
    
    const incomingCallPath = `callSignals/${currentSessionIdForOfferListener}/pendingOffer`;
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
          remove(ref(db, incomingCallPath)).catch(e => addDebugLog(`WARN: Error removing stale offer: ${e.message || e}`));
        }
      } else {
          addDebugLog(`Offer listener at ${incomingCallPath} received null data (offer likely removed/processed or this is initial load).`);
      }
    };
    
    addFirebaseListener(incomingCallPath, incomingCallListenerCallback, 'value');

    return () => {
        addDebugLog(`Cleaning up incoming call listener for path: ${incomingCallPath}`);
        removeFirebaseListener(incomingCallPath);
    };
  }, [processIncomingOfferAndAnswer, addFirebaseListener, removeFirebaseListener, addDebugLog]); 


  // Cleanup effect for component unmount
  useEffect(() => {
    const myCurrentSessionIdOnUnmount = sessionIdRef.current; 
    return () => {
      addDebugLog(`HomePage unmounting for user ${myCurrentSessionIdOnUnmount || 'N/A'}. Performing full cleanup.`);
      handleEndCall(false); 
      cleanupAllFirebaseListeners(); 
      
      if (myCurrentSessionIdOnUnmount) {
        const userStatusRefPath = `onlineUsers/${myCurrentSessionIdOnUnmount}`;
        addDebugLog(`Attempting to remove user from onlineUsers on unmount: ${userStatusRefPath}`);
        remove(ref(db, userStatusRefPath)).catch(e => addDebugLog(`WARN: Error removing user ${myCurrentSessionIdOnUnmount} from onlineUsers on unmount: ${e.message || e}`));
      }
      addDebugLog(`Full cleanup on unmount complete for ${myCurrentSessionIdOnUnmount || 'N/A'}.`);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 


  const handleBackToOnlineUsers = async () => {
    addDebugLog(`Handling back to online users from revealed state.`);
    setChatState('idle');
    setPeerInfo(null);
    peerIdRef.current = null; 
    roomIdRef.current = null;
    isCallerRef.current = false;
    cleanupWebRTC(); 
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
      
      
