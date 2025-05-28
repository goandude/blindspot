
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { ProfileSetupDialog } from '@/components/features/profile/profile-setup-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { OnlineUser, IncomingCallOffer, CallAnswer, UserProfile } from '@/types';
import { PhoneOff, Video as VideoIcon, Shuffle, LogIn, LogOut, Edit3 } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, push, child, serverTimestamp, type DatabaseReference, get } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { OnlineUsersPanel } from '@/components/features/online-users/online-users-panel';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { DebugLogPanel } from '@/components/features/debug/debug-log-panel';
import { useAuth } from '@/hooks/use-auth'; // Assuming this hook handles Google Auth

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
  // sessionUser is the active identity for the current session (either anonymous or Google user)
  const [sessionUser, setSessionUser] = useState<OnlineUser | null>(null);

  const [chatState, setChatState] = useState<ChatState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [peerInfo, setPeerInfo] = useState<OnlineUser | UserProfile | null>(null); // Can be OnlineUser or full UserProfile post-reveal
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [pageLoading, setPageLoading] = useState(true); // Unified loading state
  const [isProfileEditDialogOpen, setIsProfileEditDialogOpen] = useState(false);


  const { toast } = useToast();
  const { 
    currentUser: authCurrentUser, 
    userProfile: authUserProfile, 
    loading: authLoading, 
    profileLoading: authProfileLoading,
    isProfileSetupNeeded,
    signInWithGoogle, 
    signOutUser,
    updateUserProfile
  } = useAuth();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null); // ID of the peer in the current call
  const isCallerRef = useRef<boolean>(false);
  
  const firebaseListeners = useRef<Map<string, { ref: DatabaseReference, callback: (snapshot: any) => void, eventType: string }>>(new Map());
  const chatStateRef = useRef<ChatState>(chatState);
  const currentSessionUserIdRef = useRef<string | null>(null);


  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const currentSId = currentSessionUserIdRef.current; 
    let prefix = currentSId ? `[${currentSId.substring(0,4)}] ` : '[N/A] ';
    const logEntry = `[${timestamp}] ${prefix}${message}`;
    setDebugLogs(prevLogs => [logEntry, ...prevLogs].slice(0, 100)); 
  }, []);

  useEffect(() => {
    chatStateRef.current = chatState;
  }, [chatState]);

  // 1. Initialize anonymous session ID (runs once)
  useEffect(() => {
    const newAnonId = generateAnonymousSessionId();
    setAnonymousSessionId(newAnonId);
    // addDebugLog(`Generated new anonymous session ID: ${newAnonId}`); // Logged when anon user is created
  }, []);

  // 2. Determine and set the active sessionUser (anonymous or authenticated)
  useEffect(() => {
    addDebugLog(`Auth state update: authLoading=${authLoading}, authProfileLoading=${authProfileLoading}, authCurrentUser=${authCurrentUser?.uid}, isProfileSetupNeeded=${isProfileSetupNeeded}, anonymousSessionId=${anonymousSessionId}`);

    if (authLoading) {
      addDebugLog("Auth state is loading (authLoading=true), page remains in loading state.");
      setPageLoading(true);
      return;
    }
    
    // If auth is done, but profile is still loading (e.g. for new user creation)
    if (authCurrentUser && authProfileLoading) {
        addDebugLog(`Auth user ${authCurrentUser.uid} present, but profile is loading (authProfileLoading=true). Page remains loading.`);
        setPageLoading(true);
        return;
    }

    if (authCurrentUser && authUserProfile && !isProfileSetupNeeded) {
      addDebugLog(`Google user authenticated and profile ready: ${authUserProfile.name} (${authCurrentUser.uid}). Setting as sessionUser.`);
      const googleSessionUser: OnlineUser = {
        id: authCurrentUser.uid,
        name: authUserProfile.name,
        photoUrl: authUserProfile.photoUrl,
        countryCode: authUserProfile.countryCode,
        isGoogleUser: true,
      };
      setSessionUser(googleSessionUser);
      currentSessionUserIdRef.current = authCurrentUser.uid;
      setPageLoading(false);
      addDebugLog(`Active session user (Google): ${googleSessionUser.name} (${googleSessionUser.id})`);
    } else if (authCurrentUser && isProfileSetupNeeded) {
      addDebugLog(`Google user ${authCurrentUser.uid} authenticated, but profile setup is needed. Page loading false, ProfileSetupDialog should show.`);
      setPageLoading(false); // Stop page loading to allow ProfileSetupDialog to show
      // sessionUser will be set once profile is submitted, or if dialog is cancelled, might revert to anonymous
    } else if (!authCurrentUser && anonymousSessionId) {
      addDebugLog(`No Google user. Initializing anonymous session with ID: ${anonymousSessionId}.`);
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
        currentSessionUserIdRef.current = anonymousSessionId;
        setPageLoading(false);
        addDebugLog(`Anonymous session user created: ${anonUser.name} (${anonUser.id}) with country ${anonUser.countryCode}`);
      };
      fetchCountryAndSetAnonymousUser();
    } else if (!authCurrentUser && !anonymousSessionId) {
        addDebugLog("Waiting for anonymous session ID to be generated. Page loading true.");
        setPageLoading(true);
    } else {
        addDebugLog("Fell through sessionUser determination logic. Setting pageLoading to false.");
        setPageLoading(false); // Default to not loading if no other specific loading state
    }
  }, [authCurrentUser, authUserProfile, anonymousSessionId, authLoading, authProfileLoading, isProfileSetupNeeded, addDebugLog]);


  const wrappedSetChatState = useCallback((newState: ChatState) => {
    addDebugLog(`Chat state changing from ${chatStateRef.current} to: ${newState}`);
    setChatState(newState);
  }, [addDebugLog]);


  const removeFirebaseListener = useCallback((path: string) => {
    const listenerEntry = firebaseListeners.current.get(path);
    if (listenerEntry) {
        try {
            off(listenerEntry.ref, listenerEntry.eventType, listenerEntry.callback);
            addDebugLog(`Successfully removed Firebase listener for path: ${path} (type: ${listenerEntry.eventType})`);
        } catch (error: any) {
            addDebugLog(`WARN: Error unsubscribing Firebase listener for path ${path} (type: ${listenerEntry.eventType}): ${error.message || error}`);
        }
        firebaseListeners.current.delete(path);
    }
  }, [addDebugLog]);

  const addFirebaseListener = useCallback((dbRef: DatabaseReference, listenerFunc: (snapshot: any) => void, eventType: string = 'value') => {
    const path = dbRef.toString().substring(dbRef.root.toString().length -1); // Get path relative to root
    if (firebaseListeners.current.has(path)) {
        addDebugLog(`Listener for path ${path} (type: ${eventType}) already exists. Removing old one first.`);
        removeFirebaseListener(path);
    }
    
    const actualCallback = (snapshot: any) => listenerFunc(snapshot);
    
    onValue(dbRef, actualCallback, (error) => {
        addDebugLog(`ERROR reading from ${path} (event: ${eventType}): ${error.message}`);
        toast({ title: "Firebase Error", description: `Failed to listen to ${path}. Check console.`, variant: "destructive" });
    });
        
    firebaseListeners.current.set(path, { ref: dbRef, callback: actualCallback, eventType });
    addDebugLog(`Added Firebase listener for path: ${path} with eventType: ${eventType}`);
  }, [addDebugLog, toast, removeFirebaseListener]); 


  const cleanupAllFirebaseListeners = useCallback(() => {
    addDebugLog(`Cleaning up ALL (${firebaseListeners.current.size}) Firebase listeners.`);
    firebaseListeners.current.forEach((listenerEntry, path) => {
      try {
        off(listenerEntry.ref, listenerEntry.eventType, listenerEntry.callback);
        addDebugLog(`Cleaned up listener for ${path} (type: ${listenerEntry.eventType})`);
      } catch (error: any) {
        addDebugLog(`WARN: Error unsubscribing Firebase listener during general cleanup for path: ${path} - ${error.message || error}`);
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
      });
      if (peerConnectionRef.current.signalingState !== 'closed') {
        peerConnectionRef.current.close();
      }
      peerConnectionRef.current = null;
      addDebugLog(`Peer connection closed.`);
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
      addDebugLog(`Local stream stopped.`);
    }
    setRemoteStream(null);
  }, [localStream, addDebugLog]);

  const cleanupCallData = useCallback(async () => {
    const myId = currentSessionUserIdRef.current; 
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
    const myCurrentId = currentSessionUserIdRef.current;
    const currentPeerIdVal = peerIdRef.current;
    const currentRoomIdVal = roomIdRef.current;

    addDebugLog(`Handling end call. MyID: ${myCurrentId}, PeerID: ${currentPeerIdVal}, RoomID: ${currentRoomIdVal}. Show reveal: ${showReveal}. Current chat state: ${chatStateRef.current}.`);
    const wasConnected = ['connected', 'connecting', 'dialing'].includes(chatStateRef.current);
    
    cleanupWebRTC(); 
    
    if (currentRoomIdVal) {
        removeFirebaseListener(`callSignals/${currentRoomIdVal}/answer`);
        if (currentPeerIdVal) removeFirebaseListener(`iceCandidates/${currentRoomIdVal}/${currentPeerIdVal}`);
        if (myCurrentId) removeFirebaseListener(`iceCandidates/${currentRoomIdVal}/${myCurrentId}`);
    }
    if (myCurrentId) removeFirebaseListener(`callSignals/${myCurrentId}/pendingOffer`);

    await cleanupCallData(); 

    if (showReveal && currentPeerIdVal && wasConnected) {
      let peerToReveal: OnlineUser | UserProfile | null = onlineUsers.find(u => u.id === currentPeerIdVal) || 
                         (peerInfo?.id === currentPeerIdVal ? peerInfo : null);
      
      if (!peerToReveal) { // Construct minimal if not found in onlineUsers or current peerInfo
        addDebugLog(`Peer ${currentPeerIdVal} not in onlineUsers or peerInfo. Constructing minimal peer info.`);
        const tempPeerIsGoogleUser = (await get(ref(db, `users/${currentPeerIdVal}`))).exists(); // Quick check if it's a Google user
        peerToReveal = {
          id: currentPeerIdVal,
          name: `User-${currentPeerIdVal.substring(0,4)}`,
          photoUrl: `https://placehold.co/96x96.png?text=${currentPeerIdVal.charAt(0).toUpperCase()}`,
          countryCode: 'XX',
          isGoogleUser: tempPeerIsGoogleUser 
        };
      }
      setPeerInfo(peerToReveal); 
      wrappedSetChatState('revealed');
      addDebugLog(`Call ended. Transitioning to 'revealed' state with peer ${peerToReveal?.name || currentPeerIdVal}.`);
    } else {
        wrappedSetChatState('idle');
        setPeerInfo(null); 
        addDebugLog(`Call ended. Transitioning to 'idle' state (no reveal or peerId missing/not connected).`);
    }
    
    roomIdRef.current = null; 
    if (chatStateRef.current === 'idle' || chatStateRef.current === 'revealed') { // Clear peerId if truly idle or after reveal
        peerIdRef.current = null;
    }
    isCallerRef.current = false;
  }, [cleanupWebRTC, cleanupCallData, onlineUsers, peerInfo, removeFirebaseListener, addDebugLog, wrappedSetChatState]); 

  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    const myId = currentSessionUserIdRef.current;
    if (!myId || !currentLocalStream) {
        addDebugLog(`ERROR: InitializePeerConnection: Missing sessionUser ID (${myId}) or local stream.`);
        return null;
    }
    addDebugLog(`Initializing RTCPeerConnection for user ${myId}.`);
    const pc = new RTCPeerConnection(servers);

    currentLocalStream.getTracks().forEach(track => {
        try { pc.addTrack(track, currentLocalStream); addDebugLog(`Added local track: ${track.kind}`); }
        catch (e: any) { addDebugLog(`ERROR adding local track ${track.kind}: ${e.message || e}`); }
    });

    pc.ontrack = (event) => {
      addDebugLog(`Remote track received: Kind: ${event.track.kind}. Stream(s): ${event.streams.length}`);
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
        addDebugLog(`Remote stream set from event.streams[0].`);
      } else { 
        const newStream = new MediaStream(); 
        newStream.addTrack(event.track); 
        setRemoteStream(newStream); 
        addDebugLog(`Remote stream created from event.track and set.`);
      }
    };
    
    pc.onicecandidate = (event) => {
        const currentRoom = roomIdRef.current;
        if (event.candidate && currentRoom && myId) {
            addDebugLog(`Generated ICE candidate for room ${currentRoom}: ${event.candidate.candidate.substring(0,30)}...`);
            const candidatesRefPath = `iceCandidates/${currentRoom}/${myId}`;
            push(ref(db, candidatesRefPath), event.candidate.toJSON())
                .catch(e => addDebugLog(`ERROR pushing ICE candidate to ${candidatesRefPath}: ${e.message || e}`));
        } else if (!event.candidate) {
            addDebugLog("ICE gathering complete.");
        }
    };

    pc.oniceconnectionstatechange = () => {
      if (!peerConnectionRef.current) return;
      const iceState = peerConnectionRef.current.iceConnectionState;
      addDebugLog(`ICE connection state changed: ${iceState}`);
      if (iceState === 'connected' || iceState === 'completed') {
        if (['connecting', 'dialing'].includes(chatStateRef.current)) {
            addDebugLog("ICE fully connected/completed, setting chat state to 'connected'.");
            wrappedSetChatState('connected');
        }
      } else if (['failed', 'disconnected', 'closed'].includes(iceState)) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
          addDebugLog(`ICE state: ${iceState}. Ending call (showReveal=false).`);
          toast({ title: "Connection Issue", description: `Call state: ${iceState}. Ending call.`, variant: "default" });
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
    const myId = currentSessionUserIdRef.current;
    addDebugLog(`Attempting to start local stream for ${myId}.`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream); setIsVideoOn(true); setIsMicOn(true);
      addDebugLog(`Local stream started successfully for ${myId}.`);
      return stream;
    } catch (err: any) {
      addDebugLog(`ERROR accessing media devices for ${myId}: ${err.message || err}`);
      toast({ title: "Media Error", description: "Could not access camera/microphone.", variant: "destructive" });
      if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') handleEndCall(false); 
      else wrappedSetChatState('idle'); 
      return null;
    }
  }, [toast, addDebugLog, handleEndCall, wrappedSetChatState]);

  const initiateDirectCall = useCallback(async (targetUser: OnlineUser) => {
    const sUser = sessionUser; 
    if (!sUser || !sUser.id || targetUser.id === sUser.id) {
      addDebugLog(`Cannot call self or sessionUser is null. MyID: ${sUser?.id}, TargetID: ${targetUser.id}`);
      toast({title: "Call Error", description: "Cannot call self or session is not ready.", variant: "destructive"});
      return;
    }
    
    addDebugLog(`Initiating direct call from ${sUser.id} to ${targetUser.name} (${targetUser.id}).`);
    if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
        addDebugLog(`In non-idle state (${chatStateRef.current}), ending existing call before initiating new one.`);
        await handleEndCall(false); 
    }
    
    wrappedSetChatState('dialing'); setPeerInfo(targetUser); 
    peerIdRef.current = targetUser.id; isCallerRef.current = true;

    const stream = await startLocalStream();
    if (!stream) { addDebugLog("Failed to start local stream, aborting call."); await handleEndCall(false); return; }

    const pc = initializePeerConnection(stream);
    if (!pc) { addDebugLog("Failed to initialize peer connection."); toast({ title: "WebRTC Error", variant: "destructive" }); await handleEndCall(false); return; }
    peerConnectionRef.current = pc;
    
    const newRoomId = push(child(ref(db), 'callRooms')).key; 
    if (!newRoomId) { addDebugLog("Could not create room ID."); toast({title: "Error", description: "Could not create room.", variant: "destructive"}); await handleEndCall(false); return; }
    roomIdRef.current = newRoomId;
    addDebugLog(`Assigned new room ID: ${newRoomId} for call between ${sUser.id} and ${targetUser.id}`);

    try {
      const offer = await pc.createOffer(); 
      await pc.setLocalDescription(offer);
      addDebugLog(`Offer created and local description set for room ${newRoomId}.`);

      const offerPayload: IncomingCallOffer = {
        roomId: newRoomId, offer: pc.localDescription!.toJSON(),
        callerId: sUser.id, callerName: sUser.name, 
        callerPhotoUrl: sUser.photoUrl, callerCountryCode: sUser.countryCode,
        callerIsGoogleUser: sUser.isGoogleUser || false,
      };
      const offerPath = `callSignals/${targetUser.id}/pendingOffer`;
      await set(ref(db, offerPath), offerPayload);
      toast({ title: "Calling...", description: `Calling ${targetUser.name}...` });
      addDebugLog(`Offer sent to ${targetUser.id} at ${offerPath}. Payload: ${JSON.stringify(offerPayload)}`);

      const answerDbRef = ref(db, `callSignals/${newRoomId}/answer`);
      addFirebaseListener(answerDbRef, async (snapshot: any) => {
        if (snapshot.exists() && peerConnectionRef.current && peerConnectionRef.current.signalingState !== 'closed') { 
          const answerData = snapshot.val() as CallAnswer;
          addDebugLog(`Caller: Received answer from ${answerData.calleeId} for room ${newRoomId}. Answer: ${JSON.stringify(answerData.answer)}`);
          if (peerConnectionRef.current.remoteDescription) {
             addDebugLog(`WARN: Caller: Remote description already set for room ${newRoomId}. Current remote: ${JSON.stringify(peerConnectionRef.current.remoteDescription)}`);
          }
          try { 
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answerData.answer)); 
            addDebugLog(`Caller: Remote desc (answer) set successfully for room ${newRoomId}.`); 
          } catch (e: any) { 
            addDebugLog(`ERROR: Caller: setting remote desc (answer) for room ${newRoomId}: ${e.message || e}. PC State: ${peerConnectionRef.current.signalingState}`); 
            handleEndCall(false); 
            return; 
          }
          removeFirebaseListener(answerDbRef.toString().substring(answerDbRef.root.toString().length-1)); 
          remove(answerDbRef).catch(e => addDebugLog(`WARN: Error removing answer from ${answerDbRef.toString()}: ${e.message || e}`));
        } else if (snapshot.exists() && (!peerConnectionRef.current || peerConnectionRef.current.signalingState === 'closed')) {
            addDebugLog(`Caller: Received answer for room ${newRoomId}, but peer connection is null or closed. Ignoring.`);
        }
      }, 'value');

      const calleeIceCandidatesRef = ref(db, `iceCandidates/${newRoomId}/${targetUser.id}`);
      addFirebaseListener(calleeIceCandidatesRef, (snapshot: any) => {
        snapshot.forEach((childSnapshot: any) => {
            const candidate = childSnapshot.val();
            if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription && peerConnectionRef.current.signalingState !== 'closed') { 
                addDebugLog(`Caller: Received ICE candidate object from callee ${targetUser.id} for room ${newRoomId}: ${JSON.stringify(candidate)}`);
                if (candidate.candidate && (candidate.sdpMid !== null || candidate.sdpMLineIndex !== null)) { 
                    peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                        .catch(e => addDebugLog(`ERROR: Caller adding callee ICE for room ${newRoomId}: ${e.message || e}`));
                } else if (candidate.candidate) {
                    addDebugLog(`WARN: Caller: Received ICE with null sdpMid/sdpMLineIndex from callee ${targetUser.id} for room ${newRoomId}. Candidate: ${candidate.candidate.substring(0,15)}`);
                } else {
                    addDebugLog(`INFO: Caller: Received null/empty ICE candidate from callee ${targetUser.id} for room ${newRoomId}. Possibly end-of-candidates marker if not filtered by sender.`);
                }
            } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
                addDebugLog(`WARN: Caller received callee ICE for room ${newRoomId} but remote desc not set. Buffering or investigate timing.`);
            } else if (candidate && (!peerConnectionRef.current || peerConnectionRef.current.signalingState === 'closed')){
                 addDebugLog(`WARN: Caller received callee ICE for room ${newRoomId} but peer connection is null or closed.`);
            }
        });
      }, 'value'); // Use value and iterate, child_added might be too complex if order is not critical

    } catch (error: any) {
      addDebugLog(`ERROR initiating call from ${sUser.id} to ${targetUser.id} (room ${roomIdRef.current}): ${error.message || error}`);
      toast({ title: "Call Error", variant: "destructive", description: "Could not initiate call." }); 
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, removeFirebaseListener, startLocalStream, addDebugLog, wrappedSetChatState]);

  const processIncomingOfferAndAnswer = useCallback(async (offerData: IncomingCallOffer) => {
    const sUser = sessionUser; 
    if (!sUser || !sUser.id ) {
      addDebugLog(`processIncomingOffer: No sessionUser, cannot process offer from ${offerData.callerId}.`);
      if(sUser?.id) remove(ref(db, `callSignals/${sUser.id}/pendingOffer`)).catch(e => addDebugLog(`WARN: Callee: Error removing stale pending offer (no sessionUser): ${e.message || e}`));
      return;
    }
     if (chatStateRef.current !== 'idle') {
      addDebugLog(`processIncomingOffer: Callee ${sUser.id} not idle (state: ${chatStateRef.current}). Offer from ${offerData.callerId} for room ${offerData.roomId} will be ignored and removed.`);
      remove(ref(db, `callSignals/${sUser.id}/pendingOffer`)).catch(e => addDebugLog(`WARN: Callee: Error removing pending offer (not idle): ${e.message || e}`));
      return;
    }
    addDebugLog(`Callee ${sUser.id}: Processing incoming offer from ${offerData.callerName} (${offerData.callerId}). Room: ${offerData.roomId}.`);

    wrappedSetChatState('connecting'); 
    peerIdRef.current = offerData.callerId; roomIdRef.current = offerData.roomId; isCallerRef.current = false;
    
    const peerForInfo: OnlineUser = {
        id: offerData.callerId, name: offerData.callerName, photoUrl: offerData.callerPhotoUrl,
        countryCode: offerData.callerCountryCode || 'XX', isGoogleUser: offerData.callerIsGoogleUser || false,
    };
    setPeerInfo(peerForInfo);
    toast({ title: "Incoming Call", description: `Connecting to ${offerData.callerName}...` });

    const stream = await startLocalStream();
    if (!stream) { addDebugLog(`Callee ${sUser.id}: Failed to start local stream, aborting call for room ${offerData.roomId}.`); await handleEndCall(false); return; }

    const pc = initializePeerConnection(stream);
    if (!pc) { addDebugLog(`Callee ${sUser.id}: Failed to initialize peer connection for room ${offerData.roomId}.`); toast({ title: "WebRTC Error", variant: "destructive" }); await handleEndCall(false); return; }
    peerConnectionRef.current = pc;

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offerData.offer)); 
      addDebugLog(`Callee ${sUser.id}: Remote desc (offer) set for room ${offerData.roomId}.`);
      const answer = await pc.createAnswer(); 
      await pc.setLocalDescription(answer); 
      addDebugLog(`Callee ${sUser.id}: Local desc (answer) set for room ${offerData.roomId}.`);

      const answerPayload: CallAnswer = { 
        answer: pc.localDescription!.toJSON(), 
        calleeId: sUser.id,
        calleeIsGoogleUser: sUser.isGoogleUser || false,
      };
      const answerPath = `callSignals/${offerData.roomId}/answer`;
      await set(ref(db, answerPath), answerPayload); 
      addDebugLog(`Callee ${sUser.id}: Answer sent to room ${offerData.roomId}. Payload: ${JSON.stringify(answerPayload)}`);
      
      const myOfferPath = `callSignals/${sUser.id}/pendingOffer`;
      await remove(ref(db, myOfferPath)); 
      addDebugLog(`Callee ${sUser.id}: Removed processed pending offer from ${myOfferPath}.`);

      const callerIceCandidatesRef = ref(db, `iceCandidates/${offerData.roomId}/${offerData.callerId}`);
      addFirebaseListener(callerIceCandidatesRef, (snapshot: any) => {
        snapshot.forEach((childSnapshot: any) => {
            const candidate = childSnapshot.val();
            if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription && peerConnectionRef.current.signalingState !== 'closed') { 
                addDebugLog(`Callee ${sUser.id}: Received ICE candidate object from caller ${offerData.callerId} for room ${offerData.roomId}: ${JSON.stringify(candidate)}`);
                 if (candidate.candidate && (candidate.sdpMid !== null || candidate.sdpMLineIndex !== null)) {
                    peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                        .catch(e => addDebugLog(`ERROR: Callee ${sUser.id} adding caller ICE for room ${offerData.roomId}: ${e.message || e}`));
                } else if (candidate.candidate) {
                    addDebugLog(`WARN: Callee ${sUser.id}: Received ICE with null sdpMid/sdpMLineIndex from caller ${offerData.callerId} for room ${offerData.roomId}. Candidate: ${candidate.candidate.substring(0,15)}`);
                } else {
                    addDebugLog(`INFO: Callee ${sUser.id}: Received null/empty ICE candidate from caller ${offerData.callerId} for room ${offerData.roomId}.`);
                }
            } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
                addDebugLog(`WARN: Callee ${sUser.id} received caller ICE for room ${offerData.roomId} but remote desc not set.`);
            } else if (candidate && (!peerConnectionRef.current || peerConnectionRef.current.signalingState === 'closed')) {
                 addDebugLog(`WARN: Callee ${sUser.id} received caller ICE for room ${offerData.roomId} but peer connection is null or closed.`);
            }
        });
      }, 'value');
    } catch (error: any) {
      addDebugLog(`Callee ${sUser.id}: ERROR processing offer for room ${offerData.roomId}: ${error.message || error}`);
      toast({ title: "Call Error", variant: "destructive", description: "Could not process incoming call." }); 
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, startLocalStream, addDebugLog, wrappedSetChatState, removeFirebaseListener]); 

  // ANONYMOUS Presence system (only if not Google authenticated)
  useEffect(() => {
    if (authCurrentUser || !anonymousSessionId) {
      addDebugLog("Anonymous Presence: Skipping - Google user active or anonymousSessionId not ready.");
      return;
    }
    
    if (!sessionUser || sessionUser.id !== anonymousSessionId || sessionUser.isGoogleUser) {
      addDebugLog(`Anonymous Presence: Skipping - sessionUser (${sessionUser?.id}, isGoogle: ${sessionUser?.isGoogleUser}) not aligned with anonymous state (${anonymousSessionId}).`);
      return;
    }

    const myId = anonymousSessionId;
    const userForPresence = sessionUser; 

    addDebugLog(`Anonymous Presence: Setting up for ${myId}. Name: ${userForPresence.name}, Country: ${userForPresence.countryCode}`);
    const userStatusDbRef: DatabaseReference = ref(db, `onlineUsers/${myId}`);
    const connectedDbRef = ref(db, '.info/connected');
    
    const presenceCb = (snapshot: any) => {
      if (snapshot.val() === true) {
        addDebugLog(`Anonymous Presence: Firebase connection established for ${myId}.`);
        const currentAnonUser = sessionUser; 
        if (currentAnonUser && currentAnonUser.id === myId && !currentAnonUser.isGoogleUser) {
            const presenceData: OnlineUser = { 
              ...currentAnonUser, 
              timestamp: serverTimestamp() 
            }; 
            set(userStatusDbRef, presenceData)
              .then(() => addDebugLog(`Anonymous Presence: Set online for ${myId} with data: ${JSON.stringify(presenceData)}.`))
              .catch(e => addDebugLog(`Anonymous Presence: ERROR setting presence for ${myId}: ${e.message || e}`));
            userStatusDbRef.onDisconnect().remove()
              .then(() => addDebugLog(`Anonymous Presence: onDisconnect().remove() set for ${myId}.`))
              .catch(e => addDebugLog(`Anonymous Presence: ERROR setting onDisconnect for ${myId}: ${e.message || e}`));
        } else {
            addDebugLog(`Anonymous Presence: current sessionUser (${sessionUser?.id}, isGoogle: ${sessionUser?.isGoogleUser}) doesn't match anonymous ID ${myId} during connected event. Aborting set online.`);
        }
      } else {
        addDebugLog(`Anonymous Presence: Firebase connection lost for ${myId}.`);
      }
    };
    
    addFirebaseListener(connectedDbRef, presenceCb, 'value');
    
    return () => {
      addDebugLog(`Anonymous Presence: Cleaning up for session user: ${myId}. Detaching .info/connected listener.`);
      removeFirebaseListener(connectedDbRef.toString().substring(connectedDbRef.root.toString().length-1));
      // Let onDisconnect handle removal from onlineUsers. Explicit removal here might be too soon.
      // if (userStatusDbRef) {
      //   remove(userStatusDbRef).catch(e => addDebugLog(`Anonymous Presence: WARN: Error removing user ${myId} on cleanup: ${e.message || e}`));
      // }
    };
  }, [authCurrentUser, anonymousSessionId, sessionUser, addFirebaseListener, removeFirebaseListener, addDebugLog]);


  // Listener for all online users
  useEffect(() => {
    const onlineUsersDbRef = ref(db, 'onlineUsers');
    const onlineUsersCb = (snapshot: any) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = usersData ? Object.values(usersData) : [];
      const activeUserId = currentSessionUserIdRef.current; 
      setOnlineUsers(userList.filter(u => u.id !== activeUserId)); 
      // addDebugLog(`Online users updated: ${userList.filter(u => u.id !== activeUserId).length} other users.`);
    };
    addFirebaseListener(onlineUsersDbRef, onlineUsersCb, 'value');
    return () => removeFirebaseListener(onlineUsersDbRef.toString().substring(onlineUsersDbRef.root.toString().length-1));
  }, [addFirebaseListener, removeFirebaseListener, addDebugLog]);


  // Listener for incoming calls (auto-accepted)
  useEffect(() => {
    const myId = currentSessionUserIdRef.current;
    if (!myId) {
        addDebugLog(`Incoming call listener: No active user ID (currentSessionUserIdRef is ${myId}), cannot attach listener yet.`);
        return;
    }
    
    const incomingCallDbRef = ref(db, `callSignals/${myId}/pendingOffer`);
    addDebugLog(`Attempting to attach incoming call listener at ${incomingCallDbRef.toString()}`);
    
    const incomingCallCb = async (snapshot: any) => {
      const offerData = snapshot.val() as IncomingCallOffer | null;
      addDebugLog(`Offer listener at ${incomingCallDbRef.toString()} triggered. Data exists: ${!!offerData}. Current chat state: ${chatStateRef.current}`);

      if (offerData) {
        if (chatStateRef.current === 'idle') {
          addDebugLog(`Valid offer received by ${myId} from ${offerData.callerName} (room ${offerData.roomId}). Processing...`);
          await processIncomingOfferAndAnswer(offerData);
        } else {
          addDebugLog(`WARN: ${myId} received offer from ${offerData.callerId} (room ${offerData.roomId}) while in state ${chatStateRef.current}. Removing stale offer.`);
          remove(incomingCallDbRef).catch(e => addDebugLog(`WARN: Error removing stale offer by ${myId}: ${e.message || e}`));
        }
      } else {
          // addDebugLog(`Offer listener at ${incomingCallDbRef.toString()} received null data (offer likely removed/processed or initial load).`);
      }
    };
    
    addFirebaseListener(incomingCallDbRef, incomingCallCb, 'value');
    return () => {
      addDebugLog(`Cleaning up incoming call listener for path: ${incomingCallDbRef.toString()}`);
      removeFirebaseListener(incomingCallDbRef.toString().substring(incomingCallDbRef.root.toString().length-1));
    };
  }, [currentSessionUserIdRef.current, processIncomingOfferAndAnswer, addFirebaseListener, removeFirebaseListener, addDebugLog]); 


  // Cleanup effect for component unmount
  useEffect(() => {
    const myIdOnUnmount = currentSessionUserIdRef.current; 
    return () => {
      addDebugLog(`HomePage unmounting for user ${myIdOnUnmount || 'N/A'}. Performing full cleanup.`);
      handleEndCall(false); 
      cleanupAllFirebaseListeners(); 
      
      if (myIdOnUnmount) {
        // Presence is handled by useAuth for authenticated users, and by the anonymous presence useEffect for anonymous ones.
        // Explicit removal here could be redundant or cause issues if onDisconnect is also working.
        // addDebugLog(`Unmount: User ${myIdOnUnmount} should be removed by onDisconnect if still online.`);
      }
      addDebugLog(`Full cleanup on unmount complete for ${myIdOnUnmount || 'N/A'}.`);
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
    if (!sessionUser) { 
        addDebugLog("Feeling Lucky: No session user to initiate call.");
        toast({ title: "Error", description: "Session not ready.", variant: "destructive"}); return; 
    }
    const otherUsers = onlineUsers.filter(u => u.id !== sessionUser.id);
    if (otherUsers.length === 0) {
        toast({ title: "No Users Online", description: "No other users are currently available to call.", variant: "default"}); 
        addDebugLog("Feeling Lucky: No other users online.");
        return;
    }
    const randomUser = otherUsers[Math.floor(Math.random() * otherUsers.length)];
    addDebugLog(`Feeling Lucky: Selected random user ${randomUser.name} (${randomUser.id}). Initiating call.`);
    initiateDirectCall(randomUser);
  };

  const handleProfileSave = async (data: UserProfile) => {
    addDebugLog(`Profile save requested with data: ${JSON.stringify(data)}`);
    try {
        await updateUserProfile(data); // updateUserProfile in useAuth will re-fetch and update authState.userProfile
        setIsProfileEditDialogOpen(false); 
        // No need to setSessionUser here directly, useEffect for sessionUser will pick up changes from authUserProfile
    } catch (error) {
        addDebugLog(`Error saving profile: ${error}`);
        // Toast is handled within updateUserProfile
    }
};


  if (pageLoading || (authCurrentUser && authProfileLoading && !isProfileSetupNeeded) ) {
    // Show loading if initial auth is loading OR if user is auth'd but their profile is still loading (and not in setup phase)
    return (
      <MainLayout>
        <div className="flex flex-col items-center gap-4 p-8 bg-card rounded-xl shadow-lg w-full max-w-lg">
          <Skeleton className="h-20 w-20 rounded-full" />
          <Skeleton className="h-6 w-[280px] mt-3" />
          <Skeleton className="h-4 w-[200px] mt-1" />
          <p className="mt-4 text-muted-foreground">
            {authLoading && "Authenticating..."}
            {authCurrentUser && authProfileLoading && "Loading your profile..."}
            {!authLoading && !authCurrentUser && "Initializing your session..."}
          </p>
        </div>
      </MainLayout>
    );
  }

  // After initial loading, if user is authenticated but needs profile setup
  if (authCurrentUser && isProfileSetupNeeded && !sessionUser) { // Also check !sessionUser to avoid flicker if profile dialog is about to set it
    return (
        <MainLayout>
             <div className="absolute top-4 right-4">
                <Button onClick={signOutUser} variant="outline">
                    <LogOut className="mr-2 h-4 w-4" /> Sign Out
                </Button>
            </div>
            <ProfileSetupDialog 
                isOpen={true} // Controlled by this render logic
                onOpenChange={(open) => { if (!open) addDebugLog("Profile setup dialog closed by user (without saving).");}} //
                user={{id: authCurrentUser.uid, name: authCurrentUser.displayName || '', email: authCurrentUser.email || '', photoUrl: authCurrentUser.photoURL || undefined}}
                onSave={handleProfileSave}
                existingProfile={authUserProfile}
            />
        </MainLayout>
    );
  }
  
  if (!sessionUser && !authLoading) { // If all auth loading is done and still no sessionUser (e.g. anon failed or edge case)
    return (
       <MainLayout><p className="text-destructive">Error: Session could not be initialized. Please refresh.</p></MainLayout>
    );
  }
  
  // This should not be null if pageLoading is false and profile setup is not needed or complete
  if (!sessionUser) {
      return <MainLayout><p>Loading session user details...</p></MainLayout>; // Fallback, should be brief
  }


  return (
    <MainLayout>
      <div className="absolute top-4 right-4 flex gap-2">
        {!authCurrentUser ? (
          <Button onClick={signInWithGoogle} variant="outline">
            <LogIn className="mr-2 h-4 w-4" /> Sign in with Google
          </Button>
        ) : (
          <>
            <Button onClick={() => setIsProfileEditDialogOpen(true)} variant="outline">
                <Edit3 className="mr-2 h-4 w-4" /> Edit Profile
            </Button>
            <Button onClick={signOutUser} variant="outline">
                <LogOut className="mr-2 h-4 w-4" /> Sign Out
            </Button>
            {authUserProfile && ( // Ensure authUserProfile is not null before rendering ProfileSetupDialog for editing
                <ProfileSetupDialog 
                    isOpen={isProfileEditDialogOpen}
                    onOpenChange={setIsProfileEditDialogOpen}
                    user={{ // Pass auth user details for editing context
                        uid: authCurrentUser.uid,
                        displayName: authCurrentUser.displayName || '',
                        email: authCurrentUser.email || '',
                        photoUrl: authCurrentUser.photoURL || undefined
                    }}
                    onSave={handleProfileSave}
                    isEditing={true}
                    existingProfile={authUserProfile}
                />
            )}
          </>
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
                  {sessionUser.isGoogleUser && <span className="text-xs text-primary font-semibold ml-1">(Google)</span>}
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
            peerName={(peerInfo as OnlineUser)?.name || (chatState === 'dialing' ? 'Dialing...' : (chatState === 'connecting' ? 'Connecting...' : 'Peer'))}
          />
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
            <Button onClick={() => handleEndCall(true)} size="lg" className="flex-1" variant="destructive">
              <PhoneOff className="mr-2 h-5 w-5" /> End Call
            </Button>
             {chatState === 'connected' && peerInfo && authCurrentUser && (peerInfo as OnlineUser).isGoogleUser && ( 
                <ReportDialog
                reportedUser={{
                    id: peerInfo.id, 
                    name: (peerInfo as UserProfile).name || (peerInfo as OnlineUser).name, 
                    photoUrl: (peerInfo as UserProfile).photoUrl || (peerInfo as OnlineUser).photoUrl || '', 
                    bio: (peerInfo as UserProfile).bio || ''
                }} 
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
                You chatted with {(peerInfo as OnlineUser).name}
                {(peerInfo as OnlineUser).isGoogleUser && <span className="text-xs text-primary font-semibold ml-1">(Google)</span>}
                {(peerInfo as OnlineUser).countryCode && ` (${(peerInfo as OnlineUser).countryCode})`}.
              </p>
              <Card className="w-full max-w-sm p-6 bg-background shadow-lg rounded-xl border-primary/50">
                <div className="flex flex-col items-center text-center">
                    <Avatar className="w-24 h-24 mb-4 border-2 border-primary shadow-md">
                        <AvatarImage src={(peerInfo as OnlineUser).photoUrl || (peerInfo as UserProfile).photoUrl} alt={(peerInfo as OnlineUser).name} data-ai-hint="avatar abstract"/>
                        <AvatarFallback>{(peerInfo as OnlineUser).name.charAt(0).toUpperCase()}</AvatarFallback>
                    </Avatar>
                    <h3 className="text-2xl font-semibold">{(peerInfo as OnlineUser).name}</h3>
                    <p className="text-sm text-muted-foreground">ID: {peerInfo.id} {(peerInfo as OnlineUser).countryCode && `(${(peerInfo as OnlineUser).countryCode})`}</p>
                    {(peerInfo as UserProfile).bio && <p className="text-xs text-muted-foreground">Bio: {(peerInfo as UserProfile).bio}</p>}
                </div>
              </Card>
            </>
          ) : ( <p className="text-muted-foreground">The other user's information could not be loaded.</p> )}
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mt-4">
            <Button onClick={handleBackToOnlineUsers} size="lg" variant="secondary" className="flex-1">
              <VideoIcon className="mr-2 h-5 w-5" /> Back to Online Users
            </Button>
            {peerInfo && authCurrentUser && (peerInfo as OnlineUser).isGoogleUser &&( 
                 <ReportDialog
                 reportedUser={{
                    id: peerInfo.id, 
                    name: (peerInfo as UserProfile).name || (peerInfo as OnlineUser).name,
                    photoUrl: (peerInfo as UserProfile).photoUrl || (peerInfo as OnlineUser).photoUrl || '', 
                    bio: (peerInfo as UserProfile).bio || ''
                 }} 
                 triggerButtonText={`Report ${(peerInfo as OnlineUser).name}`} triggerButtonVariant="destructive" triggerButtonFullWidth={true}
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
