
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { ProfileSetupDialog } from '@/components/features/profile/profile-setup-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { OnlineUser, IncomingCallOffer, CallAnswer, UserProfile } from '@/types';
import { PhoneOff, Video as VideoIcon, Shuffle, LogIn, LogOut, Edit3, Wifi, WifiOff } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, push, child, serverTimestamp, type DatabaseReference, get } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { OnlineUsersPanel } from '@/components/features/online-users/online-users-panel';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from '@/components/ui/card';
import { DebugLogPanel } from '@/components/features/debug/debug-log-panel';
import { useAuth } from '@/hooks/use-auth';
import { IncomingCallDialog } from '@/components/features/call/incoming-call-dialog';

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
  const [sessionUser, setSessionUser] = useState<OnlineUser | null>(null);

  const [chatState, setChatState] = useState<ChatState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [peerInfo, setPeerInfo] = useState<OnlineUser | UserProfile | null>(null);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [pageLoading, setPageLoading] = useState(true);
  const [isProfileEditDialogOpen, setIsProfileEditDialogOpen] = useState(false);
  const [incomingCallOfferDetails, setIncomingCallOfferDetails] = useState<IncomingCallOffer | null>(null);
  const [isManuallyOnline, setIsManuallyOnline] = useState(true); 

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
  const ringingAudioRef = useRef<HTMLAudioElement | null>(null);

  const firebaseListeners = useRef<Map<string, { ref: DatabaseReference, callback: (snapshot: any) => void, eventType: string }>>(new Map());
  const chatStateRef = useRef<ChatState>(chatState);
  const currentSessionUserIdRef = useRef<string | null>(null);
  const isPageVisibleRef = useRef<boolean>(true);
  const incomingCallOfferDetailsRef = useRef<IncomingCallOffer | null>(null);

  useEffect(() => {
    incomingCallOfferDetailsRef.current = incomingCallOfferDetails;
  }, [incomingCallOfferDetails]);

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

  useEffect(() => {
    const newAnonId = generateAnonymousSessionId();
    setAnonymousSessionId(newAnonId);
    addDebugLog(`Generated new anonymous session ID: ${newAnonId}`);
  }, [addDebugLog]);

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
        id: authCurrentUser.uid, name: authUserProfile.name, photoUrl: authUserProfile.photoUrl,
        dataAiHint: authUserProfile.dataAiHint, countryCode: authUserProfile.countryCode, isGoogleUser: true,
      };
      setSessionUser(googleSessionUser); currentSessionUserIdRef.current = authCurrentUser.uid;
      addDebugLog(`Active session user (Google): ${googleSessionUser.name} (${googleSessionUser.id})`);
      setPageLoading(false);
    } else if (authCurrentUser && isProfileSetupNeeded) {
      addDebugLog(`Google user ${authCurrentUser.uid} authenticated, but profile setup is needed. Page loading false, ProfileSetupDialog should show.`);
      setPageLoading(false);
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
          id: anonymousSessionId, name: `User-${anonymousSessionId.substring(0, 4)}`,
          photoUrl: `https://placehold.co/96x96.png?text=${anonymousSessionId.charAt(0).toUpperCase()}`,
          dataAiHint: 'abstract character', countryCode: countryCode, isGoogleUser: false,
        };
        setSessionUser(anonUser); currentSessionUserIdRef.current = anonymousSessionId;
        addDebugLog(`Anonymous session user created: ${anonUser.name} (${anonUser.id}) with country ${anonUser.countryCode}`);
        setPageLoading(false);
      };
      fetchCountryAndSetAnonymousUser();
    } else if (!authCurrentUser && !anonymousSessionId) {
      addDebugLog("Waiting for anonymous session ID to be generated. Page loading true.");
      setPageLoading(true);
    } else {
      addDebugLog(`Fell through sessionUser determination logic. Current user: ${authCurrentUser?.uid}, Anon ID: ${anonymousSessionId}. Setting pageLoading to false.`);
      setPageLoading(false);
    }
  }, [authCurrentUser, authUserProfile, anonymousSessionId, authLoading, authProfileLoading, isProfileSetupNeeded, addDebugLog]);

  const wrappedSetChatState = useCallback((newState: ChatState) => {
    addDebugLog(`Chat state changing from ${chatStateRef.current} to: ${newState}`);
    setChatState(newState);
  }, [addDebugLog]);

  const playRingingSound = useCallback(() => {
    if (ringingAudioRef.current) {
      ringingAudioRef.current.loop = true;
      ringingAudioRef.current.play().catch(e => addDebugLog(`Error playing ringing sound: ${e.message}`));
      addDebugLog("Ringing sound started.");
    }
  }, [addDebugLog]);

  const stopRingingSound = useCallback(() => {
    if (ringingAudioRef.current) {
      ringingAudioRef.current.pause();
      ringingAudioRef.current.currentTime = 0; 
      addDebugLog("Ringing sound stopped.");
    }
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
    const path = dbRef.toString().substring(dbRef.root.toString().length -1);
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
    }
    if (localStream) {
      localStream.getTracks().forEach(track => { addDebugLog(`Stopping local track: ${track.kind}`); track.stop(); });
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

    stopRingingSound();
    if (incomingCallOfferDetailsRef.current) setIncomingCallOfferDetails(null);

    cleanupWebRTC();
    if (currentRoomIdVal) {
      removeFirebaseListener(`callSignals/${currentRoomIdVal}/answer`);
      if (currentPeerIdVal) removeFirebaseListener(`iceCandidates/${currentRoomIdVal}/${currentPeerIdVal}`);
      if (myCurrentId) removeFirebaseListener(`iceCandidates/${currentRoomIdVal}/${myCurrentId}`);
    }

    await cleanupCallData();

    if (showReveal && currentPeerIdVal && wasConnected) {
      let peerToReveal: OnlineUser | UserProfile | null = onlineUsers.find(u => u.id === currentPeerIdVal) || (peerInfo?.id === currentPeerIdVal ? peerInfo : null);
      if (!peerToReveal && authCurrentUser) {
        addDebugLog(`Peer ${currentPeerIdVal} not readily available. Attempting to fetch their UserProfile if they are a Google User.`);
        try {
          const userRef = ref(db, `users/${currentPeerIdVal}`);
          const snapshot = await get(userRef);
          if (snapshot.exists()) {
            peerToReveal = snapshot.val() as UserProfile;
            addDebugLog(`Fetched full UserProfile for revealed peer ${currentPeerIdVal}`);
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
          id: currentPeerIdVal, name: `User-${currentPeerIdVal.substring(0,4)}`,
          photoUrl: `https://placehold.co/96x96.png?text=${currentPeerIdVal.charAt(0).toUpperCase()}`,
          dataAiHint: 'abstract character', countryCode: onlineUsers.find(u => u.id === currentPeerIdVal)?.countryCode || 'XX',
          isGoogleUser: tempPeerIsLikelyGoogleUser
        };
      }
      setPeerInfo(peerToReveal); wrappedSetChatState('revealed');
      addDebugLog(`Call ended. Transitioning to 'revealed' state with peer ${peerToReveal?.name || currentPeerIdVal}.`);
    } else {
      wrappedSetChatState('idle'); setPeerInfo(null);
      addDebugLog(`Call ended. Transitioning to 'idle' state (no reveal or peerId missing/not connected).`);
    }
    roomIdRef.current = null;
    if (chatStateRef.current === 'idle' || chatStateRef.current === 'revealed') {
      peerIdRef.current = null;
    }
    isCallerRef.current = false;
  }, [cleanupWebRTC, cleanupCallData, onlineUsers, peerInfo, removeFirebaseListener, addDebugLog, wrappedSetChatState, authCurrentUser, stopRingingSound]);

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
        setRemoteStream(event.streams[0]); addDebugLog(`Remote stream set from event.streams[0].`);
      } else {
        const newStream = new MediaStream([event.track]);
        setRemoteStream(newStream); addDebugLog(`Remote stream created from event.track and set.`);
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
    const sUser = sessionUser;
    if (!sUser || !sUser.id || targetUser.id === sUser.id) {
      addDebugLog(`Cannot call self or sessionUser is null. MyID: ${sUser?.id}, TargetID: ${targetUser.id}`);
      toast({title: "Call Error", description: "Cannot call self or session is not ready.", variant: "destructive"});
      return;
    }
    if (!isManuallyOnline) {
      toast({ title: "You are Offline", description: "Go online to make calls.", variant: "default" });
      addDebugLog(`Call attempt by ${sUser.id} to ${targetUser.id} blocked: user is manually offline.`);
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
        callerId: sUser.id, callerName: sUser.name, callerPhotoUrl: sUser.photoUrl,
        callerCountryCode: sUser.countryCode, callerIsGoogleUser: sUser.isGoogleUser || false,
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
            addDebugLog(`WARN: Caller: Remote description already set for room ${newRoomId}.`);
          }
          try {
            await peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(answerData.answer));
            addDebugLog(`Caller: Remote desc (answer) set successfully for room ${newRoomId}.`);
          } catch (e: any) {
            addDebugLog(`ERROR: Caller: setting remote desc (answer) for room ${newRoomId}: ${e.message || e}. PC State: ${peerConnectionRef.current.signalingState}`);
            handleEndCall(false); return;
          }
          removeFirebaseListener(answerDbRefPath);
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
            addDebugLog(`Caller: Received ICE candidate object from callee ${targetUser.id} for room ${newRoomId}.`);
            if (candidate.candidate && (candidate.sdpMid !== null || candidate.sdpMLineIndex !== null)) {
              peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => addDebugLog(`ERROR: Caller adding callee ICE for room ${newRoomId}: ${e.message || e}`));
            } else if (candidate.candidate) {
              addDebugLog(`WARN: Caller: Received ICE with null sdpMid/sdpMLineIndex from callee ${targetUser.id}.`);
            }
          } else if (candidate && peerConnectionRef.current && !peerConnectionRef.current.remoteDescription) {
            addDebugLog(`WARN: Caller received callee ICE for room ${newRoomId} but remote desc not set.`);
          } else if (candidate && (!peerConnectionRef.current || peerConnectionRef.current.signalingState === 'closed')){
            addDebugLog(`WARN: Caller received callee ICE for room ${newRoomId} but peer connection is null or closed.`);
          }
        });
      }, 'value');
    } catch (error: any) {
      addDebugLog(`ERROR initiating call from ${sUser.id} to ${targetUser.id} (room ${roomIdRef.current}): ${error.message || error}`);
      toast({ title: "Call Error", variant: "destructive", description: "Could not initiate call." });
      await handleEndCall(false);
    }
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, removeFirebaseListener, startLocalStream, addDebugLog, wrappedSetChatState, isManuallyOnline]);

  const processIncomingOfferAndAnswer = useCallback(async (offerData: IncomingCallOffer) => {
    const sUser = sessionUser;
    if (!sUser || !sUser.id ) {
      addDebugLog(`processIncomingOffer: No sessionUser, cannot process offer from ${offerData.callerId}.`);
      if(sUser?.id) remove(ref(db, `callSignals/${sUser.id}/pendingOffer`)).catch(e => addDebugLog(`WARN: Callee: Error removing stale pending offer (no sessionUser): ${e.message || e}`));
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
    toast({ title: "Connecting...", description: `Connecting to ${offerData.callerName}...` });
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
        answer: pc.localDescription!.toJSON(), calleeId: sUser.id, calleeIsGoogleUser: sUser.isGoogleUser || false,
      };
      const answerPath = `callSignals/${offerData.roomId}/answer`;
      await set(ref(db, answerPath), answerPayload);
      addDebugLog(`Callee ${sUser.id}: Answer sent to room ${offerData.roomId}.`);
      const myOfferPath = `callSignals/${sUser.id}/pendingOffer`;
      await remove(ref(db, myOfferPath));
      addDebugLog(`Callee ${sUser.id}: Removed processed pending offer from ${myOfferPath}.`);
      const callerIceCandidatesRefPath = `iceCandidates/${offerData.roomId}/${offerData.callerId}`;
      addFirebaseListener(ref(db, callerIceCandidatesRefPath), (snapshot: any) => {
        snapshot.forEach((childSnapshot: any) => {
          const candidate = childSnapshot.val();
          if (candidate && peerConnectionRef.current && peerConnectionRef.current.remoteDescription && peerConnectionRef.current.signalingState !== 'closed') {
            addDebugLog(`Callee ${sUser.id}: Received ICE candidate object from caller ${offerData.callerId}.`);
            if (candidate.candidate && (candidate.sdpMid !== null || candidate.sdpMLineIndex !== null)) {
              peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(e => addDebugLog(`ERROR: Callee ${sUser.id} adding caller ICE for room ${offerData.roomId}: ${e.message || e}`));
            } else if (candidate.candidate) {
              addDebugLog(`WARN: Callee ${sUser.id}: Received ICE with null sdpMid/sdpMLineIndex from caller ${offerData.callerId}.`);
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
  }, [sessionUser, initializePeerConnection, handleEndCall, toast, addFirebaseListener, startLocalStream, addDebugLog, wrappedSetChatState]);

  const handleAcceptCall = useCallback(async () => {
    addDebugLog("Call accepted by user.");
    stopRingingSound();
    const offerToProcess = incomingCallOfferDetailsRef.current; 
    setIncomingCallOfferDetails(null); 
    if (offerToProcess) {
      await processIncomingOfferAndAnswer(offerToProcess);
    } else {
      addDebugLog("WARN: handleAcceptCall invoked but no offerDetailsRef found.");
    }
  }, [processIncomingOfferAndAnswer, stopRingingSound, addDebugLog]);

  const handleDeclineCall = useCallback(async () => {
    addDebugLog("Call declined by user.");
    stopRingingSound();
    const offerToDecline = incomingCallOfferDetailsRef.current; 
    setIncomingCallOfferDetails(null); 

    if (offerToDecline && sessionUser?.id) {
      const pendingOfferPath = `callSignals/${sessionUser.id}/pendingOffer`;
      try {
        const dbOfferSnapshot = await get(ref(db, pendingOfferPath));
        if (dbOfferSnapshot.exists()) {
          const dbOfferData = dbOfferSnapshot.val() as IncomingCallOffer;
          if (dbOfferData.roomId === offerToDecline.roomId) {
            await remove(ref(db, pendingOfferPath));
            addDebugLog(`Removed pending offer from ${pendingOfferPath} after declining (room ${offerToDecline.roomId}).`);
            toast({ title: "Call Declined", variant: "default" });
          } else {
            addDebugLog(`Decline: Offer in DB (room ${dbOfferData.roomId}) is different from declined offer (room ${offerToDecline.roomId}). Not removing from DB.`);
          }
        } else {
          addDebugLog(`Decline: No pending offer found in DB at ${pendingOfferPath} to remove for declined room ${offerToDecline.roomId}.`);
        }
      } catch (e: any) {
        addDebugLog(`Error managing pending offer after declining: ${e.message || e}`);
      }
    }
    wrappedSetChatState('idle'); 
  }, [sessionUser, stopRingingSound, wrappedSetChatState, toast, addDebugLog]);


  const updateUserOnlineStatus = useCallback((shouldBeOnline: boolean) => {
    const sUser = sessionUser;
    if (!sUser || !sUser.id) {
      addDebugLog(`updateUserOnlineStatus: No sessionUser to update status for.`);
      return;
    }
    const userOnlinePath = `onlineUsers/${sUser.id}`;
    addDebugLog(`updateUserOnlineStatus: Setting ${sUser.id} to ${shouldBeOnline ? 'ONLINE' : 'OFFLINE'}. Page visible: ${isPageVisibleRef.current}`);

    if (shouldBeOnline && isPageVisibleRef.current) {
      const presenceData: OnlineUser = {
        ...sUser,
        timestamp: serverTimestamp()
      };
      set(ref(db, userOnlinePath), presenceData)
        .then(() => addDebugLog(`Set user ${sUser.id} online in DB.`))
        .catch(e => addDebugLog(`Error setting user ${sUser.id} online: ${e.message}`));
      
      if (!sUser.isGoogleUser && anonymousSessionId === sUser.id) {
        const userStatusDbRef = ref(db, userOnlinePath);
        if (userStatusDbRef && typeof userStatusDbRef.onDisconnect === 'function') {
          userStatusDbRef.onDisconnect().remove()
            .then(() => addDebugLog(`onDisconnect().remove() set for anonymous user ${sUser.id}.`))
            .catch(e => addDebugLog(`Error setting onDisconnect for anonymous ${sUser.id}: ${e.message}`));
        } else {
           addDebugLog(`ERROR - userStatusDbRef or onDisconnect not valid for anon ${sUser.id} in updateUserOnlineStatus.`);
        }
      }
    } else {
      remove(ref(db, userOnlinePath))
        .then(() => addDebugLog(`Removed user ${sUser.id} from online list.`))
        .catch(e => addDebugLog(`Error removing user ${sUser.id} from online list: ${e.message}`));
    }
  }, [sessionUser, anonymousSessionId, addDebugLog]);

  const handleToggleOnlineStatus = () => {
    const newOnlineStatus = !isManuallyOnline;
    setIsManuallyOnline(newOnlineStatus);
    updateUserOnlineStatus(newOnlineStatus);
    toast({
      title: newOnlineStatus ? "You are now Online" : "You are now Offline",
      description: newOnlineStatus ? "Other users can see and call you." : "You won't appear in the online list or receive calls.",
    });
  };

  useEffect(() => {
    if(sessionUser?.id){ 
        updateUserOnlineStatus(isManuallyOnline);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionUser, isManuallyOnline]); 

  useEffect(() => {
    if (authCurrentUser || !anonymousSessionId) {
      addDebugLog("Anonymous Presence (connection): Skipping - Google user active or anonymousSessionId not ready.");
      return;
    }
    if (!sessionUser || sessionUser.id !== anonymousSessionId || sessionUser.isGoogleUser) {
      addDebugLog(`Anonymous Presence (connection): Skipping - sessionUser (${sessionUser?.id}, isGoogle: ${sessionUser?.isGoogleUser}) not aligned with anonymous state (${anonymousSessionId}).`);
      return;
    }
    const myId = anonymousSessionId;
    addDebugLog(`Anonymous Presence (connection): Setting up for ${myId}. Name: ${sessionUser.name}, Country: ${sessionUser.countryCode}`);
    
    const connectedDbRef = ref(db, '.info/connected');
    const presenceCb = (snapshot: any) => {
      if (!currentSessionUserIdRef.current || currentSessionUserIdRef.current !== myId || authCurrentUser) {
        addDebugLog(`Anonymous Presence (connection) for ${myId}: Skipping update. Current user ref ${currentSessionUserIdRef.current} or authUser ${authCurrentUser?.uid} exists.`);
        return;
      }
      if (snapshot.val() === true) {
        addDebugLog(`Anonymous Presence (connection): Firebase connection established for ${myId}.`);
        if (isManuallyOnline && isPageVisibleRef.current) { 
           updateUserOnlineStatus(true); 
        }
      } else {
        addDebugLog(`Anonymous Presence (connection): Firebase connection lost for ${myId}. onDisconnect should handle removal.`);
      }
    };
    addFirebaseListener(connectedDbRef, presenceCb, 'value');
    return () => {
      addDebugLog(`Anonymous Presence (connection): Cleaning up for ${myId}. Detaching .info/connected listener.`);
      removeFirebaseListener(connectedDbRef.toString().substring(connectedDbRef.root.toString().length-1));
      if (myId && isManuallyOnline) { 
        const pathToRemove = `onlineUsers/${myId}`;
        remove(ref(db, pathToRemove))
          .then(() => addDebugLog(`Anonymous Presence (connection): Explicitly removed user ${myId} on cleanup.`))
          .catch(e => addDebugLog(`Anonymous Presence (connection): WARN: Error removing user ${myId} on cleanup: ${e.message || e}`));
      }
    };
  }, [authCurrentUser, anonymousSessionId, sessionUser, addFirebaseListener, removeFirebaseListener, addDebugLog, isManuallyOnline, updateUserOnlineStatus]);


  useEffect(() => {
    const onlineUsersDbRef = ref(db, 'onlineUsers');
    const onlineUsersCb = (snapshot: any) => {
      const usersData = snapshot.val();
      const userList: OnlineUser[] = [];
      if (usersData) {
        for (const key in usersData) {
          if (usersData[key] && typeof usersData[key].id === 'string') {
            userList.push(usersData[key] as OnlineUser);
          } else {
            addDebugLog(`WARN: Invalid user data found in onlineUsers for key ${key}.`);
          }
        }
      }
      const activeUserId = currentSessionUserIdRef.current;
      setOnlineUsers(userList.filter(u => u.id !== activeUserId));
    };
    addFirebaseListener(onlineUsersDbRef, onlineUsersCb, 'value');
    return () => removeFirebaseListener(onlineUsersDbRef.toString().substring(onlineUsersDbRef.root.toString().length-1));
  }, [addFirebaseListener, removeFirebaseListener, addDebugLog]);

  useEffect(() => {
    const myId = currentSessionUserIdRef.current;
    if (!myId) {
      addDebugLog(`Incoming call listener: No active user ID (currentSessionUserIdRef is ${myId}).`);
      if (incomingCallOfferDetailsRef.current) { 
        setIncomingCallOfferDetails(null);
        stopRingingSound();
      }
      return () => {};
    }

    const incomingCallDbRefPath = `callSignals/${myId}/pendingOffer`;
    addDebugLog(`Attaching incoming call listener at ${incomingCallDbRefPath}`);
    const incomingCallDbRef = ref(db, incomingCallDbRefPath);

    const incomingCallCb = (snapshot: any) => {
      const newOfferData = snapshot.val() as IncomingCallOffer | null;
      const currentDisplayedOffer = incomingCallOfferDetailsRef.current;

      addDebugLog(`Offer listener triggered. New data exists: ${!!newOfferData}. Current displayed offer RoomID: ${currentDisplayedOffer?.roomId}. Chat state: ${chatStateRef.current}. Manually Online: ${isManuallyOnline}`);

      if (newOfferData) {
        if (!isManuallyOnline) {
            addDebugLog(`Incoming call for ${myId} from ${newOfferData.callerId} but user is manually OFFLINE. Removing offer from DB.`);
            remove(incomingCallDbRef).catch(e => addDebugLog(`WARN: Error removing stale offer (user offline): ${e.message || e}`));
            if (currentDisplayedOffer?.roomId === newOfferData.roomId) {
                setIncomingCallOfferDetails(null);
                stopRingingSound();
            }
            return;
        }

        if (chatStateRef.current === 'idle') {
          if (!currentDisplayedOffer || currentDisplayedOffer.roomId !== newOfferData.roomId) { 
            addDebugLog(`Valid new/different offer by ${myId} from ${newOfferData.callerName}. Setting to state. New Room: ${newOfferData.roomId}`);
            setIncomingCallOfferDetails(newOfferData);
            playRingingSound();
            toast({ title: "Incoming Call", description: `From ${newOfferData.callerName}`, duration: 15000 });
          } else {
            addDebugLog(`Offer listener: Received same offer data (Room: ${newOfferData.roomId}) as currently displayed. No state change needed.`);
          }
        } else { // User is not idle (e.g. in another call, dialing)
          addDebugLog(`WARN: ${myId} received offer from ${newOfferData.callerId} (room ${newOfferData.roomId}) while in state ${chatStateRef.current}. Removing this offer from DB as user is busy.`);
          // Only remove if it's a different offer than one potentially being processed or if we are truly busy.
          if (!currentDisplayedOffer || currentDisplayedOffer.roomId !== newOfferData.roomId) {
             remove(incomingCallDbRef).catch(e => addDebugLog(`WARN: Error removing offer (user busy) by ${myId} from DB: ${e.message || e}`));
          }
          // If the current displayed offer (somehow, if logic allows) matches this new one while busy, clear it
          if (currentDisplayedOffer?.roomId === newOfferData.roomId) { 
            setIncomingCallOfferDetails(null);
            stopRingingSound();
          }
        }
      } else { // newOfferData is null (offer removed from Firebase)
        addDebugLog(`Offer listener at ${incomingCallDbRefPath} received null data.`);
        if (currentDisplayedOffer) { 
          addDebugLog(`Pending offer (room ${currentDisplayedOffer.roomId}) removed for ${myId}. Clearing displayed offer & stopping ring.`);
          setIncomingCallOfferDetails(null);
          stopRingingSound();
        }
      }
    };

    addFirebaseListener(incomingCallDbRef, incomingCallCb, 'value');
    return () => {
      addDebugLog(`Cleaning up incoming call listener for path: ${incomingCallDbRefPath}`);
      removeFirebaseListener(incomingCallDbRefPath);
      if(incomingCallOfferDetailsRef.current && incomingCallOfferDetailsRef.current.callerId === myId) {
         // If the offer being cleared was one *I* made (which shouldn't be handled by *this* listener path),
         // it implies complex state. Usually this listener is for offers *to* me.
         // For safety, ensure ringing stops if any offer was displayed.
      }
      stopRingingSound(); // General stop on cleanup
    };
  }, [currentSessionUserIdRef.current, addFirebaseListener, removeFirebaseListener, addDebugLog, playRingingSound, stopRingingSound, toast, isManuallyOnline]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      const currentSUser = sessionUser;
      if (!currentSUser || !currentSUser.id) {
        addDebugLog("Page Visibility: No currentSUser or currentSUser.id.");
        return;
      }
      
      const userOnlinePath = `onlineUsers/${currentSUser.id}`;
      if (document.hidden) {
        addDebugLog(`Page hidden for ${currentSUser.id}. isManuallyOnline: ${isManuallyOnline}`);
        isPageVisibleRef.current = false;
        if (isManuallyOnline) { 
          remove(ref(db, userOnlinePath))
            .then(() => addDebugLog(`Page Visibility: Removed user ${currentSUser.id} from online list (was manually online).`))
            .catch(e => addDebugLog(`Page Visibility: Error removing user ${currentSUser.id} on page hide: ${e.message}`));
        }
      } else {
        addDebugLog(`Page visible for ${currentSUser.id}. isManuallyOnline: ${isManuallyOnline}`);
        isPageVisibleRef.current = true;
        if (isManuallyOnline) { 
          updateUserOnlineStatus(true);
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handleVisibilityChange);
    window.addEventListener('pageshow', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
      addDebugLog("Cleaned up Page Visibility listeners.");
    };
  }, [sessionUser, addDebugLog, authCurrentUser, anonymousSessionId, isManuallyOnline, updateUserOnlineStatus]);

  useEffect(() => {
    const myIdOnUnmount = currentSessionUserIdRef.current;
    return () => {
      addDebugLog(`HomePage unmounting for user ${myIdOnUnmount || 'N/A'}. Performing full cleanup.`);
      handleEndCall(false);
      cleanupAllFirebaseListeners();
      if (myIdOnUnmount && isManuallyOnline) {
        addDebugLog(`User ${myIdOnUnmount} was manually online, ensuring removal if not handled by onDisconnect (e.g., anon user).`);
        remove(ref(db, `onlineUsers/${myIdOnUnmount}`))
          .catch(e => addDebugLog(`Error removing user ${myIdOnUnmount} during unmount cleanup: ${e.message}`));
      }
      addDebugLog(`Full cleanup on unmount complete for ${myIdOnUnmount || 'N/A'}.`);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authCurrentUser, isManuallyOnline]); 

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
    if (!isManuallyOnline) {
      toast({ title: "You are Offline", description: "Go online to use 'Feeling Lucky'.", variant: "default" });
      addDebugLog("Feeling Lucky: User is manually offline.");
      return;
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
      await updateUserProfile(data);
      setIsProfileEditDialogOpen(false);
    } catch (error) {
      addDebugLog(`Error saving profile: ${error}`);
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

  if (authCurrentUser && isProfileSetupNeeded && !authProfileLoading) {
    return (
      <MainLayout>
        <div className="absolute top-4 right-4">
          <Button onClick={signOutUser} variant="outline">
            <LogOut className="mr-2 h-4 w-4" /> Sign Out
          </Button>
        </div>
        <ProfileSetupDialog
          isOpen={true} onOpenChange={() => {}}
          user={{id: authCurrentUser.uid, name: authCurrentUser.displayName || '', email: authCurrentUser.email || '', photoUrl: authCurrentUser.photoURL || undefined}}
          onSave={handleProfileSave} existingProfile={authUserProfile}
        />
      </MainLayout>
    );
  }

  if (!sessionUser && !authLoading && !authProfileLoading) {
    return (
      <MainLayout><p className="text-destructive">Error: Session could not be initialized. Please refresh.</p></MainLayout>
    );
  }
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

  return (
    <MainLayout>
      <audio ref={ringingAudioRef} src="/ringing.mp3" preload="auto" />

      <IncomingCallDialog
        isOpen={!!incomingCallOfferDetails && chatState === 'idle' && isManuallyOnline}
        offer={incomingCallOfferDetails}
        onAccept={handleAcceptCall}
        onDecline={handleDeclineCall}
      />

      <div className="absolute top-4 right-4 flex gap-2">
        {!authCurrentUser ? (
          <Button onClick={signInWithGoogle} variant="outline">
            <LogIn className="mr-2 h-4 w-4" /> Sign in with Google
          </Button>
        ) : (
          <>
            {authUserProfile && (
              <Button onClick={() => setIsProfileEditDialogOpen(true)} variant="outline">
                <Edit3 className="mr-2 h-4 w-4" /> Edit Profile
              </Button>
            )}
            <Button onClick={signOutUser} variant="outline">
              <LogOut className="mr-2 h-4 w-4" /> Sign Out
            </Button>
            {authUserProfile && authCurrentUser && (
              <ProfileSetupDialog
                isOpen={isProfileEditDialogOpen} onOpenChange={setIsProfileEditDialogOpen}
                user={{
                  id: authCurrentUser.uid, displayName: authCurrentUser.displayName || '',
                  email: authCurrentUser.email || '', photoUrl: authCurrentUser.photoURL || undefined
                }}
                onSave={handleProfileSave} isEditing={true} existingProfile={authUserProfile}
              />
            )}
          </>
        )}
      </div>

      <div className="text-center mb-4">
        <h1 className="text-4xl font-bold text-primary mb-2">BlindSpot Social</h1>
        <p className="text-lg text-foreground/80">Connect Directly. Chat Visually.</p>
      </div>

      {chatState === 'idle' && sessionUser && !incomingCallOfferDetails && (
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
            <CardContent className="pt-0 pb-4 flex justify-center">
               <Button onClick={handleToggleOnlineStatus} variant={isManuallyOnline ? "outline" : "default"} size="sm">
                {isManuallyOnline ? <WifiOff className="mr-2 h-4 w-4" /> : <Wifi className="mr-2 h-4 w-4" />}
                {isManuallyOnline ? "Go Offline" : "Go Online"}
              </Button>
            </CardContent>
          </Card>

          {!isManuallyOnline && (
            <div className="text-center p-4 my-4 bg-muted/50 rounded-md w-full">
              <WifiOff className="w-10 h-10 mx-auto text-muted-foreground mb-2" />
              <p className="font-semibold text-foreground">You are Currently Offline</p>
              <p className="text-sm text-muted-foreground">Click "Go Online" above to see users and make calls.</p>
            </div>
          )}

          {isManuallyOnline && (
            <div className="w-full mt-4">
              <OnlineUsersPanel
                onlineUsers={onlineUsers}
                onInitiateCall={initiateDirectCall}
                currentUserId={sessionUser.id}
              />
            </div>
          )}
          {isManuallyOnline && onlineUsers.filter(u => u.id !== sessionUser?.id).length > 0 && (
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
            {chatState === 'connected' && peerInfo && (peerInfo as OnlineUser | UserProfile).id && authCurrentUser && (peerInfo as OnlineUser).isGoogleUser && (
              <ReportDialog
                reportedUser={{
                  id: (peerInfo as UserProfile).id, name: (peerInfo as UserProfile).name || (peerInfo as OnlineUser).name,
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
            {peerInfo && (peerInfo as OnlineUser | UserProfile).id && authCurrentUser && (peerInfo as OnlineUser).isGoogleUser &&(
              <ReportDialog
                reportedUser={{
                  id: (peerInfo as UserProfile).id, name: (peerInfo as UserProfile).name || (peerInfo as OnlineUser).name,
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

