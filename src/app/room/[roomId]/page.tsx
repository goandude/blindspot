
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { MainLayout } from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, serverTimestamp, type DatabaseReference, push, child } from 'firebase/database';
import type { OnlineUser, UserProfile, RoomSignal } from '@/types';
import { Video as VideoIcon, Mic, MicOff, VideoOff as VideoOffIcon, PhoneOff, Users as UsersIcon, LogOut, Copy, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';

const servers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

interface RemoteStreamEntry {
  stream: MediaStream;
  userInfo?: OnlineUser;
}

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const roomId = typeof params.roomId === 'string' ? params.roomId : null;
  const { toast } = useToast();

  const { currentUser: authCurrentUser, userProfile: authUserProfile, loading: authLoading } = useAuth();
  const [sessionUser, setSessionUser] = useState<OnlineUser | null>(null);
  const generatedAnonymousIdRef = useRef<string | null>(null);

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RemoteStreamEntry>>(new Map());
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [participants, setParticipants] = useState<OnlineUser[]>([]);
  const participantsRef = useRef(participants); 

  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isInRoom, setIsInRoom] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  const firebaseListeners = useRef<Map<string, { ref: DatabaseReference, callback: (snapshot: any) => void, eventType: string }>>(new Map());

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  const addDebugLog = useCallback((message: string) => {
    // Debug logging is now internal, not displayed in UI
    // console.log(`[Room DEBUG] ${roomId?.substring(0,4) || 'N/A'} - ${sessionUser?.id?.substring(0,4) || 'N/A'} - ${message}`);
  }, [sessionUser, roomId]);

  const addFirebaseDbListener = useCallback((dbRef: DatabaseReference, callback: (snapshot: any) => void, eventType: 'value' | 'child_added' | 'child_changed' | 'child_removed' = 'value') => {
    const path = dbRef.toString().substring(dbRef.root.toString().length -1);
    if (firebaseListeners.current.has(path + eventType)) {
      addDebugLog(`Listener for path ${path} (${eventType}) already exists. Removing old one first.`);
      const oldEntry = firebaseListeners.current.get(path + eventType);
      if (oldEntry) off(oldEntry.ref, oldEntry.eventType as any, oldEntry.callback);
    }
    onValue(dbRef, callback, (error) => { 
        addDebugLog(`ERROR reading from ${path} (event: ${eventType}): ${error.message}`);
    });
    firebaseListeners.current.set(path + eventType, { ref: dbRef, callback, eventType });
    addDebugLog(`Added Firebase listener for path: ${path} with eventType: ${eventType}`);
  }, [addDebugLog]);

  const removeFirebaseDbListener = useCallback((dbRef: DatabaseReference, eventType: 'value' | 'child_added' | 'child_changed' | 'child_removed' = 'value') => {
    const path = dbRef.toString().substring(dbRef.root.toString().length -1);
    const listenerEntry = firebaseListeners.current.get(path + eventType);
    if (listenerEntry) {
        off(listenerEntry.ref, listenerEntry.eventType as any, listenerEntry.callback);
        firebaseListeners.current.delete(path + eventType);
        addDebugLog(`Removed Firebase listener for path: ${path} (${eventType})`);
    }
  }, [addDebugLog]);

  useEffect(() => {
    addDebugLog(`Auth state check: authLoading=${authLoading}, authCurrentUser=${!!authCurrentUser}, authUserProfile=${!!authUserProfile}, current sessionUser=${!!sessionUser}, generatedAnonId=${generatedAnonymousIdRef.current}`);
    if (authLoading) {
      addDebugLog("Auth still loading, RoomPage waiting...");
      if (!isLoading) setIsLoading(true);
      return;
    }

    if (sessionUser) {
      if (isLoading) setIsLoading(false);
      return;
    }

    if (authCurrentUser && authUserProfile) {
      addDebugLog(`Authenticated user for room: ${authUserProfile.name} (${authCurrentUser.uid})`);
      const googleSessionUser: OnlineUser = {
        id: authCurrentUser.uid, name: authUserProfile.name, photoUrl: authUserProfile.photoUrl,
        dataAiHint: authUserProfile.dataAiHint, countryCode: authUserProfile.countryCode, isGoogleUser: true,
      };
      setSessionUser(googleSessionUser);
      setIsLoading(false);
    } else if (!authCurrentUser) {
      if (!generatedAnonymousIdRef.current) {
        generatedAnonymousIdRef.current = `anon-room-${Math.random().toString(36).substring(2, 10)}`;
        addDebugLog(`Generated new anonymous ID for room: ${generatedAnonymousIdRef.current}`);
      }
      const currentAnonId = generatedAnonymousIdRef.current!;
      addDebugLog(`Creating anonymous session for room with ID: ${currentAnonId}.`);
      const fetchCountryAndSetAnonymousUser = async () => {
        let countryCode = 'XX';
        try {
          const response = await fetch('https://ipapi.co/country_code/');
          if (response.ok) countryCode = (await response.text()).trim();
          else addDebugLog(`Failed to fetch country for anon user: ${response.status}`);
        } catch (e: any) { addDebugLog(`WARN: Error fetching country for anonymous user: ${e.message || e}`); }
        const anonUser: OnlineUser = {
          id: currentAnonId, name: `User-${currentAnonId.substring(10, 14)}`,
          photoUrl: `https://placehold.co/96x96.png?text=${currentAnonId.charAt(10).toUpperCase()}`,
          dataAiHint: 'abstract character', countryCode, isGoogleUser: false,
        };
        setSessionUser(anonUser);
        setIsLoading(false);
        addDebugLog(`Anonymous session for room created: ${anonUser.name} (${anonUser.id})`);
      };
      fetchCountryAndSetAnonymousUser();
    } else {
      addDebugLog("Auth user exists but profile might be incomplete. RoomPage continues loading or awaiting profile.");
      if (!isLoading) setIsLoading(true);
    }
  }, [authCurrentUser, authUserProfile, authLoading, addDebugLog, sessionUser, isLoading]);

  const cleanupPeerConnection = useCallback((peerId: string) => {
    addDebugLog(`Cleaning up peer connection for ${peerId}`);
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.ontrack = null; pc.onicecandidate = null; pc.oniceconnectionstatechange = null; pc.onsignalingstatechange = null;
      pc.getSenders().forEach(sender => {
        if (sender.track) sender.track.stop();
        try { if(pc.signalingState !== 'closed') pc.removeTrack(sender); } catch (e) { addDebugLog(`Error removing track for ${peerId}: ${e}`);}
      });
      if (pc.signalingState !== 'closed') pc.close();
      peerConnectionsRef.current.delete(peerId);
    }
    setRemoteStreams(prev => { const newStreams = new Map(prev); newStreams.delete(peerId); return newStreams; });
  }, [addDebugLog]);

  const handleLeaveRoom = useCallback(async () => {
    addDebugLog(`Leaving room ${roomId}. Current user: ${sessionUser?.id}`);
    setIsInRoom(false);
    if (localStream) { localStream.getTracks().forEach(track => track.stop()); setLocalStream(null); addDebugLog("Local stream stopped."); }
    peerConnectionsRef.current.forEach((_, peerId) => { addDebugLog(`Cleaning up PC for ${peerId} during leave room.`); cleanupPeerConnection(peerId); });
    peerConnectionsRef.current.clear();
    setRemoteStreams(new Map());
    addDebugLog("All peer connections cleaned up.");
    if (roomId && sessionUser?.id) {
      remove(ref(db, `conferenceRooms/${roomId}/participants/${sessionUser.id}`)).catch(e => addDebugLog(`Error removing self from participants: ${e.message}`));
      remove(ref(db, `conferenceRooms/${roomId}/signals/${sessionUser.id}`)).catch(e => addDebugLog(`Error removing my signals folder: ${e.message}`));
      addDebugLog(`Removed self from participants and signals for room ${roomId}.`);
    }
    firebaseListeners.current.forEach(({ ref: fRef, callback, eventType }) => { off(fRef, eventType as any, callback); addDebugLog(`Detached listener for ${fRef.toString()} type ${eventType}`); });
    firebaseListeners.current.clear();
    addDebugLog("All Firebase listeners cleared.");
    setParticipants([]);
    toast({ title: "Left Room", description: "You have left the conference room." });
    router.push('/');
  }, [roomId, sessionUser, localStream, cleanupPeerConnection, addDebugLog, toast, router]);

  const initializeAndSendOffer = useCallback(async (peerId: string, peerName?: string) => {
    if (!localStream || !roomId || !sessionUser?.id || peerConnectionsRef.current.has(peerId)) {
      addDebugLog(`Cannot send offer to ${peerId}. Conditions not met. LocalStream: ${!!localStream}, RoomId: ${!!roomId}, SessionUser: ${!!sessionUser?.id}, PC Exists: ${peerConnectionsRef.current.has(peerId)}`);
      return;
    }
    addDebugLog(`Initializing PC and sending offer to ${peerId} (${peerName || 'Unknown'})`);
    const pc = new RTCPeerConnection(servers);
    peerConnectionsRef.current.set(peerId, pc);
    localStream.getTracks().forEach(track => { try { pc.addTrack(track, localStream); addDebugLog(`Added local track ${track.kind} for peer ${peerId}`); } catch (e: any) { addDebugLog(`Error adding local track for ${peerId}: ${e.message}`); }});
    pc.onicecandidate = event => {
      if (event.candidate && roomId && sessionUser?.id) {
        addDebugLog(`Generated ICE candidate for ${peerId}: ${event.candidate.candidate.substring(0,30)}...`);
        const signalPayload: RoomSignal = { type: 'candidate', senderId: sessionUser.id, senderName: sessionUser.name, data: event.candidate.toJSON() };
        set(push(ref(db, `conferenceRooms/${roomId}/signals/${peerId}`)), signalPayload).catch(e => addDebugLog(`Error sending ICE candidate to ${peerId}: ${e.message}`));
      }
    };
    pc.ontrack = event => {
      addDebugLog(`Remote track received from ${peerId}: Kind: ${event.track.kind}. Stream(s): ${event.streams.length}`);
      setRemoteStreams(prevRemoteStreams => {
        const newRemoteStreams = new Map(prevRemoteStreams);
        let entry = newRemoteStreams.get(peerId);
        const currentParticipantData = participantsRef.current.find(p => p.id === peerId);
        if (!entry) { const newStream = new MediaStream(); entry = { stream: newStream, userInfo: currentParticipantData }; newRemoteStreams.set(peerId, entry); addDebugLog(`Created new stream entry for ${peerId}`); }
        event.streams[0].getTracks().forEach(track => { if (!entry!.stream.getTrackById(track.id)) { entry!.stream.addTrack(track); addDebugLog(`Added track ${track.kind} to stream for ${peerId}`); }});
        if (currentParticipantData && (!entry.userInfo || entry.userInfo.name !== currentParticipantData.name || entry.userInfo.photoUrl !== currentParticipantData.photoUrl)) {
          newRemoteStreams.set(peerId, { ...entry, userInfo: currentParticipantData }); addDebugLog(`Updated userInfo for ${peerId}. New name: ${currentParticipantData?.name}`);
        } else if (!currentParticipantData && entry.userInfo) {
          newRemoteStreams.set(peerId, { ...entry, userInfo: undefined }); addDebugLog(`Cleared userInfo for ${peerId} as participant data not found.`);
        }
        addDebugLog(`Updated remote stream for ${peerId}. Total tracks in stream: ${entry.stream.getTracks().length}`);
        return newRemoteStreams;
      });
    };
    pc.oniceconnectionstatechange = () => { addDebugLog(`ICE state for ${peerId}: ${pc.iceConnectionState}`); if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) { addDebugLog(`ICE connection to ${peerId} ${pc.iceConnectionState}. Cleaning up.`); cleanupPeerConnection(peerId); }};
    pc.onsignalingstatechange = () => addDebugLog(`Signaling state for ${peerId}: ${pc.signalingState}`);
    try {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer); addDebugLog(`Offer created and local description set for ${peerId}.`);
      const offerPayload: RoomSignal = { type: 'offer', senderId: sessionUser.id, senderName: sessionUser.name, data: pc.localDescription!.toJSON() };
      await set(push(ref(db, `conferenceRooms/${roomId}/signals/${peerId}`)), offerPayload); addDebugLog(`Offer sent to ${peerId}`);
    } catch (error: any) { addDebugLog(`Error creating/sending offer to ${peerId}: ${error.message}`); cleanupPeerConnection(peerId); }
  }, [localStream, roomId, sessionUser, addDebugLog, cleanupPeerConnection]);

  useEffect(() => {
    if (!isInRoom || !roomId || !sessionUser?.id || !localStream) { addDebugLog(`Main useEffect skipped. isInRoom: ${isInRoom}, roomId: ${!!roomId}, sessionUser: ${!!sessionUser?.id}, localStream: ${!!localStream}`); return; }
    addDebugLog(`Setting up Firebase listeners for room ${roomId}, user ${sessionUser.id}`);
    const mySignalsDbRef = ref(db, `conferenceRooms/${roomId}/signals/${sessionUser.id}`);
    const signalsCallback = (snapshot: any) => {
      if (!snapshot.exists()) return;
      snapshot.forEach((childSnapshot: any) => {
        const signal = childSnapshot.val() as RoomSignal; const signalKey = childSnapshot.key; const { senderId, senderName, type, data } = signal;
        if (!senderId || senderId === sessionUser.id || !signalKey) return; 
        addDebugLog(`Received signal type '${type}' from ${senderId} (${senderName || 'Unknown'})`);
        let pc = peerConnectionsRef.current.get(senderId);
        if (type === 'offer') {
          if (pc && pc.signalingState !== 'closed') { addDebugLog(`WARN: Received offer from ${senderId}, but PC already exists and is not closed. State: ${pc.signalingState}. Cleaning up old one.`); cleanupPeerConnection(senderId); }
          pc = new RTCPeerConnection(servers); peerConnectionsRef.current.set(senderId, pc); addDebugLog(`Created new PC for offer from ${senderId}`);
          localStream.getTracks().forEach(track => { try { pc!.addTrack(track, localStream); addDebugLog(`Added local track ${track.kind} to PC for ${senderId} (on offer)`);} catch (e:any) { addDebugLog(`Error adding local track on offer from ${senderId}: ${e.message}`); }});
          pc.onicecandidate = event => { if (event.candidate && roomId && sessionUser?.id) { addDebugLog(`Generated ICE candidate for ${senderId} (replying to offer): ${event.candidate.candidate.substring(0,30)}...`); const candidatePayload: RoomSignal = { type: 'candidate', senderId: sessionUser.id, senderName: sessionUser.name, data: event.candidate.toJSON() }; set(push(ref(db, `conferenceRooms/${roomId}/signals/${senderId}`)), candidatePayload).catch(e => addDebugLog(`Error sending ICE to ${senderId} (on offer): ${e.message}`)); }};
          pc.ontrack = event => {
            addDebugLog(`Remote track received from ${senderId} (on offer path): Kind: ${event.track.kind}`);
            setRemoteStreams(prevRemoteStreams => {
              const newRemoteStreams = new Map(prevRemoteStreams); let entry = newRemoteStreams.get(senderId); const currentParticipantData = participantsRef.current.find(p => p.id === senderId);
              if (!entry) { const newStream = new MediaStream(); entry = { stream: newStream, userInfo: currentParticipantData }; newRemoteStreams.set(senderId, entry); addDebugLog(`Created new stream entry for ${senderId} via offer path`); }
              event.streams[0].getTracks().forEach(track => { if(!entry!.stream.getTrackById(track.id)) { entry!.stream.addTrack(track); addDebugLog(`Added track ${track.kind} to stream for ${senderId} via offer path`); }});
              if (currentParticipantData && (!entry.userInfo || entry.userInfo.name !== currentParticipantData.name || entry.userInfo.photoUrl !== currentParticipantData.photoUrl)) {
                newRemoteStreams.set(senderId, { ...entry, userInfo: currentParticipantData }); addDebugLog(`Updated userInfo for ${senderId} via offer path. New name: ${currentParticipantData?.name}`);
              } else if (!currentParticipantData && entry.userInfo) {
                newRemoteStreams.set(senderId, { ...entry, userInfo: undefined }); addDebugLog(`Cleared userInfo for ${senderId} (offer path) as participant data not found.`);
              }
              addDebugLog(`Updated remote stream for ${senderId} (on offer path). Total tracks: ${entry.stream.getTracks().length}`);
              return newRemoteStreams;
            });
          };
          pc.oniceconnectionstatechange = () => { addDebugLog(`ICE state for ${senderId} (on offer path): ${pc!.iceConnectionState}`); if (['failed', 'disconnected', 'closed'].includes(pc!.iceConnectionState)) { addDebugLog(`ICE connection to ${senderId} ${pc!.iceConnectionState} (on offer path). Cleaning up.`); cleanupPeerConnection(senderId); }};
          pc.onsignalingstatechange = () => addDebugLog(`Signaling state for ${senderId} (on offer path): ${pc!.signalingState}`);
          pc!.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit))
            .then(() => { addDebugLog(`Remote desc (offer) from ${senderId} set.`); return pc!.createAnswer(); })
            .then(answer => { addDebugLog(`Answer created for ${senderId}.`); return pc!.setLocalDescription(answer); })
            .then(() => { addDebugLog(`Local desc (answer) for ${senderId} set.`); const answerPayload: RoomSignal = { type: 'answer', senderId: sessionUser.id!, senderName: sessionUser.name, data: pc!.localDescription!.toJSON() }; return set(push(ref(db, `conferenceRooms/${roomId}/signals/${senderId}`)), answerPayload); })
            .then(() => addDebugLog(`Answer sent to ${senderId}`))
            .catch(e => { addDebugLog(`Error processing offer / sending answer to ${senderId}: ${e.message || e}`); cleanupPeerConnection(senderId); });
        } else if (type === 'answer' && pc && pc.signalingState !== 'closed') {
          pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit)).then(() => addDebugLog(`Remote description (answer) set from ${senderId}`)).catch(e => addDebugLog(`Error setting remote desc (answer) from ${senderId}: ${e.message || e}. PC state: ${pc.signalingState}`));
        } else if (type === 'candidate' && pc && pc.signalingState !== 'closed') {
           if (pc.remoteDescription) { pc.addIceCandidate(new RTCIceCandidate(data as RTCIceCandidateInit)).then(() => addDebugLog(`Added ICE candidate from ${senderId}`)).catch(e => addDebugLog(`Error adding ICE candidate from ${senderId}: ${e.message || e}. PC state: ${pc.signalingState}`)); } 
           else { addDebugLog(`WARN: Received ICE candidate from ${senderId} but remote description not yet set. Candidate might be queued or dropped.`); }
        } else if (pc && pc.signalingState === 'closed' && (type === 'answer' || type === 'candidate')){ addDebugLog(`Received ${type} from ${senderId} but PC is already closed. Ignoring.`); }
        remove(child(mySignalsDbRef, signalKey)).catch(e => addDebugLog(`Failed to remove processed signal ${signalKey}: ${e.message}`));
      });
    };
    addFirebaseDbListener(mySignalsDbRef, signalsCallback, 'value');
    const participantsDbRef = ref(db, `conferenceRooms/${roomId}/participants`);
    const participantsCallback = (snapshot: any) => {
      const newParticipantsList: OnlineUser[] = []; snapshot.forEach((childSnapshot: any) => { newParticipantsList.push({ id: childSnapshot.key, ...childSnapshot.val() } as OnlineUser); });
      setParticipants(newParticipantsList); addDebugLog(`Participants updated: ${newParticipantsList.map(p => `${p.name}(${p.id.substring(0,4)})`).join(', ')} (${newParticipantsList.length} total)`);
      newParticipantsList.forEach(p => { if (p.id !== sessionUser.id && !peerConnectionsRef.current.has(p.id) && localStream) { addDebugLog(`New participant ${p.name} (${p.id}) detected. Initializing connection.`); initializeAndSendOffer(p.id, p.name); }});
      peerConnectionsRef.current.forEach((_, pcPeerId) => { if (!newParticipantsList.find(p => p.id === pcPeerId)) { addDebugLog(`Participant ${pcPeerId} left. Cleaning up their connection.`); cleanupPeerConnection(pcPeerId); }});
    };
    addFirebaseDbListener(participantsDbRef, participantsCallback, 'value');
    return () => { addDebugLog(`Cleaning up Firebase listeners for room ${roomId}, user ${sessionUser.id} (main useEffect)`); removeFirebaseDbListener(mySignalsDbRef, 'value'); removeFirebaseDbListener(participantsDbRef, 'value'); };
  }, [isInRoom, roomId, sessionUser, localStream, initializeAndSendOffer, cleanupPeerConnection, addDebugLog, addFirebaseDbListener, removeFirebaseDbListener]);

  const handleJoinRoom = async () => {
    if (!sessionUser || !sessionUser.id || !roomId) { toast({ title: "Error", description: "Session, User ID, or Room ID missing.", variant: "destructive" }); addDebugLog("JoinRoom: sessionUser, sessionUser.id, or roomId missing."); return; }
    addDebugLog(`Attempting to join room ${roomId} as ${sessionUser.name} (${sessionUser.id})`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream); setIsMicOn(true); setIsVideoOn(true); addDebugLog("Local media stream acquired.");
      const participantRefPath = `conferenceRooms/${roomId}/participants/${sessionUser.id}`;
      const participantDbRef = ref(db, participantRefPath);
      const participantData: OnlineUser = { id: sessionUser.id, name: sessionUser.name, photoUrl: sessionUser.photoUrl, dataAiHint: sessionUser.dataAiHint, isGoogleUser: sessionUser.isGoogleUser, countryCode: sessionUser.countryCode, timestamp: serverTimestamp() };
      await set(participantDbRef, participantData);
      if (participantDbRef && typeof participantDbRef.onDisconnect === 'function') {
        participantDbRef.onDisconnect().remove().then(() => addDebugLog(`onDisconnect set for participant ${sessionUser.id}`)).catch(e => addDebugLog(`Error setting onDisconnect for participant ${sessionUser.id}: ${e.message}`));
      } else { addDebugLog(`ERROR: participantDbRef or onDisconnect not valid for participant ${sessionUser.id} in handleJoinRoom.`); }
      setIsInRoom(true); toast({ title: "Joined Room!", description: `You are now in room ${roomId}.` }); addDebugLog("Successfully joined room and set presence.");
    } catch (err: any) { addDebugLog(`Error joining room or getting media: ${err.message}`); toast({ title: "Join Error", description: `Could not join room: ${err.message}`, variant: "destructive" }); if (localStream) { localStream.getTracks().forEach(track => track.stop()); setLocalStream(null); }}
  };

  const toggleMic = () => { if (localStream) { const enabled = !isMicOn; localStream.getAudioTracks().forEach(track => track.enabled = enabled); setIsMicOn(enabled); addDebugLog(`Mic toggled: ${enabled ? 'ON' : 'OFF'}`); }};
  const toggleVideo = () => { if (localStream) { const enabled = !isVideoOn; localStream.getVideoTracks().forEach(track => track.enabled = enabled); setIsVideoOn(enabled); addDebugLog(`Video toggled: ${enabled ? 'ON' : 'OFF'}`); }};
  const copyRoomLinkToClipboard = () => { const link = window.location.href; navigator.clipboard.writeText(link).then(() => toast({ title: "Link Copied!", description: "Room link copied to clipboard." })).catch(err => toast({ title: "Copy Failed", description: "Could not copy link.", variant: "destructive" })); };
  
  const calculateGridStyle = (participantCount: number): React.CSSProperties => {
    if (participantCount <= 0) participantCount = 1;
    let cols = 1;
    if (participantCount === 2) cols = 2;
    else if (participantCount <= 4) cols = 2;
    else if (participantCount <= 6) cols = 3;
    else if (participantCount <= 9) cols = 3;
    else cols = 4; // For 10 or more
  
    return {
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    };
  };

  const VideoFeed = ({ stream, user, isLocal, isVideoActuallyOn }: { stream: MediaStream; user?: OnlineUser | null; isLocal?: boolean; isVideoActuallyOn: boolean }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    useEffect(() => { if (videoRef.current && stream) { videoRef.current.srcObject = stream; } }, [stream]);
    const FallbackAvatar = () => (<Avatar className="w-12 h-12 sm:w-16 sm:h-16 border-2 border-gray-700"><AvatarImage src={user?.photoUrl} alt={user?.name || 'User'} data-ai-hint={user?.dataAiHint || "avatar abstract"} /><AvatarFallback className="bg-gray-600 text-white">{user?.name ? user.name.charAt(0).toUpperCase() : <UsersIcon />}</AvatarFallback></Avatar>);
    return (
      <div className="relative w-full aspect-video bg-gray-800 rounded-lg overflow-hidden shadow-md flex items-center justify-center">
        <video ref={videoRef} autoPlay playsInline muted={isLocal} className="w-full h-full object-cover" style={{ display: isVideoActuallyOn ? 'block' : 'none' }} />
        {!isVideoActuallyOn && (<div className="absolute inset-0 flex flex-col items-center justify-center text-white p-2 space-y-1 sm:space-y-2"><FallbackAvatar /><p className="text-xs sm:text-sm font-medium truncate max-w-[90%]">{user?.name || user?.id?.substring(0,8) || 'User'}</p><p className="text-xs text-gray-400">{isLocal ? "Your video is off" : "Video off"}</p></div>)}
        <div className="absolute bottom-0 left-0 p-1.5 sm:p-2 bg-gradient-to-t from-black/60 to-transparent w-full"><p className="text-white text-xs sm:text-sm truncate">{isLocal ? `${sessionUser?.name || 'You'} (You)` : user?.name || user?.id?.substring(0,8) || 'Remote User'}</p></div>
      </div>
    );
  };

  if (isLoading || !roomId) {
    return ( <MainLayout fullscreen><div className="flex flex-col h-screen bg-black text-white items-center justify-center"><Skeleton className="h-12 w-12 rounded-full bg-gray-700 mb-4" /><Skeleton className="h-4 w-1/2 bg-gray-700 mb-2" /><Skeleton className="h-4 w-1/3 bg-gray-700" /><p className="mt-4 text-gray-400">Loading room session...</p></div></MainLayout> );
  }
  if (!sessionUser) {
    return ( <MainLayout fullscreen><div className="flex flex-col h-screen bg-black text-white items-center justify-center p-4"><AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" /><h1 className="text-xl mb-2">Session Error</h1><p className="text-gray-400 text-center">Could not establish a user session for the room. Please try refreshing or return to the home page.</p><Button onClick={() => router.push('/')} className="mt-6 bg-primary hover:bg-primary/80 text-primary-foreground">Go to Home</Button></div></MainLayout> );
  }

  const totalStreamsToDisplay = (localStream && isInRoom ? 1 : 0) + remoteStreams.size;

  return (
    <MainLayout fullscreen>
      <div className="flex flex-col h-screen bg-black text-white relative">
        {isInRoom && (
          <div 
            className="flex-grow p-1 sm:p-2 md:p-4 grid gap-1 sm:gap-2 md:gap-4 items-start justify-center overflow-auto" // items-start might be better
            style={calculateGridStyle(totalStreamsToDisplay > 0 ? totalStreamsToDisplay : 1)}
          >
            {localStream && sessionUser && (
              <VideoFeed key="local" stream={localStream} user={sessionUser} isLocal isVideoActuallyOn={isVideoOn} />
            )}
            {Array.from(remoteStreams.entries()).map(([peerId, { stream, userInfo }]) => {
                const remoteVideoTracks = stream.getVideoTracks();
                const isRemoteVideoActuallyOn = remoteVideoTracks.length > 0 && remoteVideoTracks.some(track => track.enabled && !track.muted);
                return <VideoFeed key={peerId} stream={stream} user={userInfo} isLocal={false} isVideoActuallyOn={isRemoteVideoActuallyOn} />;
            })}
             {totalStreamsToDisplay === 0 && isInRoom && (
              <div className="col-span-full h-full flex flex-col items-center justify-center text-gray-400">
                <UsersIcon className="w-16 h-16 mb-4"/>
                <p>Waiting for others to join or for your video to start...</p>
              </div>
            )}
          </div>
        )}

        {isInRoom && (
          <div className="fixed bottom-0 left-0 right-0 p-2 sm:p-3 bg-black/75 flex justify-between items-center z-50 shadow-lg">
            <div className="text-xs sm:text-sm text-gray-300 hidden md:block">
              Room: {roomId?.substring(0,6)}... ({participants.length})
            </div>
            <div className="flex-grow flex justify-center gap-2 sm:gap-3">
              <Button variant="ghost" size="icon" onClick={toggleMic} disabled={!localStream} className="text-white hover:bg-white/20 active:bg-white/30 rounded-full w-10 h-10 sm:w-12 sm:h-12">
                {isMicOn ? <Mic className="h-5 w-5 sm:h-6 sm:w-6" /> : <MicOff className="h-5 w-5 sm:h-6 sm:w-6 text-red-400" />}
              </Button>
              <Button variant="ghost" size="icon" onClick={toggleVideo} disabled={!localStream} className="text-white hover:bg-white/20 active:bg-white/30 rounded-full w-10 h-10 sm:w-12 sm:h-12">
                {isVideoOn ? <VideoIcon className="h-5 w-5 sm:h-6 sm:w-6" /> : <VideoOffIcon className="h-5 w-5 sm:h-6 sm:w-6 text-red-400" />}
              </Button>
              <Button variant="destructive" size="sm" onClick={handleLeaveRoom} className="rounded-full px-4 h-10 sm:h-12 text-xs sm:text-sm">
                <PhoneOff className="mr-1 sm:mr-2 h-4 w-4 sm:h-5 sm:w-5" /> Leave
              </Button>
            </div>
            <div className="hidden md:block">
              <Button onClick={copyRoomLinkToClipboard} variant="ghost" size="sm" className="text-gray-300 hover:text-white hover:bg-white/20 text-xs sm:text-sm">
                <Copy className="mr-1 sm:mr-2 h-3 w-3 sm:h-4 sm:w-4" /> Copy Link
              </Button>
            </div>
          </div>
        )}

        {!isInRoom && !isLoading && sessionUser && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 z-40 p-4 text-center">
            <UsersIcon className="w-12 h-12 sm:w-16 sm:h-16 text-primary mb-3 sm:mb-4" />
            <h2 className="text-lg sm:text-xl font-semibold mb-1 sm:mb-2">Room ID: {roomId?.substring(0,8)}...</h2>
            <p className="mb-4 sm:mb-6 text-gray-400 text-sm sm:text-base">Ready to join the conference?</p>
            <Button onClick={handleJoinRoom} size="lg" className="bg-primary hover:bg-primary/80 text-primary-foreground px-6 sm:px-8 py-3 text-base sm:text-lg">
              Join Conference
            </Button>
             <Button onClick={() => router.push('/')} variant="link" className="mt-4 text-sm text-gray-400 hover:text-primary">
                Or go back to Home
            </Button>
          </div>
        )}
      </div>
    </MainLayout>
  );
}
