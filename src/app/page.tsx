
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { OnlineUser, IncomingCallOffer, CallAnswer } from '@/types';
import { PhoneOff, Video as VideoIcon, Shuffle, LogIn, LogOut } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, push, child, serverTimestamp, type DatabaseReference } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { OnlineUsersPanel } from '@/components/features/online-users/online-users-panel';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { DebugLogPanel } from '@/components/features/debug/debug-log-panel';
import { useAuth } from '@/hooks/use-auth';

type ChatState = 'idle' | 'dialing' | 'connecting' | 'connected' | 'revealed';

const servers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const generateAnonymousSessionId = () => Math.random().toString(36).substring(2, 10);

export default function HomePage() {
  const [anonymousSessionId, setAnonymousSessionId] = useState<string | null>(null);
  const [sessionUser, setSessionUser] = useState<OnlineUser | null>(null); // Active user identity

  const [chatState, setChatState] = useState<ChatState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [peerInfo, setPeerInfo] = useState<OnlineUser | null>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [pageLoading, setPageLoading] = useState(true);


  const { toast } = useToast();
  const { currentUser, userProfile, loading: authLoading, signInWithGoogle, signOutUser } = useAuth();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);
  
  const firebaseListeners = useRef<Map<string, { unsubscribe: () => void, path: string, eventType: string }>>(new Map());
  const chatStateRef = useRef<ChatState>(chatState);
  const sessionUserIdRef = useRef<string | null>(null); // Holds active user ID (session or auth UID)

  useEffect(() => {
    sessionUserIdRef.current = sessionUser?.id || null;
    addDebugLog(`Active session user ID set to: ${sessionUserIdRef.current}`);
  }, [sessionUser?.id]); // addDebugLog dependency removed as it's stable now


  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const currentSId = sessionUserIdRef.current; 
    let prefix = currentSId ? `[${currentSId.substring(0,4)}] ` : '[N/A] ';
    const logEntry = `[${timestamp}] ${prefix}${message}`;
    setDebugLogs(prevLogs => [logEntry, ...prevLogs].slice(0, 100)); 
  }, []); // Empty dependency array makes addDebugLog stable

  useEffect(() => {
    chatStateRef.current = chatState;
    // addDebugLog(`Chat state changed to: ${chatState}`); // Logged by setChatState wrapper
  }, [chatState]); // addDebugLog removed


  // 1. Initialize anonymous session ID (runs once)
  useEffect(() => {
    const newAnonId = generateAnonymousSessionId();
    setAnonymousSessionId(newAnonId);
    addDebugLog(`Generated new anonymous session ID: ${newAnonId}`);
  }, [addDebugLog]);

  // 2. Determine and set the active sessionUser (anonymous or authenticated)
  useEffect(() => {
    addDebugLog(`Auth loading: ${authLoading}, CurrentUser: ${currentUser?.uid}, AnonymousID: ${anonymousSessionId}`);
    if (authLoading) {
      addDebugLog("Auth state is loading, waiting to set sessionUser.");
      setPageLoading(true);
      return;
    }

    if (currentUser && userProfile) {
      addDebugLog(`Google user authenticated: ${userProfile.name} (${currentUser.uid}). Setting as sessionUser.`);
      const googleSessionUser: OnlineUser = {
        id: currentUser.uid,
        name: userProfile.name,
        photoUrl: userProfile.photoUrl,
        countryCode: userProfile.countryCode,
        isGoogleUser: true,
      };
      setSessionUser(googleSessionUser);
      setPageLoading(false);
    } else if (anonymousSessionId && !currentUser) {
      addDebugLog(`No Google user. Using anonymous session ID: ${anonymousSessionId}.`);
      setPageLoading(true); // Still loading country for anonymous
      const fetchCountryAndSetAnonymousUser = async () => {
        let countryCode = 'XX';
        try {
          const response = await fetch('https://ipapi.co/country_code/');
          if (response.ok) countryCode = (await response.text()).trim();
          else addDebugLog(`Failed to fetch country for anon user: ${response.status}`);
        } catch (e: any) { addDebugLog(`WARN: Error fetching country for anonymous user: ${e.message || e}`); }

        const anonUser: OnlineUser = {
          id: anonymousSessionId,
          name: `User-${anonymousSessionId.substring(0, 4)}`,
          photoUrl: `https://placehold.co/96x96.png?text=${anonymousSessionId.charAt(0).toUpperCase()}`,
          countryCode: countryCode,
          isGoogleUser: false,
        };
        setSessionUser(anonUser);
        setPageLoading(false);
        addDebugLog(`Anonymous session user created: ${anonUser.name} (${anonUser.id}) with country ${anonUser.countryCode}`);
      };
      fetchCountryAndSetAnonymousUser();
    } else if (!currentUser && !anonymousSessionId) {
        addDebugLog("Waiting for anonymous session ID to be generated. pageLoading true.");
        setPageLoading(true);
    } else {
        addDebugLog("Fell through sessionUser determination logic. pageLoading false.");
        setPageLoading(false); // Default to not loading if no other specific loading state
    }
  }, [currentUser, userProfile, anonymousSessionId, authLoading, addDebugLog]);


  const wrappedSetChatState = useCallback((newState: ChatState) => {
    addDebugLog(`Chat state changing to: ${newState}`);
    setChatState(newState);
  }, [addDebugLog]);


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
        // addDebugLog(`WARN: No listener found for path ${path} to remove.`); // Can be noisy
    }
  }, [addDebugLog]);

  const addFirebaseListener = useCallback((path: string, listenerFunc: (snapshot: any) => void, eventType: string = 'value') => {
    if (firebaseListeners.current.has(path)) {
        addDebugLog(`Listener for path ${path} (type: ${eventType}) already exists. Removing old one first.`);
        removeFirebaseListener(path);
    }
    const dbRef = ref(db, path);
    
    const actualCallback = (snapshot: any) => listenerFunc(snapshot);
    
    const unsubscribeFunction = onValue(dbRef, actualCallback, (error) => {
        addDebugLog(`ERROR reading from ${path} (event: ${eventType}): ${error.message}`);
        toast({ title: "Firebase Error", description: `Failed to listen to ${path}. Check console.`, variant: "destructive" });
    });
        
    firebaseListeners.current.set(path, { unsubscribe: unsubscribeFunction, path, eventType });
    addDebugLog(`Added Firebase listener for path: ${path} with eventType: ${eventType}`);
  }, [addDebugLog, toast, removeFirebaseListener]); 


  const cleanupAllFirebaseListeners = useCallback(() => {
    addDebugLog(`Cleaning up ALL (${firebaseListeners.current.size}) Firebase listeners.`);
    firebaseListeners.current.forEach((listenerEntry) => {
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
        if (sender.track) sender.track.stop();
        if (peerConnectionRef.current && peerConnectionRef.current.signalingState !== 'closed') {
            try { peerConnectionRef.current.removeTrack(sender); }
            catch(e: any) { addDebugLog(`WARN: Error removing track from sender: ${e.message || e}`); }
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
        
        if (myId) remove(ref(db, `iceCandidates/${currentRoomId}/${myId}`)).catch(e => addDebugLog(`WARN: Error removing my ICE for room ${currentRoomId}/${myId}: ${e.message || e}`));
        if (currentPeerId) remove(ref(db, `iceCandidates/${currentRoomId}/${currentPeerId}`)).catch(e => addDebugLog(`WARN: Error removing peer ICE for room ${currentRoomId}/${currentPeerId}: ${e.message || e}`));
    }
    if (myId) {
      remove(ref(db, `callSignals/${myId}/pendingOffer`)).catch(e => addDebugLog(`WARN: Error removing my pending offer from callSignals/${myId}/pendingOffer: ${e.message || e}`));
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
        const currentSUserId = sessionUserIdRef.current;
        if (currentSUserId) removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${currentSUserId}`);
    }
    const sUserIdForOffer = sessionUserIdRef.current;
    if (sUserIdForOffer) removeFirebaseListener(`callSignals/${sUserIdForOffer}/pendingOffer`);

    await cleanupCallData(); 

    if (showReveal && peerIdRef.current && wasConnected) {
      let peerToReveal = onlineUsers.find(u => u.id === peerIdRef.current) || 
                         (peerInfo?.id === peerIdRef.current ? peerInfo : null);
      if (!peerToReveal && peerIdRef.current) { // Construct minimal if not found
        peerToReveal = {
          id: peerIdRef.current,
          name: `User-${peerIdRef.current.substring(0,4)}`,
          photoUrl: `https://placehold.co/96x96.png?text=${peerIdRef.current.charAt(0).toUpperCase()}`,
          countryCode: 'XX',
          isGoogleUser: peerInfo?.isGoogleUser
        };
      }
      setPeerInfo(peerToReveal); 
      wrappedSetChatState('revealed');
      addDebugLog(`Call ended. Transitioning to 'revealed' state with peer ${peerToReveal?.name || peerIdRef.current}.`);
    } else {
        wrappedSetChatState('idle');
        setPeerInfo(null); 
        addDebugLog(`Call ended. Transitioning to 'idle' state.`);
    }
    
    roomIdRef.current = null; 
    if (chatStateRef.current === 'idle') peerIdRef.current = null;
    isCallerRef.current = false;
  }, [cleanupWebRTC, cleanupCallData, onlineUsers, peerInfo, removeFirebaseListener, addDebugLog, wrappedSetChatState]); 

  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    const currentSId = sessionUserIdRef.current;
    if (!currentSId || !currentLocalStream) {
        addDebugLog(`ERROR: InitializePeerConnection: Missing sessionUser ID (${currentSId}) or local stream.`);
        return null;
    }
    addDebugLog(`Initializing RTCPeerConnection.`);
    const pc = new RTCPeerConnection(servers);

    currentLocalStream.getTracks().forEach(track => {
        try { pc.addTrack(track, currentLocalStream); addDebugLog(`Added local track: ${track.kind}`); }
        catch (e: any) { addDebugLog(`ERROR adding local track ${track.kind}: ${e.message || e}`); }
    });

    pc.ontrack = (event) => {
      addDebugLog(`Remote track received: Kind: ${event.track.kind}`);
      if (event.streams && event.streams[0]) setRemoteStream(event.streams[0]);
      else { const newStream = new MediaStream(); newStream.addTrack(event.track); setRemoteStream(newStream); }
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate && roomIdRef.current && currentSId) {
            addDebugLog(`Generated ICE candidate for room ${roomIdRef.current}`);
            const candidatesRefPath = `iceCandidates/${roomIdRef.current}/${currentSId}`;
            push(ref(db, candidatesRefPath), event.candidate.toJSON())
                .catch(e => addDebugLog(`ERROR pushing ICE candidate to ${candidatesRefPath}: ${e.message || e}`));
        } else if (!event.candidate) addDebugLog("ICE gathering complete.");
    };

    pc.oniceconnectionstatechange = () => {
      if (!peerConnectionRef.current) return;
      addDebugLog(`ICE connection state changed: ${peerConnectionRef.current.iceConnectionState}`);
      if (peerConnectionRef.current.iceConnectionState === 'connected') {
        if (['connecting', 'dialing'].includes(chatStateRef.current)) {
            addDebugLog("ICE connected, setting chat state to 'connected'.");
            wrappedSetChatState('connected');
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
        if (!peerConnectionRef.current) return;
        addDebugLog(`Signaling state changed: ${peerConnectionRef.current.signalingState}`);
    };
    return pc;
  }, [handleEndCall, toast, addDebugLog, wrappedSetChatState]); 

  const startLocalStream = useCallback(async (): Promise<MediaStream | null> => {
    addDebugLog(`Attempting to start local stream.`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream); setIsVideoOn(true); setIsMicOn(true);
      addDebugLog(`Local stream started successfully.`);
      return stream;
    } catch (err: any) {
      addDebugLog(`ERROR accessing media devices: ${err.message || err}`);
      toast({ title: "Media Error", description: "Could not access camera/microphone.", variant: "destructive" });
      if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') handleEndCall(false); 
      else wrappedSetChatState('idle'); 
      return null;
    }
  }, [toast, addDebugLog, handleEndCall, wrappedSetChatState]);

  const initiateDirectCall = useCallback(async (targetUser: OnlineUser) => {
    const currentSUser = sessionUser; 
    if (!currentSUser || !currentSUser.id || targetUser.id === currentSUser.id) {
      addDebugLog(`Cannot call self or sessionUser is null.`);
      toast({title: "Call Error", description: "Cannot call self or session is not ready.", variant: "destructive"});
      return;
    }
    
    addDebugLog(`Initiating direct call to ${targetUser.name} (${targetUser.id}).`);
    if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
        addDebugLog(`In non-idle state (${chatStateRef.current}), ending existing call.`);
        await handleEndCall(false); 
    }
    
    wrappedSetChatState('dialing'); setPeerInfo(targetUser); 
    peerIdRef.current = targetUser.id; isCallerRef.current = true;

    const stream = await startLocalStream();
    if (!stream) { await handleEndCall(false); return; }

    const pc = initializePeerConnection(stream);
    if (!pc) { toast({ title: "WebRTC Error", variant: "destructive" }); await handleEndCall(false); return; }
    peerConnectionRef.current = pc;
    
    const newRoomId = push(child(ref(db), 'callRooms')).key; 
    if (!newRoomId) { toast({title: "Error", description: "Could not create room.", variant: "destructive"}); await handleEndCall(false); return; }
    roomIdRef.current = newRoomId;
    addDebugLog(`Assigned new room ID: ${newRoomId} for call with ${targetUser.id}`);

    try {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      addDebugLog(`Offer created for room ${newRoomId}.`);

      const offerPayload: IncomingCallOffer = {
        roomId: newRoomId, offer: pc.localDescription!.toJSON(),
        callerId: currentSUser.id, callerName: currentSUser.name, 
        callerPhotoUrl: currentSUser.photoUrl, callerCountryCode: currentSUser.countryCode,
        callerIsGoogleUser: currentSUser.isGoogleUser,
      };
      const offerPath = `callSignals/${targetUser.id}/pendingOffer`;
      await set(ref(db, offerPath), offerPayload);
      toast({ title: "Calling...", description: `Calling ${targetUser.name}...` });
      addDebugLog(`Offer sent to ${targetUser.id} at ${offerPath}.`);

      const answerPath = `callSignals/${newRoomId}/answer`;
      addFirebaseListener(answerPath, async (snapshot: any) => {
        if (snapshot.exists() && peerConnectionRef.current) { 
          const answerData = snapshot.val() as CallAnswer;
          addDebugLog(`Caller: Received answer from ${answerData.calleeId}.`);
          if (peerConnectionRef.current.signalingState === 'have-local-offer' || peerConnectionRef.current.signalingState === 'stable') { 
            if (peerConnectionRef.current.remoteDescription) addDebugLog(`WARN: Caller: Remote desc already set.`);
            try { await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answerData.answer)); addDebugLog(`Caller: Remote desc (answer) set.`); }
            catch (e: any) { addDebugLog(`ERROR: Caller: setting remote desc: ${e.message || e}`); handleEndCall(false); return; }
            removeFirebaseListener(answerPath); remove(ref(db, answerPath)).catch(e => addDebugLog(`WARN: Error removing answer: ${e.message || e}`));
          } else addDebugLog(`WARN: Caller: Received answer but PC state is ${peerConnectionRef.current.signalingState}.`);
        }
      }, 'value');

      const calleeIcePath = `iceCandidates/${newRoomId}/${targetUser.id}`;
      addFirebaseListener(calleeIcePath, (snapshot: any) => {
        snapshot.forEach((childSnapshot: any) => { // Iterate over children if 'value' is used
            const candidate = childSnapshot.val();
            if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription) { 
                addDebugLog(`Caller: Received ICE candidate object from callee ${targetUser.id}: ${JSON.stringify(candidate)}`);
                if (candidate.candidate && (candidate.sdpMid !== null || candidate.sdpMLineIndex !== null)) { 
                    peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => addDebugLog(`ERROR: Caller adding callee ICE: ${e.message || e}`));
                } else if (candidate.candidate) {
                    addDebugLog(`WARN: Caller: Received ICE with null sdpMid/sdpMLineIndex from callee ${targetUser.id}. Candidate: ${candidate.candidate.substring(0,15)}`);
                }
            } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
                addDebugLog(`WARN: Caller received callee ICE for room ${newRoomId} but remote desc not set.`);
            }
        });
      }, 'value');
    } catch (error: any) {
      addDebugLog(`ERROR initiating call: ${error.message || error}`);
      toast({ title: "Call Error", variant: "destructive" }); await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, removeFirebaseListener, startLocalStream, addDebugLog, wrappedSetChatState]);

  const processIncomingOfferAndAnswer = useCallback(async (offerData: IncomingCallOffer) => {
    const currentSUser = sessionUser; 
    if (!currentSUser || !currentSUser.id || chatStateRef.current !== 'idle') {
      addDebugLog(`processIncomingOffer: State not idle or no sessionUser. Offer from ${offerData.callerId}.`);
      if (currentSUser?.id) remove(ref(db, `callSignals/${currentSUser.id}/pendingOffer`)).catch(e => addDebugLog(`WARN: Callee: Error removing stale pending offer: ${e.message || e}`));
      return;
    }
    addDebugLog(`Processing incoming offer from ${offerData.callerName} (${offerData.callerId}). Room: ${offerData.roomId}.`);

    wrappedSetChatState('connecting'); 
    peerIdRef.current = offerData.callerId; roomIdRef.current = offerData.roomId; isCallerRef.current = false;
    
    const peerForInfo: OnlineUser = {
        id: offerData.callerId, name: offerData.callerName, photoUrl: offerData.callerPhotoUrl,
        countryCode: offerData.callerCountryCode || 'XX', isGoogleUser: offerData.callerIsGoogleUser
    };
    setPeerInfo(peerForInfo);
    toast({ title: "Incoming Call", description: `Connecting to ${offerData.callerName}...` });

    const stream = await startLocalStream();
    if (!stream) { await handleEndCall(false); return; }

    const pc = initializePeerConnection(stream);
    if (!pc) { toast({ title: "WebRTC Error", variant: "destructive" }); await handleEndCall(false); return; }
    peerConnectionRef.current = pc;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerData.offer)); addDebugLog(`Callee: Remote desc (offer) set for room ${offerData.roomId}.`);
      const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); addDebugLog(`Callee: Local desc (answer) set for room ${offerData.roomId}.`);

      const answerPayload: CallAnswer = { answer: pc.localDescription!.toJSON(), calleeId: currentSUser.id, calleeIsGoogleUser: currentSUser.isGoogleUser };
      const answerPath = `callSignals/${offerData.roomId}/answer`;
      await set(ref(db, answerPath), answerPayload); addDebugLog(`Callee: Answer sent to room ${offerData.roomId}.`);
      
      await remove(ref(db, `callSignals/${currentSUser.id}/pendingOffer`)); addDebugLog(`Callee: Removed processed pending offer.`);

      const callerIcePath = `iceCandidates/${offerData.roomId}/${offerData.callerId}`;
      addFirebaseListener(callerIcePath, (snapshot: any) => { // Listen to 'value' and iterate
        snapshot.forEach((childSnapshot: any) => {
            const candidate = childSnapshot.val();
            if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription) { 
                addDebugLog(`Callee: Received ICE candidate object from caller ${offerData.callerId}: ${JSON.stringify(candidate)}`);
                 if (candidate.candidate && (candidate.sdpMid !== null || candidate.sdpMLineIndex !== null)) {
                    peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => addDebugLog(`ERROR: Callee adding caller ICE: ${e.message || e}`));
                } else if (candidate.candidate) {
                    addDebugLog(`WARN: Callee: Received ICE with null sdpMid/sdpMLineIndex from caller ${offerData.callerId}. Candidate: ${candidate.candidate.substring(0,15)}`);
                }
            } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
                addDebugLog(`WARN: Callee received caller ICE for room ${offerData.roomId} but remote desc not set.`);
            }
        });
      }, 'value');
    } catch (error: any) {
      addDebugLog(`Callee: ERROR processing offer for room ${offerData.roomId}: ${error.message || error}`);
      toast({ title: "Call Error", variant: "destructive" }); await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, startLocalStream, addDebugLog, wrappedSetChatState]); 

  // ANONYMOUS Presence system (only if not Google authenticated and anonymousSessionId is set)
  useEffect(() => {
    if (currentUser || !anonymousSessionId) {
      addDebugLog("Skipping anonymous presence: Google user active or anonymousSessionId not ready.");
      return;
    }
    
    // Only proceed if sessionUser is also set and represents the anonymous user
    if (!sessionUser || sessionUser.id !== anonymousSessionId || sessionUser.isGoogleUser) {
      addDebugLog("Skipping anonymous presence: sessionUser not aligned with anonymous state.");
      return;
    }

    const myId = anonymousSessionId;
    const userForPresence = sessionUser; // This should be the anonymous user object

    addDebugLog(`Anonymous Presence: Setting up for ${myId}. Name: ${userForPresence.name}`);
    const userStatusRef: DatabaseReference = ref(db, `onlineUsers/${myId}`);
    const connectedRef = ref(db, '.info/connected');
    let anonConnectedCb: ((snapshot: any) => void) | null = null;


    const presenceConnectionCallback = (snapshot: any) => {
      if (snapshot.val() === true) {
        addDebugLog(`Anonymous Presence: Firebase connection established for ${myId}.`);
        // Ensure userForPresence has latest data, especially countryCode
        const currentAnonUser = sessionUser; // Re-fetch from state in case it updated
        if (currentAnonUser && currentAnonUser.id === myId && !currentAnonUser.isGoogleUser) {
            const presenceData = { ...currentAnonUser, timestamp: serverTimestamp() }; 
            set(userStatusRef, presenceData)
              .then(() => {
                 addDebugLog(`Anonymous Presence: Set online for ${myId}.`);
                 onDisconnect(userStatusRef).remove().catch(e => addDebugLog(`Anonymous Presence: ERROR setting onDisconnect for ${myId}: ${e.message || e}`));
              })
              .catch(e => addDebugLog(`Anonymous Presence: ERROR setting presence for ${myId}: ${e.message || e}`));
        } else {
            addDebugLog(`Anonymous Presence: current sessionUser (${sessionUser?.id}, isGoogle: ${sessionUser?.isGoogleUser}) doesn't match anonymous ID ${myId}. Aborting set online.`);
        }
      } else {
        addDebugLog(`Anonymous Presence: Firebase connection lost for ${myId}.`);
      }
    };
    
    anonConnectedCb = presenceConnectionCallback; // Store for removal
    onValue(connectedRef, anonConnectedCb);
    addDebugLog(`Anonymous Presence: Attached listener to .info/connected for ${myId}`);
    
    return () => {
      addDebugLog(`Anonymous Presence: Cleaning up for session user: ${myId}`);
      if (anonConnectedCb && connectedRef) {
        off(connectedRef, 'value', anonConnectedCb);
        addDebugLog(`Anonymous Presence: Detached .info/connected listener for ${myId}`);
      }
      if (userStatusRef) {
        remove(userStatusRef).catch(e => addDebugLog(`Anonymous Presence: WARN: Error removing user ${myId} on cleanup: ${e.message || e}`));
      }
    };
  }, [currentUser, anonymousSessionId, sessionUser, addDebugLog]); // addFirebaseListener/remove removed


  // Listener for all online users
  useEffect(() => {
    const onlineUsersRefPath = 'onlineUsers';
    const onlineUsersListenerCallback = (snapshot: any) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = usersData ? Object.values(usersData) : [];
      const activeUserId = sessionUserIdRef.current; 
      setOnlineUsers(userList.filter(u => u.id !== activeUserId)); 
      // addDebugLog(`Online users updated: ${userList.filter(u => u.id !== activeUserId).length} other users.`); // Can be noisy
    };
    addFirebaseListener(onlineUsersRefPath, onlineUsersListenerCallback, 'value');
    return () => removeFirebaseListener(onlineUsersRefPath);
  }, [addFirebaseListener, removeFirebaseListener, addDebugLog]);


  // Listener for incoming calls (auto-accepted)
  useEffect(() => {
    const currentActiveUserId = sessionUserIdRef.current;
    if (!currentActiveUserId) {
        addDebugLog(`Incoming call listener: No active user ID, cannot attach listener.`);
        return;
    }
    
    const incomingCallPath = `callSignals/${currentActiveUserId}/pendingOffer`;
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
          // addDebugLog(`Offer listener at ${incomingCallPath} received null data (offer likely removed/processed).`); // Can be noisy
      }
    };
    
    addFirebaseListener(incomingCallPath, incomingCallListenerCallback, 'value');
    return () => removeFirebaseListener(incomingCallPath);
  // Rerun if sessionUser.id (via sessionUserIdRef.current) changes, or if processIncomingOfferAndAnswer reference changes.
  }, [sessionUserIdRef.current, processIncomingOfferAndAnswer, addFirebaseListener, removeFirebaseListener, addDebugLog]); 


  // Cleanup effect for component unmount
  useEffect(() => {
    const myCurrentSessionIdOnUnmount = sessionUserIdRef.current; 
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
    wrappedSetChatState('idle'); setPeerInfo(null);
    peerIdRef.current = null; roomIdRef.current = null; isCallerRef.current = false;
    cleanupWebRTC(); await cleanupCallData(); 
  };

  const toggleMic = () => {
    if (localStream) {
      const audioEnabled = !isMicOn;
      localStream.getAudioTracks().forEach(track => track.enabled = audioEnabled);
      setIsMicOn(audioEnabled); addDebugLog(`Mic toggled to: ${audioEnabled ? 'ON' : 'OFF'}`);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const videoEnabled = !isVideoOn;
      localStream.getVideoTracks().forEach(track => track.enabled = videoEnabled);
      setIsVideoOn(videoEnabled); addDebugLog(`Video toggled to: ${videoEnabled ? 'ON' : 'OFF'}`);
    }
  };

  const handleFeelingLucky = () => {
    if (!sessionUser) { toast({ title: "Error", variant: "destructive"}); return; }
    const otherUsers = onlineUsers.filter(u => u.id !== sessionUser.id);
    if (otherUsers.length === 0) {
        toast({ title: "No Users Online", variant: "default"}); addDebugLog("Feeling Lucky: No other users online.");
        return;
    }
    const randomUser = otherUsers[Math.floor(Math.random() * otherUsers.length)];
    addDebugLog(`Feeling Lucky: Calling random user ${randomUser.name} (${randomUser.id})`);
    initiateDirectCall(randomUser);
  };

  if (pageLoading) {
    return (
      <MainLayout>
        <div className="flex flex-col items-center gap-4 p-8 bg-card rounded-xl shadow-lg w-full max-w-lg">
          <Skeleton className="h-20 w-20 rounded-full" />
          <Skeleton className="h-6 w-[280px] mt-3" />
          <Skeleton className="h-4 w-[200px] mt-1" />
          <p className="mt-4 text-muted-foreground">
            {authLoading && !currentUser ? "Authenticating..." : "Initializing your session..."}
          </p>
        </div>
      </MainLayout>
    );
  }
  
  if (!sessionUser) { // Should ideally not happen if pageLoading is false
    return (
       <MainLayout><p>Error: Session could not be initialized. Please refresh.</p></MainLayout>
    );
  }


  return (
    <MainLayout>
      <div className="absolute top-4 right-4 flex gap-2">
        {!currentUser ? (
          <Button onClick={signInWithGoogle} variant="outline">
            <LogIn className="mr-2 h-4 w-4" /> Sign in with Google
          </Button>
        ) : (
          <Button onClick={signOutUser} variant="outline">
            <LogOut className="mr-2 h-4 w-4" /> Sign Out
          </Button>
        )}
      </div>

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
                <CardTitle className="text-xl">
                  {sessionUser.name}
                  {sessionUser.isGoogleUser && <span className="text-xs text-blue-500 ml-1">(Google)</span>}
                  {sessionUser.countryCode && ` (${sessionUser.countryCode})`}
                </CardTitle>
                <CardDescription className="text-sm text-muted-foreground">Your current ID: {sessionUser.id}</CardDescription>
            </CardHeader>
          </Card>
          <div className="w-full mt-4">
            <OnlineUsersPanel 
                onlineUsers={onlineUsers} 
                onInitiateCall={initiateDirectCall}
                currentUserId={sessionUser.id}
            />
          </div>
          {onlineUsers.filter(u => u.id !== sessionUser?.id).length > 0 && (
             <Button onClick={handleFeelingLucky} size="lg" className="mt-4 w-full max-w-xs">
                <Shuffle className="mr-2 h-5 w-5" />
                Feeling Lucky? (Random Call)
            </Button>
          )}
        </div>
      )}

      {(chatState === 'dialing' || chatState === 'connecting' || chatState === 'connected') && (
        <div className="w-full flex flex-col items-center gap-6">
          <VideoChatPlaceholder
            localStream={localStream} remoteStream={remoteStream}
            isMicOn={isMicOn} isVideoOn={isVideoOn}
            onToggleMic={toggleMic} onToggleVideo={toggleVideo}
            chatState={chatState}
            peerName={peerInfo?.name || (chatState === 'dialing' ? 'Dialing...' : (chatState === 'connecting' ? 'Connecting...' : 'Peer'))}
          />
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
            <Button onClick={() => handleEndCall(true)} size="lg" className="flex-1" variant="destructive">
              <PhoneOff className="mr-2 h-5 w-5" /> End Call
            </Button>
             {chatState === 'connected' && peerInfo && currentUser && ( 
                <ReportDialog
                reportedUser={{id: peerInfo.id, name: peerInfo.name, photoUrl: peerInfo.photoUrl || '', bio: ''}} 
                triggerButtonText="Report User" triggerButtonVariant="outline" triggerButtonFullWidth={true}
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
              <p className="text-muted-foreground">
                You chatted with {peerInfo.name}
                {peerInfo.isGoogleUser && <span className="text-xs text-blue-500 ml-1">(Google)</span>}
                {peerInfo.countryCode && ` (${peerInfo.countryCode})`}.
              </p>
              <Card className="w-full max-w-sm p-6 bg-background shadow-lg rounded-xl border-primary/50">
                <div className="flex flex-col items-center text-center">
                    <Avatar className="w-24 h-24 mb-4 border-2 border-primary shadow-md">
                        <AvatarImage src={peerInfo.photoUrl} alt={peerInfo.name} data-ai-hint="avatar abstract"/>
                        <AvatarFallback>{peerInfo.name.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <h3 className="text-2xl font-semibold">{peerInfo.name}</h3>
                    <p className="text-sm text-muted-foreground">ID: {peerInfo.id} {peerInfo.countryCode && `(${peerInfo.countryCode})`}</p>
                </div>
              </Card>
            </>
          ) : ( <p className="text-muted-foreground">The other user's information could not be loaded.</p> )}
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mt-4">
            <Button onClick={handleBackToOnlineUsers} size="lg" variant="secondary" className="flex-1">
              <VideoIcon className="mr-2 h-5 w-5" /> Back to Online Users
            </Button>
            {peerInfo && currentUser && ( 
                 <ReportDialog
                 reportedUser={{id: peerInfo.id, name: peerInfo.name, photoUrl: peerInfo.photoUrl || '', bio: ''}} 
                 triggerButtonText={`Report ${peerInfo.name}`} triggerButtonVariant="destructive" triggerButtonFullWidth={true}
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
