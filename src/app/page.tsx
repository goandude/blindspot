
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { ProfileSetupDialog } from '@/components/features/profile/profile-setup-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { OnlineUser, IncomingCallOffer, CallAnswer, UserProfile } from '@/types';
import { PhoneOff, Video as VideoIcon, Shuffle, LogIn, LogOut, Edit3 } from 'lucide-react';
import { db } from '@/lib/firebase'; // Assuming db is correctly initialized
import { ref, set, onValue, off, remove, push, child, serverTimestamp, type DatabaseReference, get } from 'firebase/database';
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
  const [sessionUser, setSessionUser] = useState<OnlineUser | null>(null); // Can be anonymous or Google User

  const [chatState, setChatState] = useState<ChatState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [peerInfo, setPeerInfo] = useState<OnlineUser | UserProfile | null>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [pageLoading, setPageLoading] = useState(true); // Combines auth and anonymous session loading
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
  const peerIdRef = useRef<string | null>(null);
  const isCallerRef = useRef<boolean>(false);

  const firebaseListeners = useRef<Map<string, { ref: DatabaseReference, callback: (snapshot: any) => void, eventType: string }>>(new Map());
  const chatStateRef = useRef<ChatState>(chatState);
  const currentSessionUserIdRef = useRef<string | null>(null); // Stores active ID (anon or auth)
  const isPageVisibleRef = useRef<boolean>(true); // Track page visibility

  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const currentSId = currentSessionUserIdRef.current;
    let prefix = currentSId ? `[${currentSId.substring(0, 4)}] ` : '[N/A] ';
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
    addDebugLog(`Generated new anonymous session ID: ${newAnonId}`);
  }, [addDebugLog]);


  // 2. Determine and set the active sessionUser (anonymous or authenticated)
  useEffect(() => {
    addDebugLog(`Auth state update: authLoading=${authLoading}, authProfileLoading=${authProfileLoading}, authCurrentUser=${authCurrentUser?.uid}, isProfileSetupNeeded=${isProfileSetupNeeded}, anonymousSessionId=${anonymousSessionId}`);

    if (authLoading) {
      addDebugLog("Auth state is loading (authLoading=true), page remains in loading state.");
      setPageLoading(true);
      return;
    }

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
        dataAiHint: authUserProfile.dataAiHint,
        countryCode: authUserProfile.countryCode,
        isGoogleUser: true,
      };
      setSessionUser(googleSessionUser);
      currentSessionUserIdRef.current = authCurrentUser.uid;
      addDebugLog(`Active session user (Google): ${googleSessionUser.name} (${googleSessionUser.id})`);
      setPageLoading(false);
    } else if (authCurrentUser && isProfileSetupNeeded) {
      addDebugLog(`Google user ${authCurrentUser.uid} authenticated, but profile setup is needed. Page loading false, ProfileSetupDialog should show.`);
      setPageLoading(false); // Profile dialog will show
    } else if (!authCurrentUser && anonymousSessionId) {
      addDebugLog(`No Google user. Using anonymous session ID: ${anonymousSessionId}.`);
      const fetchCountryAndSetAnonymousUser = async () => {
        addDebugLog(`Fetching country for anonymous user ${anonymousSessionId}.`);
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
          dataAiHint: 'abstract character',
          countryCode: countryCode,
          isGoogleUser: false,
        };
        setSessionUser(anonUser);
        currentSessionUserIdRef.current = anonymousSessionId;
        addDebugLog(`Anonymous session user created: ${anonUser.name} (${anonUser.id}) with country ${anonUser.countryCode}`);
        setPageLoading(false);
      };
      fetchCountryAndSetAnonymousUser();
    } else if (!authCurrentUser && !anonymousSessionId) {
        addDebugLog("Waiting for anonymous session ID to be generated. Page loading true.");
        setPageLoading(true);
    } else {
        addDebugLog(`Fell through sessionUser determination logic. Current user: ${authCurrentUser?.uid}, Anon ID: ${anonymousSessionId}. Setting pageLoading to false.`);
        setPageLoading(false); // Default to false to unblock UI if other conditions aren't met
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

    // For 'value' listeners, onValue itself returns an unsubscribe function.
    // For other types like 'child_added', etc., you'd use onChildAdded, onChildRemoved, etc.
    // and manage their specific unsubscribe behavior.
    // For simplicity, this example primarily uses 'onValue'.
    // If you use child_added, child_removed etc., you would pass `ref(db, path)` and then call `off(ref(db,path), eventType, actualCallback)`
    const unsubscribe = onValue(dbRef, actualCallback, (error) => {
        addDebugLog(`ERROR reading from ${path} (event: ${eventType}): ${error.message}`);
        toast({ title: "Firebase Error", description: `Failed to listen to ${path}. Check console.`, variant: "destructive" });
    });

    firebaseListeners.current.set(path, { ref: dbRef, callback: actualCallback, eventType });
    addDebugLog(`Added Firebase listener for path: ${path} with eventType: ${eventType}`);
    // Note: The unsubscribe function from onValue is not directly stored here for this simple map,
    // as `off(dbRef, eventType, callback)` is used in removeFirebaseListener.
    // For more complex scenarios, storing the direct unsubscribe function might be better.
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
      addDebugLog(`Current peer connection state before closing: ${peerConnectionRef.current.signalingState}, ice: ${peerConnectionRef.current.iceConnectionState}`);
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.onsignalingstatechange = null;

      peerConnectionRef.current.getSenders().forEach(sender => {
        if (sender.track) {
            addDebugLog(`Stopping sender track: ${sender.track.kind}`);
            sender.track.stop();
        }
      });
      if (peerConnectionRef.current.signalingState !== 'closed') {
        peerConnectionRef.current.close();
      }
      peerConnectionRef.current = null;
      addDebugLog(`Peer connection closed and nulled.`);
    } else {
        addDebugLog("No active peer connection to cleanup for WebRTC.");
    }
    if (localStream) {
      localStream.getTracks().forEach(track => {  addDebugLog(`Stopping local track: ${track.kind}`); track.stop(); });
      setLocalStream(null);
      addDebugLog(`Local stream stopped and nulled.`);
    }
    setRemoteStream(null);
    addDebugLog(`Remote stream nulled.`);
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
      // Remove pending offer for myself if I was the callee and declined or call ended before full setup
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

      if (!peerToReveal && authCurrentUser) {
         addDebugLog(`Peer ${currentPeerIdVal} not readily available. Attempting to fetch their UserProfile if they are a Google User.`);
         try {
            const userRef = ref(db, `users/${currentPeerIdVal}`);
            const snapshot = await get(userRef);
            if (snapshot.exists()) {
                peerToReveal = snapshot.val() as UserProfile;
                addDebugLog(`Fetched full UserProfile for revealed peer ${currentPeerIdVal}: ${JSON.stringify(peerToReveal)}`);
            } else {
                addDebugLog(`No UserProfile found for ${currentPeerIdVal}. They might be anonymous or profile doesn't exist.`);
            }
         } catch (e: any) {
            addDebugLog(`Error fetching UserProfile for revealed peer ${currentPeerIdVal}: ${e.message}`);
         }
      }

      if (!peerToReveal) {
        addDebugLog(`Peer ${currentPeerIdVal} still not found. Constructing minimal peer info for reveal.`);
        const tempPeerIsLikelyGoogleUser = onlineUsers.find(u => u.id === currentPeerIdVal)?.isGoogleUser || false;
        peerToReveal = {
          id: currentPeerIdVal,
          name: `User-${currentPeerIdVal.substring(0,4)}`,
          photoUrl: `https://placehold.co/96x96.png?text=${currentPeerIdVal.charAt(0).toUpperCase()}`,
          dataAiHint: 'abstract character',
          countryCode: onlineUsers.find(u => u.id === currentPeerIdVal)?.countryCode || 'XX',
          isGoogleUser: tempPeerIsLikelyGoogleUser
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
    if (chatStateRef.current === 'idle' || chatStateRef.current === 'revealed') {
        peerIdRef.current = null;
    }
    isCallerRef.current = false;
  }, [cleanupWebRTC, cleanupCallData, onlineUsers, peerInfo, removeFirebaseListener, addDebugLog, wrappedSetChatState, authCurrentUser]);


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
        // Firefox sometimes doesn't populate event.streams, so create a new stream from the track
        const newStream = new MediaStream([event.track]);
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
        if (['connecting', 'dialing'].includes(chatStateRef.current)) { // Check against current state in ref
            addDebugLog("ICE fully connected/completed, setting chat state to 'connected'.");
            wrappedSetChatState('connected');
        }
      } else if (['failed', 'disconnected', 'closed'].includes(iceState)) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
          addDebugLog(`ICE state: ${iceState}. Ending call (showReveal=false).`);
          toast({ title: "Connection Issue", description: `Call state: ${iceState}. Ending call.`, variant: "default" });
          handleEndCall(false); // No reveal on ICE failure
        }
      }
    };
    pc.onsignalingstatechange = () => {
        if (!peerConnectionRef.current) return;
        addDebugLog(`Signaling state changed: ${peerConnectionRef.current.signalingState}`);
    };
    return pc;
  }, [handleEndCall, toast, addDebugLog, wrappedSetChatState]); // Dependencies for initializePeerConnection

  const startLocalStream = useCallback(async (): Promise<MediaStream | null> => {
    const myId = currentSessionUserIdRef.current;
    addDebugLog(`Attempting to start local stream for ${myId}.`);
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        addDebugLog("ERROR: getUserMedia not supported on this browser.");
        toast({ title: "Media Error", description: "Your browser does not support camera/microphone access.", variant: "destructive" });
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') handleEndCall(false);
        else wrappedSetChatState('idle');
        return null;
    }
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
    const sUser = sessionUser; // Use state variable sessionUser
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
      addDebugLog(`Offer sent to ${targetUser.id} at ${offerPath}.`);

      const answerDbRefPath = `callSignals/${newRoomId}/answer`;
      addFirebaseListener(ref(db, answerDbRefPath), async (snapshot: any) => {
        if (snapshot.exists() && peerConnectionRef.current && peerConnectionRef.current.signalingState !== 'closed') {
          const answerData = snapshot.val() as CallAnswer;
          addDebugLog(`Caller: Received answer from ${answerData.calleeId} for room ${newRoomId}.`);
          if (peerConnectionRef.current.remoteDescription) {
             addDebugLog(`WARN: Caller: Remote description already set for room ${newRoomId}. Current remote: ${peerConnectionRef.current.remoteDescription.type}`);
             // Potentially ignore if already set, or handle re-negotiation if needed
          }
          try {
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answerData.answer));
            addDebugLog(`Caller: Remote desc (answer) set successfully for room ${newRoomId}.`);
          } catch (e: any) {
            addDebugLog(`ERROR: Caller: setting remote desc (answer) for room ${newRoomId}: ${e.message || e}. PC State: ${peerConnectionRef.current.signalingState}`);
            handleEndCall(false); // End call on error
            return;
          }
          removeFirebaseListener(answerDbRefPath); // Remove listener after processing
          remove(ref(db, answerDbRefPath)).catch(e => addDebugLog(`WARN: Error removing answer from ${answerDbRefPath}: ${e.message || e}`));
        } else if (snapshot.exists() && (!peerConnectionRef.current || peerConnectionRef.current.signalingState === 'closed')) {
            addDebugLog(`Caller: Received answer for room ${newRoomId}, but peer connection is null or closed. Ignoring.`);
        }
      }, 'value');

      const calleeIceCandidatesRefPath = `iceCandidates/${newRoomId}/${targetUser.id}`;
      addFirebaseListener(ref(db, calleeIceCandidatesRefPath), (snapshot: any) => {
        snapshot.forEach((childSnapshot: any) => {
            const candidate = childSnapshot.val();
            if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription && peerConnectionRef.current.signalingState !== 'closed') {
                addDebugLog(`Caller: Received ICE candidate object from callee ${targetUser.id} for room ${newRoomId}: ${JSON.stringify(candidate)}`);
                if (candidate.candidate && (candidate.sdpMid !== null || candidate.sdpMLineIndex !== null)) {
                    peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                        .catch(e => addDebugLog(`ERROR: Caller adding callee ICE for room ${newRoomId}: ${e.message || e}`));
                } else if (candidate.candidate) {
                    addDebugLog(`WARN: Caller: Received ICE with null sdpMid/sdpMLineIndex from callee ${targetUser.id} for room ${newRoomId}. Candidate: ${candidate.candidate.substring(0,15)}`);
                }
            } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
                addDebugLog(`WARN: Caller received callee ICE for room ${newRoomId} but remote desc not set. Buffering or investigate timing.`);
            } else if (candidate && (!peerConnectionRef.current || peerConnectionRef.current.signalingState === 'closed')){
                 addDebugLog(`WARN: Caller received callee ICE for room ${newRoomId} but peer connection is null or closed.`);
            }
        });
      }, 'value'); // Listen to 'value' to get all candidates, not just child_added

    } catch (error: any) {
      addDebugLog(`ERROR initiating call from ${sUser.id} to ${targetUser.id} (room ${roomIdRef.current}): ${error.message || error}`);
      toast({ title: "Call Error", variant: "destructive", description: "Could not initiate call." });
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, removeFirebaseListener, startLocalStream, addDebugLog, wrappedSetChatState]);

  const processIncomingOfferAndAnswer = useCallback(async (offerData: IncomingCallOffer) => {
    const sUser = sessionUser; // Use state variable sessionUser
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

    // Automatically accept call
    wrappedSetChatState('connecting');
    peerIdRef.current = offerData.callerId; roomIdRef.current = offerData.roomId; isCallerRef.current = false;

    const peerForInfo: OnlineUser = { // Construct peer info for display
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
      addDebugLog(`Callee ${sUser.id}: Answer sent to room ${offerData.roomId}.`);

      // Offer processed, remove it
      const myOfferPath = `callSignals/${sUser.id}/pendingOffer`;
      await remove(ref(db, myOfferPath));
      addDebugLog(`Callee ${sUser.id}: Removed processed pending offer from ${myOfferPath}.`);

      // Listen for caller's ICE candidates
      const callerIceCandidatesRefPath = `iceCandidates/${offerData.roomId}/${offerData.callerId}`;
      addFirebaseListener(ref(db, callerIceCandidatesRefPath), (snapshot: any) => {
        snapshot.forEach((childSnapshot: any) => {
            const candidate = childSnapshot.val();
            if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription && peerConnectionRef.current.signalingState !== 'closed') {
                addDebugLog(`Callee ${sUser.id}: Received ICE candidate object from caller ${offerData.callerId} for room ${offerData.roomId}: ${JSON.stringify(candidate)}`);
                 if (candidate.candidate && (candidate.sdpMid !== null || candidate.sdpMLineIndex !== null)) {
                    peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                        .catch(e => addDebugLog(`ERROR: Callee ${sUser.id} adding caller ICE for room ${offerData.roomId}: ${e.message || e}`));
                } else if (candidate.candidate) {
                    addDebugLog(`WARN: Callee ${sUser.id}: Received ICE with null sdpMid/sdpMLineIndex from caller ${offerData.callerId} for room ${offerData.roomId}. Candidate: ${candidate.candidate.substring(0,15)}`);
                }
            } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
                addDebugLog(`WARN: Callee ${sUser.id} received caller ICE for room ${offerData.roomId} but remote desc not set.`);
            } else if (candidate && (!peerConnectionRef.current || peerConnectionRef.current.signalingState === 'closed')) {
                 addDebugLog(`WARN: Callee ${sUser.id} received caller ICE for room ${offerData.roomId} but peer connection is null or closed.`);
            }
        });
      }, 'value'); // Listen to 'value' to get all candidates
    } catch (error: any) {
      addDebugLog(`Callee ${sUser.id}: ERROR processing offer for room ${offerData.roomId}: ${error.message || error}`);
      toast({ title: "Call Error", variant: "destructive", description: "Could not process incoming call." });
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, startLocalStream, addDebugLog, wrappedSetChatState]); // Dependencies for processIncomingOfferAndAnswer

  // ANONYMOUS Presence system (only if not Google authenticated)
  useEffect(() => {
    if (authCurrentUser || !anonymousSessionId) {
      addDebugLog("Anonymous Presence: Skipping - Google user active or anonymousSessionId not ready.");
      return;
    }

    // Ensure sessionUser is the anonymous one before setting up presence
    if (!sessionUser || sessionUser.id !== anonymousSessionId || sessionUser.isGoogleUser) {
      addDebugLog(`Anonymous Presence: Skipping - sessionUser (${sessionUser?.id}, isGoogle: ${sessionUser?.isGoogleUser}) not aligned with anonymous state (${anonymousSessionId}). Waiting for sessionUser to update.`);
      return;
    }

    const myId = anonymousSessionId;

    addDebugLog(`Anonymous Presence: Setting up for ${myId}. Name: ${sessionUser.name}, Country: ${sessionUser.countryCode}`);
    const userStatusDbRef: DatabaseReference = ref(db, `onlineUsers/${myId}`);
    const connectedDbRef = ref(db, '.info/connected');

    const presenceCb = (snapshot: any) => {
      if (!currentSessionUserIdRef.current || currentSessionUserIdRef.current !== myId || authCurrentUser) {
        addDebugLog(`Anonymous Presence for ${myId}: Skipping update. Current user ref ${currentSessionUserIdRef.current} or authUser ${authCurrentUser?.uid} exists.`);
        return;
      }
      if (snapshot.val() === true) {
        addDebugLog(`Anonymous Presence: Firebase connection established for ${myId}.`);
        const currentAnonUser = sessionUser; // Re-evaluate sessionUser from the closure
        if (currentAnonUser && currentAnonUser.id === myId && !currentAnonUser.isGoogleUser && isPageVisibleRef.current) {
            const presenceData: OnlineUser = {
              id: myId, // Ensure ID is explicitly set
              name: currentAnonUser.name,
              photoUrl: currentAnonUser.photoUrl,
              dataAiHint: currentAnonUser.dataAiHint,
              countryCode: currentAnonUser.countryCode,
              isGoogleUser: false,
              timestamp: serverTimestamp()
            };
            set(userStatusDbRef, presenceData)
              .then(() => addDebugLog(`Anonymous Presence: Set online for ${myId} with data: ${JSON.stringify(presenceData)}.`))
              .catch(e => addDebugLog(`Anonymous Presence: ERROR setting presence for ${myId}: ${e.message || e}`));

            if (userStatusDbRef && typeof userStatusDbRef.onDisconnect === 'function') {
                userStatusDbRef.onDisconnect().remove()
                  .then(() => addDebugLog(`Anonymous Presence: onDisconnect().remove() set for ${myId}.`))
                  .catch(e => addDebugLog(`Anonymous Presence: ERROR setting onDisconnect for ${myId}: ${e.message || e}`));
            } else {
                addDebugLog(`Anonymous Presence: ERROR - userStatusDbRef or userStatusDbRef.onDisconnect is not valid. userStatusDbRef type: ${typeof userStatusDbRef}. Path: ${userStatusDbRef?.toString()}`);
            }
        } else {
            addDebugLog(`Anonymous Presence: current sessionUser (${currentAnonUser?.id}, isGoogle: ${currentAnonUser?.isGoogleUser}) doesn't match anonymous ID ${myId} or page not visible (${isPageVisibleRef.current}). Aborting set online.`);
        }
      } else {
        addDebugLog(`Anonymous Presence: Firebase connection lost for ${myId}.`);
      }
    };

    addFirebaseListener(connectedDbRef, presenceCb, 'value');

    return () => {
      addDebugLog(`Anonymous Presence: Cleaning up for session user: ${myId}. Detaching .info/connected listener.`);
      removeFirebaseListener(connectedDbRef.toString().substring(connectedDbRef.root.toString().length-1));
      if (myId) { // Ensure myId is valid before attempting removal
        const pathToRemove = `onlineUsers/${myId}`;
        remove(ref(db, pathToRemove))
            .then(() => addDebugLog(`Anonymous Presence: Explicitly removed user ${myId} from ${pathToRemove} on cleanup.`))
            .catch(e => addDebugLog(`Anonymous Presence: WARN: Error explicitly removing user ${myId} from ${pathToRemove} on cleanup: ${e.message || e}`));
      }
    };
  }, [authCurrentUser, anonymousSessionId, sessionUser, addFirebaseListener, removeFirebaseListener, addDebugLog]); // Dependencies for anonymous presence


  // Listener for all online users
  useEffect(() => {
    const onlineUsersDbRef = ref(db, 'onlineUsers');
    const onlineUsersCb = (snapshot: any) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = [];
      if (usersData) {
        for (const key in usersData) {
          // Ensure basic structure, especially id
          if (usersData[key] && typeof usersData[key].id === 'string') {
            userList.push(usersData[key] as OnlineUser);
          } else {
            addDebugLog(`WARN: Invalid user data found in onlineUsers for key ${key}: ${JSON.stringify(usersData[key])}`);
          }
        }
      }
      const activeUserId = currentSessionUserIdRef.current;
      setOnlineUsers(userList.filter(u => u.id !== activeUserId)); // Filter out self
    };
    addFirebaseListener(onlineUsersDbRef, onlineUsersCb, 'value');
    return () => removeFirebaseListener(onlineUsersDbRef.toString().substring(onlineUsersDbRef.root.toString().length-1));
  }, [addFirebaseListener, removeFirebaseListener, addDebugLog]); // currentSessionUserIdRef is not needed here as filter is local


  // Listener for incoming calls (auto-accepted)
  useEffect(() => {
    const myId = currentSessionUserIdRef.current;
    if (!myId) {
        addDebugLog(`Incoming call listener: No active user ID (currentSessionUserIdRef is ${myId}), cannot attach listener yet.`);
        return () => {}; // Return empty cleanup if no listener attached
    }

    const incomingCallDbRefPath = `callSignals/${myId}/pendingOffer`;
    addDebugLog(`Attempting to attach incoming call listener at ${incomingCallDbRefPath}`);

    const incomingCallDbRef = ref(db, incomingCallDbRefPath);
    const incomingCallCb = async (snapshot: any) => {
      const offerData = snapshot.val() as IncomingCallOffer | null;
      addDebugLog(`Offer listener at ${incomingCallDbRefPath} triggered. Data exists: ${!!offerData}. Current chat state: ${chatStateRef.current}`);

      if (offerData) {
        if (chatStateRef.current === 'idle') { // Only process if idle
          addDebugLog(`Valid offer received by ${myId} from ${offerData.callerName} (room ${offerData.roomId}). Processing...`);
          await processIncomingOfferAndAnswer(offerData); // This will also remove the offer from DB
        } else {
          addDebugLog(`WARN: ${myId} received offer from ${offerData.callerId} (room ${offerData.roomId}) while in state ${chatStateRef.current}. Removing stale offer.`);
          remove(incomingCallDbRef).catch(e => addDebugLog(`WARN: Error removing stale offer by ${myId}: ${e.message || e}`));
        }
      } else {
        addDebugLog(`Offer listener at ${incomingCallDbRefPath} received null data (offer likely removed/processed or this is initial load).`);
      }
    };

    addFirebaseListener(incomingCallDbRef, incomingCallCb, 'value');
    return () => {
      addDebugLog(`Cleaning up incoming call listener for path: ${incomingCallDbRefPath}`);
      removeFirebaseListener(incomingCallDbRefPath);
    };
  }, [currentSessionUserIdRef.current, processIncomingOfferAndAnswer, addFirebaseListener, removeFirebaseListener, addDebugLog]);


  // Page Visibility API for presence
  useEffect(() => {
    const handleVisibilityChange = () => {
      const currentSUser = sessionUser; // Capture current sessionUser
      if (!currentSUser || !currentSUser.id) {
         addDebugLog("Page Visibility: No currentSUser or currentSUser.id, cannot handle visibility change.");
         return;
      }

      const userOnlinePath = `onlineUsers/${currentSUser.id}`;

      if (document.hidden) {
        addDebugLog(`Page hidden. Removing ${currentSUser.id} from online list.`);
        isPageVisibleRef.current = false;
        remove(ref(db, userOnlinePath)).catch(e => addDebugLog(`Error removing user on page hide: ${e.message}`));
      } else {
        addDebugLog(`Page visible. Re-adding ${currentSUser.id} to online list.`);
        isPageVisibleRef.current = true;
        const presenceData: OnlineUser = {
          ...currentSUser,
          timestamp: serverTimestamp(),
        };
        set(ref(db, userOnlinePath), presenceData).catch(e => addDebugLog(`Error re-adding user on page visible: ${e.message}`));
        // Re-establish onDisconnect for the specific user type
        if (currentSUser.isGoogleUser && authCurrentUser) {
          // Authenticated user onDisconnect is handled by useAuth
          addDebugLog(`Page Visibility: Google user ${currentSUser.id} now visible. onDisconnect handled by useAuth.`);
        } else if (!currentSUser.isGoogleUser && anonymousSessionId === currentSUser.id) {
          // Anonymous user, re-set onDisconnect
          const userStatusDbRef = ref(db, userOnlinePath);
          if (userStatusDbRef && typeof userStatusDbRef.onDisconnect === 'function') {
            userStatusDbRef.onDisconnect().remove()
              .then(() => addDebugLog(`Anonymous Presence: onDisconnect().remove() re-set for ${currentSUser.id} on page visible.`))
              .catch(e => addDebugLog(`Anonymous Presence: ERROR re-setting onDisconnect for ${currentSUser.id}: ${e.message || e}`));
          } else {
            addDebugLog(`Anonymous Presence: ERROR - userStatusDbRef or onDisconnect not valid for re-set on page visible for ${currentSUser.id}. Path: ${userStatusDbRef?.toString()}`);
          }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    // For mobile browsers that might use pagehide/pageshow
    window.addEventListener('pagehide', handleVisibilityChange);
    window.addEventListener('pageshow', handleVisibilityChange);


    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
      addDebugLog("Cleaned up Page Visibility listeners.");
    };
  }, [sessionUser, addDebugLog, authCurrentUser, anonymousSessionId]); // Re-run if sessionUser changes


  // Cleanup effect for component unmount
  useEffect(() => {
    const myIdOnUnmount = currentSessionUserIdRef.current;
    return () => {
      addDebugLog(`HomePage unmounting for user ${myIdOnUnmount || 'N/A'}. Performing full cleanup.`);
      handleEndCall(false); // End any active call, don't show reveal
      cleanupAllFirebaseListeners();

      // Explicit removal for anonymous user on unmount in case onDisconnect didn't fire or visibility change missed
      if (myIdOnUnmount && !authCurrentUser) { // Only if it was an anonymous session
        const userStatusDbRefPath = `onlineUsers/${myIdOnUnmount}`;
        remove(ref(db, userStatusDbRefPath))
            .then(() => addDebugLog(`Anonymous Presence: Explicitly removed user ${myIdOnUnmount} from ${userStatusDbRefPath} on unmount.`))
            .catch(e => addDebugLog(`Anonymous Presence: WARN: Error explicitly removing user ${myIdOnUnmount} from ${userStatusDbRefPath} on unmount: ${e.message || e}`));
      }
      addDebugLog(`Full cleanup on unmount complete for ${myIdOnUnmount || 'N/A'}.`);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authCurrentUser]); // Run this main cleanup only based on authCurrentUser changes or unmount


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
    if (!sessionUser) { // Check current session user
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
        await updateUserProfile(data); // This comes from useAuth hook
        setIsProfileEditDialogOpen(false);
    } catch (error) {
        addDebugLog(`Error saving profile: ${error}`);
        // Toast for error is likely handled within updateUserProfile
    }
};

  if (pageLoading) {
    return (
      <MainLayout>
        <div className="flex flex-col items-center gap-4 p-8 bg-card rounded-xl shadow-lg w-full max-w-lg">
          <Skeleton className="h-20 w-20 rounded-full" />
          <Skeleton className="h-6 w-[280px] mt-3" />
          <Skeleton className="h-4 w-[200px] mt-1" />
          <p className="mt-4 text-muted-foreground">
            {authLoading && "Authenticating..."}
            {authCurrentUser && authProfileLoading && "Loading your profile..."}
            {!authLoading && !authCurrentUser && !sessionUser && "Initializing your session..."}
            {pageLoading && !authLoading && !authProfileLoading && !sessionUser && "Finalizing session setup..."}
            {sessionUser && "Session active..."}
          </p>
        </div>
      </MainLayout>
    );
  }

  if (authCurrentUser && isProfileSetupNeeded && !authProfileLoading) { // Check authProfileLoading here
    return (
        <MainLayout>
             <div className="absolute top-4 right-4">
                <Button onClick={signOutUser} variant="outline">
                    <LogOut className="mr-2 h-4 w-4" /> Sign Out
                </Button>
            </div>
            <ProfileSetupDialog
                isOpen={true} // Dialog is controlled by this condition
                onOpenChange={(open) => {
                    if (!open) {
                        addDebugLog("Profile setup dialog closed by user (without saving). Potentially signing out or handling differently.");
                        // Consider implications: if they close, should they be signed out? For now, they remain in this state.
                    }
                }}
                user={{id: authCurrentUser.uid, name: authCurrentUser.displayName || '', email: authCurrentUser.email || '', photoUrl: authCurrentUser.photoURL || undefined}}
                onSave={handleProfileSave}
                existingProfile={authUserProfile} // Pass existing profile, could be partially filled
            />
        </MainLayout>
    );
  }

  // Fallback if sessionUser is somehow not set after loading states are false
  if (!sessionUser && !authLoading && !authProfileLoading) {
    return (
       <MainLayout><p className="text-destructive">Error: Session could not be initialized. Please refresh.</p></MainLayout>
    );
  }
  // If sessionUser is still null at this point, show a generic loading until it's resolved.
  if (!sessionUser) {
      return (
        <MainLayout>
         <div className="flex flex-col items-center gap-4 p-8 bg-card rounded-xl shadow-lg w-full max-w-lg">
          <Skeleton className="h-20 w-20 rounded-full" />
          <Skeleton className="h-6 w-[280px] mt-3" />
          <p className="mt-4 text-muted-foreground">Loading session user details...</p>
        </div>
       </MainLayout>
      );
  }


  // Main content
  return (
    <MainLayout>
      <div className="absolute top-4 right-4 flex gap-2">
        {!authCurrentUser ? (
          <Button onClick={signInWithGoogle} variant="outline">
            <LogIn className="mr-2 h-4 w-4" /> Sign in with Google
          </Button>
        ) : (
          <>
            {authUserProfile && ( // Only show edit if profile exists
                <Button onClick={() => setIsProfileEditDialogOpen(true)} variant="outline">
                    <Edit3 className="mr-2 h-4 w-4" /> Edit Profile
                </Button>
            )}
            <Button onClick={signOutUser} variant="outline">
                <LogOut className="mr-2 h-4 w-4" /> Sign Out
            </Button>
            {/* Profile Edit Dialog - rendered conditionally if authUserProfile exists */}
            {authUserProfile && authCurrentUser && (
                <ProfileSetupDialog
                    isOpen={isProfileEditDialogOpen}
                    onOpenChange={setIsProfileEditDialogOpen}
                    user={{
                        id: authCurrentUser.uid, // useAuth hook provides FirebaseUser type
                        displayName: authCurrentUser.displayName || '',
                        email: authCurrentUser.email || '',
                        photoUrl: authCurrentUser.photoURL || undefined
                    }}
                    onSave={handleProfileSave}
                    isEditing={true}
                    existingProfile={authUserProfile} // Pass the loaded profile for editing
                />
            )}
          </>
        )}
      </div>

      <div className="text-center mb-4">
        <h1 className="text-4xl font-bold text-primary mb-2">BlindSpot Social</h1>
        <p className="text-lg text-foreground/80">Connect Directly. Chat Visually.</p>
      </div>

      {chatState === 'idle' && sessionUser && (
        <div className="flex flex-col items-center gap-6 p-6 bg-card rounded-xl shadow-xl w-full max-w-lg">
           <Card className="w-full max-w-md shadow-md border-primary/50">
            <CardHeader className="items-center text-center pb-4">
                <Avatar className="w-20 h-20 mb-3 border-2 border-primary shadow-sm">
                    <AvatarImage src={sessionUser.photoUrl} alt={sessionUser.name} data-ai-hint={sessionUser.dataAiHint || "avatar abstract"} />
                    <AvatarFallback>{sessionUser.name.charAt(0).toUpperCase()}</AvatarFallback>
                </Avatar>
                <CardTitle className="text-xl">
                  {sessionUser.name}
                  {sessionUser.isGoogleUser && <span className="text-xs text-primary font-semibold ml-1">(Google)</span>}
                  {sessionUser.countryCode && ` (${sessionUser.countryCode})`}
                </CardTitle>
                <CardDescription className="text-sm text-muted-foreground">Your current ID: {sessionUser.id.substring(0,8)}...</CardDescription>
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
             {/* Report button during connected state - ensure peerInfo is UserProfile or OnlineUser for reporting */}
             {chatState === 'connected' && peerInfo && (peerInfo as OnlineUser | UserProfile).id && authCurrentUser && (peerInfo as OnlineUser).isGoogleUser && (
                <ReportDialog
                reportedUser={{
                    id: (peerInfo as UserProfile).id, // Ensure ID is available
                    name: (peerInfo as UserProfile).name || (peerInfo as OnlineUser).name,
                    photoUrl: (peerInfo as UserProfile).photoUrl || (peerInfo as OnlineUser).photoUrl || '',
                    bio: (peerInfo as UserProfile).bio || '' // Bio might only be on UserProfile
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
                You chatted with {(peerInfo as OnlineUser).name || 'a user'}
                {(peerInfo as OnlineUser).isGoogleUser && <span className="text-xs text-primary font-semibold ml-1">(Google)</span>}
                {(peerInfo as OnlineUser).countryCode && ` (${(peerInfo as OnlineUser).countryCode})`}.
              </p>
              <Card className="w-full max-w-sm p-6 bg-background shadow-lg rounded-xl border-primary/50">
                <div className="flex flex-col items-center text-center">
                    <Avatar className="w-24 h-24 mb-4 border-2 border-primary shadow-md">
                        <AvatarImage src={(peerInfo as UserProfile).photoUrl || (peerInfo as OnlineUser).photoUrl} alt={(peerInfo as OnlineUser).name} data-ai-hint={(peerInfo as OnlineUser).dataAiHint || (peerInfo as UserProfile).dataAiHint || "avatar abstract"}/>
                        <AvatarFallback>{(peerInfo as OnlineUser).name ? (peerInfo as OnlineUser).name.charAt(0).toUpperCase() : 'U'}</AvatarFallback>
                    </Avatar>
                    <h3 className="text-2xl font-semibold">{(peerInfo as OnlineUser).name}</h3>
                    <p className="text-sm text-muted-foreground">ID: {(peerInfo as OnlineUser | UserProfile).id.substring(0,8)}... {(peerInfo as OnlineUser).countryCode && `(${(peerInfo as OnlineUser).countryCode})`}</p>
                    {(peerInfo as UserProfile).bio && <p className="text-xs text-muted-foreground">Bio: {(peerInfo as UserProfile).bio}</p>}
                </div>
              </Card>
            </>
          ) : ( <p className="text-muted-foreground">The other user's information could not be loaded.</p> )}
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mt-4">
            <Button onClick={handleBackToOnlineUsers} size="lg" variant="secondary" className="flex-1">
              <VideoIcon className="mr-2 h-5 w-5" /> Back to Online Users
            </Button>
            {/* Report button on revealed screen */}
            {peerInfo && (peerInfo as OnlineUser | UserProfile).id && authCurrentUser && (peerInfo as OnlineUser).isGoogleUser &&(
                 <ReportDialog
                 reportedUser={{
                    id: (peerInfo as UserProfile).id,
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

    