
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { MainLayout } from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, serverTimestamp, type DatabaseReference, push, child, query, limitToLast, orderByKey, type Query as FirebaseQuery } from 'firebase/database';
import type { OnlineUser, UserProfile, RoomSignal, ChatMessage, RTCIceCandidateJSON } from '@/types';
import { Video as VideoIcon, Mic, MicOff, VideoOff as VideoOffIcon, PhoneOff, Users as UsersIcon, Copy, AlertTriangle, MessageSquare, Home } from 'lucide-react'; // Added Home
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { ChatPanel } from '@/components/features/chat/chat-panel';
import { cn } from '@/lib/utils';


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
  const earlyCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  
  const [_participants, _setParticipantsInternal] = useState<OnlineUser[]>([]);
  const participantsRef = useRef<OnlineUser[]>([]); 


  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isInRoom, setIsInRoom] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isChatPanelOpen, setIsChatPanelOpen] = useState(false);
  const [conferenceChatMessages, setConferenceChatMessages] = useState<ChatMessage[]>([]);

  const firebaseListeners = useRef<Map<string, { ref: DatabaseReference | FirebaseQuery, callback: (snapshot: any) => void, eventType: string }>>(new Map());
  const CHAT_PANEL_WIDTH_CLASS = "max-w-sm sm:max-w-md"; 
  
  const addDebugLog = useCallback((message: string) => {
     console.log(`[Room DEBUG] ${roomId?.substring(0,4) || 'N/A'} - ${sessionUser?.id?.substring(0,4) || 'N/A'} - ${message}`);
  }, [roomId, sessionUser]); 

  const setParticipants = useCallback((newParticipantsData: OnlineUser[] | ((prev: OnlineUser[]) => OnlineUser[])) => {
    _setParticipantsInternal(prevParticipantsList => {
        const updatedParticipantsList = typeof newParticipantsData === 'function' 
            ? newParticipantsData(prevParticipantsList) 
            : newParticipantsData;

        const currentSUserId = sessionUser?.id;
        if (participantsRef.current.length > 0 && currentSUserId) { 
            const previousUserIds = new Set(participantsRef.current.map(p => p.id));
            const currentUserIds = new Set(updatedParticipantsList.map(p => p.id));

            participantsRef.current.forEach(prevUser => {
                if (!currentUserIds.has(prevUser.id) && prevUser.id !== currentSUserId) {
                     setTimeout(() => {
                        toast({
                            title: "User Left",
                            description: `${prevUser.name || 'A user'} has left the room.`,
                            variant: "default",
                        });
                    }, 0);
                    addDebugLog(`User Left Toast: ${prevUser.name} (${prevUser.id})`);
                }
            });
        }
        participantsRef.current = [...updatedParticipantsList]; 
        return updatedParticipantsList;
    });
  }, [sessionUser?.id, toast, addDebugLog]);


  const addFirebaseDbListener = useCallback((
    dbQueryOrRef: DatabaseReference | FirebaseQuery | undefined,
    callback: (snapshot: any) => void,
    eventType: 'value' | 'child_added' | 'child_changed' | 'child_removed' = 'value'
  ) => {
    if (!dbQueryOrRef || typeof dbQueryOrRef.toString !== 'function' || (dbQueryOrRef.constructor.name !== 'QueryImpl' && typeof (dbQueryOrRef as DatabaseReference).root?.toString !== 'function') ) {
      addDebugLog(`WARN: addFirebaseDbListener called with invalid or incomplete dbQueryOrRef. PathKey cannot be reliably generated.`);
      console.warn("addFirebaseDbListener: Invalid/incomplete dbQueryOrRef passed", {dbQueryOrRef});
      return;
    }
  
    const pathKey = dbQueryOrRef.toString() + '::' + eventType;
  
    if (firebaseListeners.current.has(pathKey)) {
      addDebugLog(`Listener for pathKey ${pathKey} already exists. Removing old one first.`);
      const oldEntry = firebaseListeners.current.get(pathKey);
      if (oldEntry) {
        off(oldEntry.ref, oldEntry.eventType as any, oldEntry.callback);
      }
    }
    
    const errorHandler = (error: Error) => { 
        const refPathForError = dbQueryOrRef.toString();
        addDebugLog(`ERROR reading from ${refPathForError} (event: ${eventType}): ${error.message}`);
    };

    if (eventType === 'value') {
      onValue(dbQueryOrRef, callback, errorHandler);
    } else {
      addDebugLog(`ERROR: addFirebaseDbListener called with unsupported eventType: ${eventType} for pathKey: ${pathKey}`);
      console.error(`Unsupported eventType: ${eventType} in addFirebaseDbListener`);
      return;
    }
  
    firebaseListeners.current.set(pathKey, { ref: dbQueryOrRef, callback, eventType });
    addDebugLog(`Added Firebase listener for pathKey: ${pathKey}`);
  }, [addDebugLog]);
  
  const removeFirebaseDbListener = useCallback((
    dbQueryOrRef: DatabaseReference | FirebaseQuery | undefined,
    eventType: 'value' | 'child_added' | 'child_changed' | 'child_removed' = 'value'
  ) => {
    if (!dbQueryOrRef || typeof dbQueryOrRef.toString !== 'function' || (dbQueryOrRef.constructor.name !== 'QueryImpl' && typeof (dbQueryOrRef as DatabaseReference).root?.toString !== 'function') ) {
      addDebugLog(`WARN: removeFirebaseDbListener called with invalid or incomplete dbQueryOrRef. PathKey cannot be reliably generated.`);
      console.warn("removeFirebaseDbListener: Invalid/incomplete dbQueryOrRef passed", {dbQueryOrRef});
      return;
    }
  
    const pathKey = dbQueryOrRef.toString() + '::' + eventType;
    
    const listenerEntry = firebaseListeners.current.get(pathKey);
    if (listenerEntry) {
        off(listenerEntry.ref, listenerEntry.eventType as any, listenerEntry.callback);
        firebaseListeners.current.delete(pathKey);
        addDebugLog(`Removed Firebase listener for pathKey: ${pathKey}`);
    }
  }, [addDebugLog]);

  useEffect(() => {
    addDebugLog(`Auth state check: authLoading=${authLoading}, authCurrentUser=${!!authCurrentUser}, authUserProfile=${!!authUserProfile}, current sessionUser=${!!sessionUser}, generatedAnonId=${generatedAnonymousIdRef.current}`);
    if (authLoading) {
      addDebugLog("Auth still loading, RoomPage waiting...");
      if (!isLoading) setIsLoading(true);
      return;
    }

    if (sessionUser && !isLoading) { 
      return;
    }
    
    setIsLoading(true); 

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
    } else if (authCurrentUser && !authUserProfile) {
       addDebugLog("Auth user exists but profile is not yet loaded/available. RoomPage continues loading.");
    } else {
       addDebugLog("Unhandled case in sessionUser setup. Defaulting to loading.");
       setIsLoading(false); 
    }
  }, [authCurrentUser, authUserProfile, authLoading, addDebugLog, sessionUser, isLoading]);


  const cleanupPeerConnection = useCallback((peerId: string) => {
    addDebugLog(`Cleaning up peer connection for ${peerId}`);
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.ontrack = null; pc.onicecandidate = null; pc.oniceconnectionstatechange = null; pc.onsignalingstatechange = null;
      
      pc.getSenders().forEach(sender => {
        if (pc.signalingState !== 'closed') {
          try { 
            pc.removeTrack(sender);
            addDebugLog(`Removed track ${sender.track?.kind} from sender for peer ${peerId}`);
          } catch (e) { 
            addDebugLog(`Error removing track for ${peerId} from sender: ${e}`);
          }
        }
      });

      if (pc.signalingState !== 'closed') {
        pc.close();
        addDebugLog(`Closed peer connection for ${peerId}`);
      }
      peerConnectionsRef.current.delete(peerId);
    }
    setRemoteStreams(prev => { const newStreams = new Map(prev); newStreams.delete(peerId); return newStreams; });
    earlyCandidatesRef.current.delete(peerId);
    addDebugLog(`Peer connection for ${peerId} fully cleaned from refs and state.`);
  }, [addDebugLog]);

  const handleLeaveRoom = useCallback(async () => {
    addDebugLog(`Leaving room ${roomId}. Current user: ${sessionUser?.id}`);
    setIsInRoom(false);
    if (localStream) { 
      localStream.getTracks().forEach(track => {
        track.stop();
        addDebugLog(`Stopped local track: ${track.kind} (${track.id})`);
      }); 
      setLocalStream(null); 
      addDebugLog("Local stream stopped and nulled."); 
    }
    peerConnectionsRef.current.forEach((_, peerId) => { addDebugLog(`Cleaning up PC for ${peerId} during leave room.`); cleanupPeerConnection(peerId); });
    peerConnectionsRef.current.clear();
    earlyCandidatesRef.current.clear();
    setRemoteStreams(new Map());
    addDebugLog("All peer connections cleaned up.");
    
    firebaseListeners.current.forEach(({ ref: fRef, callback, eventType }) => { 
        try {
            off(fRef, eventType as any, callback); 
            addDebugLog(`Detached listener for ${fRef.toString()} type ${eventType}`);
        } catch(e: any) {
            addDebugLog(`Error detaching listener for ${fRef.toString()} type ${eventType}: ${e.message}`);
        }
    });
    firebaseListeners.current.clear();

    if (roomId && sessionUser?.id) {
      remove(ref(db, `conferenceRooms/${roomId}/participants/${sessionUser.id}`)).catch(e => addDebugLog(`Error removing self from participants: ${e.message}`));
      remove(ref(db, `conferenceRooms/${roomId}/signals/${sessionUser.id}`)).catch(e => addDebugLog(`Error removing my signals folder: ${e.message}`));
      addDebugLog(`Removed self from participants and signals for room ${roomId}.`);
    }
    
    setParticipants([]); 
    participantsRef.current = []; 
    setConferenceChatMessages([]);
    setIsChatPanelOpen(false);
    
    setTimeout(() => {
        toast({ title: "Left Room", description: "You have left the conference room." });
    }, 0);
    router.push('/');
  }, [roomId, sessionUser, localStream, cleanupPeerConnection, addDebugLog, toast, router, setParticipants]);

  const initializeAndSendOffer = useCallback(async (peerId: string, peerName?: string) => {
    if (!localStream || !roomId || !sessionUser?.id || peerConnectionsRef.current.has(peerId)) {
      addDebugLog(`Cannot send offer to ${peerId}. Conditions not met. LocalStream: ${!!localStream}, RoomId: ${!!roomId}, SessionUser: ${!!sessionUser?.id}, PC Exists: ${peerConnectionsRef.current.has(peerId)}`);
      return;
    }
    addDebugLog(`Initializing PC and sending offer to ${peerId} (${peerName || 'Unknown'})`);
    const pc = new RTCPeerConnection(servers);
    peerConnectionsRef.current.set(peerId, pc);
    earlyCandidatesRef.current.set(peerId, []); 
    localStream.getTracks().forEach(track => { try { pc.addTrack(track, localStream); addDebugLog(`Added local track ${track.kind} for peer ${peerId}`); } catch (e: any) { addDebugLog(`Error adding local track for ${peerId}: ${e.message}`); }});
    
    pc.onicecandidate = event => {
      if (event.candidate && roomId && sessionUser?.id) {
        addDebugLog(`Generated ICE candidate for ${peerId}: ${event.candidate.candidate.substring(0,30)}...`);
        const signalPayload: RoomSignal = { type: 'candidate', senderId: sessionUser.id, senderName: sessionUser.name, data: event.candidate.toJSON() };
        set(push(ref(db, `conferenceRooms/${roomId}/signals/${peerId}`)), signalPayload).catch(e => addDebugLog(`Error sending ICE candidate to ${peerId}: ${e.message}`));
      }
    };

    pc.ontrack = event => {
      const currentPeerId = peerId; 
      addDebugLog(`Caller: Ontrack from ${currentPeerId}. Track kind: ${event.track.kind}, ID: ${event.track.id}, readyState: ${event.track.readyState}, muted: ${event.track.muted}. Streams: ${event.streams.length}`);
      setRemoteStreams(prevMap => {
        const newMap = new Map(prevMap);
        let entry = newMap.get(currentPeerId);
        let streamToUpdate: MediaStream;
        
        if (entry && entry.stream) {
          streamToUpdate = entry.stream;
          if (!streamToUpdate.getTrackById(event.track.id)) {
            streamToUpdate.addTrack(event.track);
            addDebugLog(`Caller: Added track ${event.track.kind} (${event.track.id}) to existing stream for ${currentPeerId}. Stream now has ${streamToUpdate.getTracks().length} tracks.`);
          } else {
            addDebugLog(`Caller: Track ${event.track.kind} (${event.track.id}) already in stream for ${currentPeerId}.`);
          }
        } else {
          streamToUpdate = new MediaStream();
          streamToUpdate.addTrack(event.track);
          addDebugLog(`Caller: Created new stream and added track ${event.track.kind} (${event.track.id}) for ${currentPeerId}. Stream now has ${streamToUpdate.getTracks().length} tracks.`);
        }
        const participantInfo = participantsRef.current.find(p => p.id === currentPeerId);
        newMap.set(currentPeerId, { stream: streamToUpdate, userInfo: participantInfo ? {...participantInfo} : undefined });
        return newMap;
      });
    };
    
    pc.oniceconnectionstatechange = () => { 
      const iceState = pc.iceConnectionState;
      addDebugLog(`ICE state for ${peerId}: ${iceState}`); 
      if (iceState === 'failed' || iceState === 'closed' || iceState === 'disconnected') { 
        addDebugLog(`ICE connection to ${peerId} ${iceState}. Cleaning up.`); 
        cleanupPeerConnection(peerId); 
      }
    };
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
          pc = new RTCPeerConnection(servers); peerConnectionsRef.current.set(senderId, pc); earlyCandidatesRef.current.set(senderId, []); addDebugLog(`Created new PC for offer from ${senderId}`);
          localStream.getTracks().forEach(track => { try { pc!.addTrack(track, localStream); addDebugLog(`Added local track ${track.kind} to PC for ${senderId} (on offer)`);} catch (e:any) { addDebugLog(`Error adding local track on offer from ${senderId}: ${e.message}`); }});
          
          pc.onicecandidate = event => { 
            if (event.candidate && roomId && sessionUser?.id) { 
              addDebugLog(`Generated ICE candidate for ${senderId} (replying to offer): ${event.candidate.candidate.substring(0,30)}...`); 
              const candidatePayload: RoomSignal = { type: 'candidate', senderId: sessionUser.id!, senderName: sessionUser.name, data: event.candidate.toJSON() }; 
              set(push(ref(db, `conferenceRooms/${roomId}/signals/${senderId}`)), candidatePayload).catch(e => addDebugLog(`Error sending ICE to ${senderId} (on offer): ${e.message}`)); 
            }
          };
          
          pc.ontrack = event => {
            const currentPeerId = senderId; 
            addDebugLog(`Callee: Ontrack from ${currentPeerId}. Track kind: ${event.track.kind}, ID: ${event.track.id}, readyState: ${event.track.readyState}, muted: ${event.track.muted}. Streams: ${event.streams.length}`);
            setRemoteStreams(prevMap => {
                const newMap = new Map(prevMap);
                let entry = newMap.get(currentPeerId);
                let streamToUpdate: MediaStream;

                if (entry && entry.stream) {
                    streamToUpdate = entry.stream;
                    if (!streamToUpdate.getTrackById(event.track.id)) {
                        streamToUpdate.addTrack(event.track);
                        addDebugLog(`Callee: Added track ${event.track.kind} (${event.track.id}) to existing stream for ${currentPeerId}. Stream now has ${streamToUpdate.getTracks().length} tracks.`);
                    } else {
                         addDebugLog(`Callee: Track ${event.track.kind} (${event.track.id}) already in stream for ${currentPeerId}.`);
                    }
                } else {
                    streamToUpdate = new MediaStream();
                    streamToUpdate.addTrack(event.track);
                    addDebugLog(`Callee: Created new stream and added track ${event.track.kind} (${event.track.id}) for ${currentPeerId}. Stream now has ${streamToUpdate.getTracks().length} tracks.`);
                }
                const participantInfo = participantsRef.current.find(p => p.id === currentPeerId);
                newMap.set(currentPeerId, { stream: streamToUpdate, userInfo: participantInfo ? {...participantInfo} : undefined });
                return newMap;
            });
          };

          pc.oniceconnectionstatechange = () => { 
            const iceState = pc!.iceConnectionState;
            addDebugLog(`ICE state for ${senderId} (on offer path): ${iceState}`); 
            if (iceState === 'failed' || iceState === 'closed' || iceState === 'disconnected') { 
              addDebugLog(`ICE connection to ${senderId} ${iceState} (on offer path). Cleaning up.`); cleanupPeerConnection(senderId); 
            }
          };
          pc.onsignalingstatechange = () => addDebugLog(`Signaling state for ${senderId} (on offer path): ${pc!.signalingState}`);
          
          pc!.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit))
            .then(() => { 
              addDebugLog(`Remote desc (offer) from ${senderId} set.`);
              const queuedCandidates = earlyCandidatesRef.current.get(senderId) || [];
              addDebugLog(`Processing ${queuedCandidates.length} early ICE candidates for ${senderId} after setting offer.`);
              queuedCandidates.forEach(candidate => {
                pc!.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => addDebugLog(`Error adding early ICE for ${senderId}: ${e.message || e}`));
              });
              earlyCandidatesRef.current.delete(senderId);
              return pc!.createAnswer(); 
            })
            .then(answer => { addDebugLog(`Answer created for ${senderId}.`); return pc!.setLocalDescription(answer); })
            .then(() => { addDebugLog(`Local desc (answer) for ${senderId} set.`); const answerPayload: RoomSignal = { type: 'answer', senderId: sessionUser.id!, senderName: sessionUser.name, data: pc!.localDescription!.toJSON() }; return set(push(ref(db, `conferenceRooms/${roomId}/signals/${senderId}`)), answerPayload); })
            .then(() => addDebugLog(`Answer sent to ${senderId}`))
            .catch(e => { addDebugLog(`Error processing offer / sending answer to ${senderId}: ${e.message || e}`); cleanupPeerConnection(senderId); });

        } else if (type === 'answer' && pc && pc.signalingState !== 'closed') {
          pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit))
            .then(() => {
              addDebugLog(`Remote description (answer) set from ${senderId}`);
              const queuedCandidates = earlyCandidatesRef.current.get(senderId) || [];
              addDebugLog(`Processing ${queuedCandidates.length} early ICE candidates for ${senderId} after setting answer.`);
              queuedCandidates.forEach(candidate => {
                pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => addDebugLog(`Error adding early ICE for ${senderId}: ${e.message || e}`));
              });
              earlyCandidatesRef.current.delete(senderId);
            })
            .catch(e => addDebugLog(`Error setting remote desc (answer) from ${senderId}: ${e.message || e}. PC state: ${pc.signalingState}`));

        } else if (type === 'candidate' && pc && pc.signalingState !== 'closed') {
           const candidateInit = data as RTCIceCandidateInit;
           if (pc.remoteDescription) { 
             pc.addIceCandidate(new RTCIceCandidate(candidateInit)).then(() => addDebugLog(`Added ICE candidate from ${senderId}`)).catch(e => addDebugLog(`Error adding ICE candidate from ${senderId}: ${e.message || e}. PC state: ${pc.signalingState}`)); 
           } else { 
             addDebugLog(`WARN: Received ICE candidate from ${senderId} but remote description not yet set. Queuing candidate.`);
             const queue = earlyCandidatesRef.current.get(senderId) || [];
             queue.push(candidateInit);
             earlyCandidatesRef.current.set(senderId, queue);
           }
        } else if (pc && pc.signalingState === 'closed' && (type === 'answer' || type === 'candidate')){ addDebugLog(`Received ${type} from ${senderId} but PC is already closed. Ignoring.`); }
        remove(child(mySignalsDbRef, signalKey)).catch(e => addDebugLog(`Failed to remove processed signal ${signalKey}: ${e.message}`));
      });
    };
    addFirebaseDbListener(mySignalsDbRef, signalsCallback, 'value');
    
    const participantsDbRef = ref(db, `conferenceRooms/${roomId}/participants`);
    const participantsCb = (snapshot: any) => {
      const newParticipantsListFromDb: OnlineUser[] = []; 
      snapshot.forEach((childSnapshot: any) => { 
        newParticipantsListFromDb.push({ id: childSnapshot.key!, ...childSnapshot.val() } as OnlineUser); 
      });
      
      setParticipants(newParticipantsListFromDb); 

      addDebugLog(`Participants updated (from DB): ${newParticipantsListFromDb.map(p => `${p.name}(${p.id.substring(0,4)})`).join(', ')} (${newParticipantsListFromDb.length} total)`);
      
      const currentSUserId = sessionUser?.id; 
      if (currentSUserId && localStream) {
        newParticipantsListFromDb.forEach(p => { 
          if (p.id !== currentSUserId && !peerConnectionsRef.current.has(p.id)) { 
            addDebugLog(`New participant ${p.name} (${p.id}) detected via DB. Initializing connection.`); 
            initializeAndSendOffer(p.id, p.name); 
          }
        });
      }

      peerConnectionsRef.current.forEach((_, pcPeerId) => { 
        if (!newParticipantsListFromDb.find(p => p.id === pcPeerId) && pcPeerId !== currentSUserId ) { 
          addDebugLog(`Participant ${pcPeerId} no longer in DB list and is not self. Cleaning up their connection.`); 
          cleanupPeerConnection(pcPeerId); 
        }
      });
    };
    addFirebaseDbListener(participantsDbRef, participantsCb, 'value');

    const chatMessagesQuery = query(ref(db, `conferenceRooms/${roomId}/chatMessages`), orderByKey(), limitToLast(50));
    const chatMessagesCallback = (snapshot: any) => {
        const messages: ChatMessage[] = [];
        snapshot.forEach((childSnapshot: any) => {
            messages.push({ id: childSnapshot.key!, ...childSnapshot.val() } as ChatMessage);
        });
        setConferenceChatMessages(messages);
    };
    addFirebaseDbListener(chatMessagesQuery, chatMessagesCallback, 'value');


    return () => { 
      addDebugLog(`Cleaning up Firebase listeners for room ${roomId}, user ${sessionUser?.id || 'N/A'} (main useEffect)`); 
      removeFirebaseDbListener(mySignalsDbRef, 'value'); 
      removeFirebaseDbListener(participantsDbRef, 'value');
      removeFirebaseDbListener(chatMessagesQuery, 'value');
    };
  }, [isInRoom, roomId, sessionUser, localStream, initializeAndSendOffer, cleanupPeerConnection, addDebugLog, addFirebaseDbListener, removeFirebaseDbListener, setParticipants]);

  const handleJoinRoom = async () => {
    if (!sessionUser || !sessionUser.id || !roomId) { 
        toast({ title: "Error", description: "Session, User ID, or Room ID missing.", variant: "destructive" }); 
        addDebugLog("JoinRoom: sessionUser, sessionUser.id, or roomId missing."); return; 
    }
    addDebugLog(`Attempting to join room ${roomId} as ${sessionUser.name} (${sessionUser.id})`);
    
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream); 
      setIsMicOn(true); 
      setIsVideoOn(true); 
      addDebugLog("Local media stream acquired.");
    } catch (err: any) {
      addDebugLog(`Error getting media: ${err.message}`);
      toast({ title: "Media Access Error", description: `Could not access camera/microphone: ${err.message}. Please check permissions.`, variant: "destructive" });
      setLocalStream(null); 
      return; 
    }

    if (stream) { 
        try {
            const participantRefPath = `conferenceRooms/${roomId}/participants/${sessionUser.id}`;
            const participantDbRef = ref(db, participantRefPath);
            const participantData: OnlineUser = { 
                id: sessionUser.id, 
                name: sessionUser.name, 
                photoUrl: sessionUser.photoUrl, 
                dataAiHint: sessionUser.dataAiHint, 
                isGoogleUser: sessionUser.isGoogleUser, 
                countryCode: sessionUser.countryCode, 
                timestamp: serverTimestamp() 
            };
            await set(participantDbRef, participantData);
            
            if (participantDbRef && typeof participantDbRef.onDisconnect === 'function') {
                participantDbRef.onDisconnect().remove()
                    .then(() => addDebugLog(`onDisconnect set for participant ${sessionUser.id}`))
                    .catch(e => addDebugLog(`Error setting onDisconnect for participant ${sessionUser.id}: ${e.message}`));
            } else { 
                addDebugLog(`ERROR: participantDbRef or onDisconnect not valid for participant ${sessionUser.id} in handleJoinRoom.`); 
            }
            
            setIsInRoom(true); 
            toast({ title: "Joined Room!", description: `You are now in room ${roomId}.` }); 
            addDebugLog("Successfully joined room and set presence.");

        } catch (dbError: any) {
            addDebugLog(`Error setting Firebase participant data: ${dbError.message}`);
            toast({ title: "Room Join Error", description: `Could not update room participation: ${dbError.message}`, variant: "destructive" });
            stream.getTracks().forEach(track => track.stop());
            setLocalStream(null);
            setIsInRoom(false); 
        }
    } else {
        addDebugLog("handleJoinRoom: Media stream was not acquired, join process aborted before Firebase operations.");
    }
  };

  const handleSendConferenceMessage = useCallback(async (text: string, attachments?: File[]) => {
    if (!roomId || !sessionUser || text.trim() === '') return;
    if (attachments && attachments.length > 0) {
        toast({title: "Note", description: "File attachments not yet implemented.", variant: "default"});
    }

    const messageData: Omit<ChatMessage, 'id' | 'timestamp'> & { timestamp: object } = {
      chatRoomId: roomId,
      senderId: sessionUser.id,
      senderName: sessionUser.name,
      senderPhotoUrl: sessionUser.photoUrl,
      text: text.trim(),
      timestamp: serverTimestamp(),
    };
    try {
      await push(ref(db, `conferenceRooms/${roomId}/chatMessages`), messageData);
      addDebugLog(`Sent conference message: "${text}"`);
    } catch (error: any) {
      addDebugLog(`Error sending conference message: ${error.message}`);
      toast({title: "Chat Error", description: "Could not send message.", variant: "destructive"});
    }
  }, [roomId, sessionUser, toast, addDebugLog]);


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
    else cols = 4; 
  
    return {
      gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    };
  };

  const VideoFeed = ({ stream, user, isLocal, isVideoActuallyOn, addDebugLogProp }: { stream: MediaStream | null; user?: OnlineUser | null; isLocal?: boolean; isVideoActuallyOn: boolean; addDebugLogProp: (log: string) => void; }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const [internalStreamKey, setInternalStreamKey] = useState(0); 
    
    useEffect(() => { 
      let videoElement = videoRef.current;
      if (videoElement && stream) { 
        videoElement.srcObject = stream; 
        addDebugLogProp(`VideoFeed for ${user?.name || (isLocal ? 'local' : 'remote')}(${user?.id?.substring(0,4)}): srcObject set. Stream ID: ${stream.id}, Tracks: ${stream.getTracks().length} (v: ${stream.getVideoTracks().length}, a: ${stream.getAudioTracks().length}). Video on: ${isVideoActuallyOn}`);
      } else {
        addDebugLogProp(`VideoFeed for ${user?.name || (isLocal ? 'local' : 'remote')}(${user?.id?.substring(0,4)}): stream is ${stream === null ? 'null' : 'defined but falsy'}. Video on: ${isVideoActuallyOn}`);
        if (videoElement) {
            videoElement.srcObject = null; 
        }
      }
      return () => {
        if (videoElement) {
            videoElement.srcObject = null;
            addDebugLogProp(`VideoFeed for ${user?.name || (isLocal ? 'local' : 'remote')}(${user?.id?.substring(0,4)}): srcObject nulled on cleanup.`);
        }
      };
    }, [stream, user, isLocal, isVideoActuallyOn, addDebugLogProp, internalStreamKey]); 

    useEffect(() => {
        const currentStream = stream;
        if (!currentStream || !videoRef.current) return;

        const videoEl = videoRef.current;

        const handleTrackEvent = (event: MediaStreamTrackEvent) => {
            addDebugLogProp(`VideoFeed for ${user?.name || (isLocal ? 'local' : 'remote')}: Received '${event.type}' event for track ${event.track.kind} (${event.track.id}). Stream ID: ${currentStream.id}`);
            if (videoEl.srcObject !== currentStream) {
                 addDebugLogProp(`VideoFeed for ${user?.name || (isLocal ? 'local' : 'remote')}: srcObject mismatch on track event. Re-assigning.`);
                 videoEl.srcObject = currentStream;
            }
            setInternalStreamKey(prev => prev + 1); 
        };
        
        currentStream.addEventListener('addtrack', handleTrackEvent);
        currentStream.addEventListener('removetrack', handleTrackEvent);

        return () => {
            currentStream.removeEventListener('addtrack', handleTrackEvent);
            currentStream.removeEventListener('removetrack', handleTrackEvent);
            addDebugLogProp(`VideoFeed for ${user?.name || (isLocal ? 'local' : 'remote')}: Cleaned up stream track event listeners. Stream ID: ${currentStream.id}`);
        };
    }, [stream, user, isLocal, addDebugLogProp]);


    const FallbackAvatar = () => (<Avatar className="w-12 h-12 sm:w-16 sm:h-16 border-2 border-gray-700"><AvatarImage src={user?.photoUrl} alt={user?.name || 'User'} data-ai-hint={user?.dataAiHint || "avatar abstract"} /><AvatarFallback className="bg-gray-600 text-white">{user?.name ? user.name.charAt(0).toUpperCase() : <UsersIcon />}</AvatarFallback></Avatar>);
    
    const videoElementKey = stream ? `${stream.id}-${stream.getTracks().map(t => t.id).join('-')}` : (user?.id || 'no-stream-user');

    return (
      <div className="relative w-full aspect-video bg-gray-800 rounded-lg overflow-hidden shadow-md flex items-center justify-center">
        <video 
            key={videoElementKey}
            ref={videoRef} 
            autoPlay 
            playsInline 
            muted={isLocal} 
            className="w-full h-full object-cover" 
            style={{ display: stream && isVideoActuallyOn ? 'block' : 'none' }} 
        />
        {(!stream || !isVideoActuallyOn) && (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-white p-2 space-y-1 sm:space-y-2">
                <FallbackAvatar />
                <p className="text-xs sm:text-sm font-medium truncate max-w-[90%]">{user?.name || user?.id?.substring(0,8) || 'User'}</p>
                <p className="text-xs text-gray-400">
                    {isLocal && !stream ? "Camera not available" : 
                     (isLocal && !isVideoActuallyOn ? "Your video is off" : 
                      (!isLocal && stream && !isVideoActuallyOn ? "Video off" : 
                       (!isLocal && !stream ? "No stream from user" : "Waiting for video...") ))}
                </p>
            </div>
        )}
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
      <div className="flex h-screen bg-black text-white">
        <div className="relative flex-grow flex flex-col overflow-hidden"> 
            <div 
              className="flex-grow p-1 sm:p-2 md:p-4 grid gap-1 sm:gap-2 md:gap-4 items-start justify-center overflow-auto"
              style={calculateGridStyle(totalStreamsToDisplay > 0 ? totalStreamsToDisplay : 1)}
            >
              {isInRoom && localStream && sessionUser && (
                <VideoFeed key="local" stream={localStream} user={sessionUser} isLocal isVideoActuallyOn={isVideoOn} addDebugLogProp={addDebugLog} />
              )}
              {isInRoom && Array.from(remoteStreams.entries()).map(([peerId, { stream, userInfo }]) => {
                  const remoteVideoTracks = stream.getVideoTracks();
                  const isRemoteVideoActuallyOn = remoteVideoTracks.length > 0 && remoteVideoTracks.every(track => track.enabled && !track.muted && track.readyState === 'live'); 
                  return <VideoFeed key={peerId} stream={stream} user={userInfo} isLocal={false} isVideoActuallyOn={isRemoteVideoActuallyOn} addDebugLogProp={addDebugLog} />;
              })}
               {totalStreamsToDisplay === 0 && isInRoom && (
                <div className="col-span-full h-full flex flex-col items-center justify-center text-gray-400">
                  <UsersIcon className="w-16 h-16 mb-4"/>
                  <p>Waiting for others to join or for your video to start...</p>
                  {!localStream && <p className="text-sm mt-2">Your camera might not be active.</p>}
                </div>
              )}
            </div>
            {isInRoom && (
              <div className="absolute bottom-0 left-0 right-0 p-2 sm:p-3 bg-black/70 flex justify-between items-center z-20 shadow-lg"> 
                 <Button onClick={handleLeaveRoom} variant="ghost" size="icon" className="text-white hover:bg-white/20 active:bg-white/30 rounded-full w-10 h-10 sm:w-12 sm:h-12 md:hidden">
                    <Home className="h-5 w-5 sm:h-6 sm:w-6" />
                 </Button>
                 <Button onClick={handleLeaveRoom} variant="outline" className="text-white border-white/50 hover:bg-white/20 hidden md:flex items-center gap-2">
                    <Home className="h-4 w-4"/> Go Home
                 </Button>
                <div className="flex-grow flex justify-center gap-2 sm:gap-3">
                  <Button variant="ghost" size="icon" onClick={toggleMic} disabled={!localStream} className="text-white hover:bg-white/20 active:bg-white/30 rounded-full w-10 h-10 sm:w-12 sm:h-12">
                    {isMicOn ? <Mic className="h-5 w-5 sm:h-6 sm:w-6" /> : <MicOff className="h-5 w-5 sm:h-6 sm:w-6 text-red-400" />}
                  </Button>
                  <Button variant="ghost" size="icon" onClick={toggleVideo} disabled={!localStream} className="text-white hover:bg-white/20 active:bg-white/30 rounded-full w-10 h-10 sm:w-12 sm:h-12">
                    {isVideoOn ? <VideoIcon className="h-5 w-5 sm:h-6 sm:w-6" /> : <VideoOffIcon className="h-5 w-5 sm:h-6 sm:w-6 text-red-400" />}
                  </Button>
                  <Button 
                      variant="ghost" 
                      size="icon" 
                      onClick={() => setIsChatPanelOpen(prev => !prev)} 
                      className="text-white hover:bg-white/20 active:bg-white/30 rounded-full w-10 h-10 sm:w-12 sm:h-12"
                      aria-label="Toggle chat panel"
                    >
                    <MessageSquare className="h-5 w-5 sm:h-6 sm:w-6" />
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
                 <div className="w-10 h-10 sm:w-12 sm:h-12 md:hidden" /> {/* Spacer for mobile right side */}
              </div>
            )}
        </div>

        {isInRoom && (
          <div className={cn(
            "h-full bg-gray-900/90 backdrop-blur-sm shadow-2xl transition-all duration-300 ease-in-out z-30 flex-shrink-0", 
            isChatPanelOpen ? `w-full ${CHAT_PANEL_WIDTH_CLASS}` : "w-0 overflow-hidden" 
          )}>
            {isChatPanelOpen && roomId && sessionUser && ( 
                 <ChatPanel
                    messages={conferenceChatMessages}
                    onSendMessage={handleSendConferenceMessage}
                    currentUserId={sessionUser.id}
                    chatRoomId={roomId}
                    isLoading={false} 
                    chatTitle={`Room: ${roomId.substring(0,6)}...`}
                />
            )}
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
    
