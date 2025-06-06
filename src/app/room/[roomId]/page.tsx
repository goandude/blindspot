
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { MainLayout } from '@/components/layout/main-layout';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardContent, CardTitle, CardDescription, CardFooter } from '@/components/ui/card';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { useAuth } from '@/hooks/use-auth';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, serverTimestamp, type DatabaseReference, push, child } from 'firebase/database';
import type { OnlineUser, UserProfile, RoomSignal } from '@/types';
import { Video, Mic, MicOff, VideoOff, PhoneOff, Users, LogOut, Copy, AlertTriangle } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';

const servers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// Interface for the new remoteStreams state structure
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

  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, RemoteStreamEntry>>(new Map());
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [participants, setParticipants] = useState<OnlineUser[]>([]);
  const participantsRef = useRef(participants); 

  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isInRoom, setIsInRoom] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);

  const firebaseListeners = useRef<Map<string, { ref: DatabaseReference, callback: (snapshot: any) => void, eventType: string }>>(new Map());

  useEffect(() => {
    participantsRef.current = participants;
  }, [participants]);

  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
    const currentSId = sessionUser?.id || 'N/A';
    const prefix = `[${currentSId.substring(0, 4)}] [Room ${roomId?.substring(0,4) || 'N/A'}] `;
    const logEntry = `[${timestamp}] ${prefix}${message}`;
    setDebugLogs(prevLogs => [logEntry, ...prevLogs].slice(0, 100));
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
    if (authLoading) {
      addDebugLog("Auth still loading, waiting...");
      return;
    }

    if (authCurrentUser && authUserProfile) {
      addDebugLog(`Authenticated user: ${authUserProfile.name} (${authCurrentUser.uid})`);
      const googleSessionUser: OnlineUser = {
        id: authCurrentUser.uid, name: authUserProfile.name, photoUrl: authUserProfile.photoUrl,
        dataAiHint: authUserProfile.dataAiHint, countryCode: authUserProfile.countryCode, isGoogleUser: true,
      };
      setSessionUser(googleSessionUser);
      setIsLoading(false);
    } else if (!authCurrentUser) {
      addDebugLog("No authenticated user, creating anonymous session for room.");
      const anonymousRoomId = `anon-${Math.random().toString(36).substring(2, 10)}`;
       const fetchCountryAndSetAnonymousUser = async () => {
        let countryCode = 'XX';
        try {
          const response = await fetch('https://ipapi.co/country_code/');
          if (response.ok) countryCode = (await response.text()).trim();
        } catch (e) { /* ignore */ }
        const anonUser: OnlineUser = {
          id: anonymousRoomId, name: `User-${anonymousRoomId.substring(5, 9)}`,
          photoUrl: `https://placehold.co/96x96.png?text=${anonymousRoomId.charAt(5).toUpperCase()}`,
          dataAiHint: 'abstract character', countryCode, isGoogleUser: false,
        };
        setSessionUser(anonUser);
        setIsLoading(false);
        addDebugLog(`Anonymous session for room: ${anonUser.name} (${anonUser.id})`);
      };
      fetchCountryAndSetAnonymousUser();
    }
  }, [authCurrentUser, authUserProfile, authLoading, addDebugLog]);


  const cleanupPeerConnection = useCallback((peerId: string) => {
    addDebugLog(`Cleaning up peer connection for ${peerId}`);
    const pc = peerConnectionsRef.current.get(peerId);
    if (pc) {
      pc.ontrack = null;
      pc.onicecandidate = null;
      pc.oniceconnectionstatechange = null;
      pc.onsignalingstatechange = null;
      pc.getSenders().forEach(sender => {
        if (sender.track) sender.track.stop();
        try { if(pc.signalingState !== 'closed') pc.removeTrack(sender); } catch (e) { addDebugLog(`Error removing track for ${peerId}: ${e}`);}
      });
      if (pc.signalingState !== 'closed') pc.close();
      peerConnectionsRef.current.delete(peerId);
    }
    setRemoteStreams(prev => {
      const newStreams = new Map(prev);
      newStreams.delete(peerId);
      return newStreams;
    });
  }, [addDebugLog]);

  const handleLeaveRoom = useCallback(async () => {
    addDebugLog(`Leaving room ${roomId}. Current user: ${sessionUser?.id}`);
    setIsInRoom(false);

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
      addDebugLog("Local stream stopped.");
    }

    peerConnectionsRef.current.forEach((_, peerId) => { // Changed pc to _
      addDebugLog(`Cleaning up PC for ${peerId} during leave room.`);
      cleanupPeerConnection(peerId);
    });
    peerConnectionsRef.current.clear();
    setRemoteStreams(new Map());
    addDebugLog("All peer connections cleaned up.");

    if (roomId && sessionUser?.id) {
      const participantRef = ref(db, `conferenceRooms/${roomId}/participants/${sessionUser.id}`);
      remove(participantRef).catch(e => addDebugLog(`Error removing self from participants: ${e.message}`));
      
      const mySignalsRef = ref(db, `conferenceRooms/${roomId}/signals/${sessionUser.id}`);
      remove(mySignalsRef).catch(e => addDebugLog(`Error removing my signals folder: ${e.message}`));
      addDebugLog(`Removed self from participants and signals for room ${roomId}.`);
    }
    
    firebaseListeners.current.forEach(({ ref: fRef, callback, eventType }) => {
        off(fRef, eventType as any, callback);
        addDebugLog(`Detached listener for ${fRef.toString()} type ${eventType}`);
    });
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

    localStream.getTracks().forEach(track => {
      try { pc.addTrack(track, localStream); addDebugLog(`Added local track ${track.kind} for peer ${peerId}`); } 
      catch (e: any) { addDebugLog(`Error adding local track for ${peerId}: ${e.message}`); }
    });

    pc.onicecandidate = event => {
      if (event.candidate && roomId && sessionUser?.id) {
        addDebugLog(`Generated ICE candidate for ${peerId}: ${event.candidate.candidate.substring(0,30)}...`);
        const signalPayload: RoomSignal = {
          type: 'candidate',
          senderId: sessionUser.id,
          senderName: sessionUser.name,
          data: event.candidate.toJSON(),
        };
        const candidateRef = push(ref(db, `conferenceRooms/${roomId}/signals/${peerId}`));
        set(candidateRef, signalPayload)
          .catch(e => addDebugLog(`Error sending ICE candidate to ${peerId}: ${e.message}`));
      }
    };

    pc.ontrack = event => {
      addDebugLog(`Remote track received from ${peerId}: Kind: ${event.track.kind}. Stream(s): ${event.streams.length}`);
      setRemoteStreams(prevRemoteStreams => {
        const newRemoteStreams = new Map(prevRemoteStreams);
        let entry = newRemoteStreams.get(peerId);
        const currentParticipantData = participantsRef.current.find(p => p.id === peerId);

        if (!entry) {
          const newStream = new MediaStream();
          entry = { stream: newStream, userInfo: currentParticipantData };
          newRemoteStreams.set(peerId, entry);
          addDebugLog(`Created new stream entry for ${peerId}`);
        }
        
        event.streams[0].getTracks().forEach(track => {
          if (!entry!.stream.getTrackById(track.id)) { 
              entry!.stream.addTrack(track);
              addDebugLog(`Added track ${track.kind} to stream for ${peerId}`);
          }
        });

        // Update userInfo if it has changed or needs to be set
        if (currentParticipantData && (!entry.userInfo || entry.userInfo.name !== currentParticipantData.name || entry.userInfo.photoUrl !== currentParticipantData.photoUrl)) {
            entry.userInfo = currentParticipantData;
            // Ensure a new object reference for the entry to trigger React update for VideoFeed
            newRemoteStreams.set(peerId, { ...entry, userInfo: currentParticipantData });
            addDebugLog(`Updated userInfo for ${peerId}`);
        } else if (!currentParticipantData && entry.userInfo) {
            entry.userInfo = undefined;
            newRemoteStreams.set(peerId, { ...entry, userInfo: undefined });
            addDebugLog(`Cleared userInfo for ${peerId} as participant data not found`);
        }
        
        addDebugLog(`Updated remote stream for ${peerId}. Total tracks in stream: ${entry.stream.getTracks().length}`);
        return newRemoteStreams;
      });
    };
    
    pc.oniceconnectionstatechange = () => {
      addDebugLog(`ICE state for ${peerId}: ${pc.iceConnectionState}`);
      if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
         addDebugLog(`ICE connection to ${peerId} ${pc.iceConnectionState}. Cleaning up.`);
         cleanupPeerConnection(peerId);
      }
    };
    pc.onsignalingstatechange = () => addDebugLog(`Signaling state for ${peerId}: ${pc.signalingState}`);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      addDebugLog(`Offer created and local description set for ${peerId}.`);
      const offerPayload: RoomSignal = {
        type: 'offer',
        senderId: sessionUser.id,
        senderName: sessionUser.name,
        data: pc.localDescription!.toJSON(),
      };
      const offerRef = push(ref(db, `conferenceRooms/${roomId}/signals/${peerId}`));
      await set(offerRef, offerPayload);
      addDebugLog(`Offer sent to ${peerId}`);
    } catch (error: any) {
      addDebugLog(`Error creating/sending offer to ${peerId}: ${error.message}`);
      cleanupPeerConnection(peerId);
    }
  }, [localStream, roomId, sessionUser, addDebugLog, cleanupPeerConnection]);

  useEffect(() => {
    if (!isInRoom || !roomId || !sessionUser?.id || !localStream) {
        addDebugLog(`Main useEffect skipped. isInRoom: ${isInRoom}, roomId: ${!!roomId}, sessionUser: ${!!sessionUser?.id}, localStream: ${!!localStream}`);
        return;
    }

    addDebugLog(`Setting up Firebase listeners for room ${roomId}, user ${sessionUser.id}`);

    const mySignalsDbRefPath = `conferenceRooms/${roomId}/signals/${sessionUser.id}`;
    const mySignalsDbRef = ref(db, mySignalsDbRefPath);
    const signalsCallback = (snapshot: any) => {
      if (!snapshot.exists()) return;
      snapshot.forEach((childSnapshot: any) => {
        const signal = childSnapshot.val() as RoomSignal;
        const signalKey = childSnapshot.key;
        const { senderId, senderName, type, data } = signal;

        if (!senderId || senderId === sessionUser.id || !signalKey) return; 

        addDebugLog(`Received signal type '${type}' from ${senderId} (${senderName || 'Unknown'})`);
        let pc = peerConnectionsRef.current.get(senderId);

        if (type === 'offer') {
          if (pc && pc.signalingState !== 'closed') {
            addDebugLog(`WARN: Received offer from ${senderId}, but PC already exists and is not closed. State: ${pc.signalingState}. Cleaning up old one.`);
            cleanupPeerConnection(senderId); // Clean up old before creating new
          }
          
          pc = new RTCPeerConnection(servers);
          peerConnectionsRef.current.set(senderId, pc);
          addDebugLog(`Created new PC for offer from ${senderId}`);

          localStream.getTracks().forEach(track => {
              try { pc!.addTrack(track, localStream); addDebugLog(`Added local track ${track.kind} to PC for ${senderId} (on offer)`);}
              catch (e:any) { addDebugLog(`Error adding local track on offer from ${senderId}: ${e.message}`); }
          });

          pc.onicecandidate = event => {
              if (event.candidate && roomId && sessionUser?.id) {
              addDebugLog(`Generated ICE candidate for ${senderId} (replying to offer): ${event.candidate.candidate.substring(0,30)}...`);
              const candidatePayload: RoomSignal = {
                  type: 'candidate',
                  senderId: sessionUser.id,
                  senderName: sessionUser.name,
                  data: event.candidate.toJSON(),
              };
              const candidateRef = push(ref(db, `conferenceRooms/${roomId}/signals/${senderId}`));
              set(candidateRef, candidatePayload).catch(e => addDebugLog(`Error sending ICE to ${senderId} (on offer): ${e.message}`));
              }
          };

          pc.ontrack = event => {
              addDebugLog(`Remote track received from ${senderId} (on offer path): Kind: ${event.track.kind}`);
              setRemoteStreams(prevRemoteStreams => {
                const newRemoteStreams = new Map(prevRemoteStreams);
                let entry = newRemoteStreams.get(senderId);
                const currentParticipantData = participantsRef.current.find(p => p.id === senderId);

                if (!entry) {
                  const newStream = new MediaStream();
                  entry = { stream: newStream, userInfo: currentParticipantData };
                  newRemoteStreams.set(senderId, entry);
                  addDebugLog(`Created new stream entry for ${senderId} via offer path`);
                }
                
                event.streams[0].getTracks().forEach(track => {
                    if(!entry!.stream.getTrackById(track.id)) {
                      entry!.stream.addTrack(track);
                      addDebugLog(`Added track ${track.kind} to stream for ${senderId} via offer path`);
                    }
                });
                
                if (currentParticipantData && (!entry.userInfo || entry.userInfo.name !== currentParticipantData.name || entry.userInfo.photoUrl !== currentParticipantData.photoUrl)) {
                    entry.userInfo = currentParticipantData;
                    newRemoteStreams.set(senderId, { ...entry, userInfo: currentParticipantData });
                     addDebugLog(`Updated userInfo for ${senderId} via offer path`);
                } else if (!currentParticipantData && entry.userInfo) {
                    entry.userInfo = undefined;
                    newRemoteStreams.set(senderId, { ...entry, userInfo: undefined });
                    addDebugLog(`Cleared userInfo for ${senderId} via offer path`);
                }

                addDebugLog(`Updated remote stream for ${senderId} (on offer path). Total tracks: ${entry.stream.getTracks().length}`);
                return newRemoteStreams;
              });
          };
          
          pc.oniceconnectionstatechange = () => {
              addDebugLog(`ICE state for ${senderId} (on offer path): ${pc!.iceConnectionState}`);
              if (['failed', 'disconnected', 'closed'].includes(pc!.iceConnectionState)) {
              addDebugLog(`ICE connection to ${senderId} ${pc!.iceConnectionState} (on offer path). Cleaning up.`);
              cleanupPeerConnection(senderId);
              }
          };
           pc.onsignalingstatechange = () => addDebugLog(`Signaling state for ${senderId} (on offer path): ${pc!.signalingState}`);
          
          pc!.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit))
            .then(() => { 
                addDebugLog(`Remote desc (offer) from ${senderId} set.`);
                return pc!.createAnswer();
            })
            .then(answer => {
                addDebugLog(`Answer created for ${senderId}.`);
                return pc!.setLocalDescription(answer);
            })
            .then(() => {
              addDebugLog(`Local desc (answer) for ${senderId} set.`);
              const answerPayload: RoomSignal = {
                type: 'answer',
                senderId: sessionUser.id!,
                senderName: sessionUser.name,
                data: pc!.localDescription!.toJSON(),
              };
              const answerRef = push(ref(db, `conferenceRooms/${roomId}/signals/${senderId}`));
              return set(answerRef, answerPayload);
            })
            .then(() => addDebugLog(`Answer sent to ${senderId}`))
            .catch(e => {
              addDebugLog(`Error processing offer / sending answer to ${senderId}: ${e.message || e}`);
              cleanupPeerConnection(senderId);
            });

        } else if (type === 'answer' && pc && pc.signalingState !== 'closed') {
          pc.setRemoteDescription(new RTCSessionDescription(data as RTCSessionDescriptionInit))
            .then(() => addDebugLog(`Remote description (answer) set from ${senderId}`))
            .catch(e => addDebugLog(`Error setting remote desc (answer) from ${senderId}: ${e.message || e}. PC state: ${pc.signalingState}`));
        } else if (type === 'candidate' && pc && pc.signalingState !== 'closed') {
           if (pc.remoteDescription) { 
            pc.addIceCandidate(new RTCIceCandidate(data as RTCIceCandidateInit))
              .then(() => addDebugLog(`Added ICE candidate from ${senderId}`))
              .catch(e => addDebugLog(`Error adding ICE candidate from ${senderId}: ${e.message || e}. PC state: ${pc.signalingState}`));
           } else {
             addDebugLog(`WARN: Received ICE candidate from ${senderId} but remote description not yet set. Candidate might be queued or dropped.`);
           }
        } else if (pc && pc.signalingState === 'closed' && (type === 'answer' || type === 'candidate')){
            addDebugLog(`Received ${type} from ${senderId} but PC is already closed. Ignoring.`);
        }
        remove(child(mySignalsDbRef, signalKey)).catch(e => addDebugLog(`Failed to remove processed signal ${signalKey}: ${e.message}`));
      });
    };
    addFirebaseDbListener(mySignalsDbRef, signalsCallback, 'value');

    const participantsDbRefPath = `conferenceRooms/${roomId}/participants`;
    const participantsDbRef = ref(db, participantsDbRefPath);
    const participantsCallback = (snapshot: any) => {
      const newParticipantsList: OnlineUser[] = [];
      snapshot.forEach((childSnapshot: any) => {
        newParticipantsList.push({ id: childSnapshot.key, ...childSnapshot.val() } as OnlineUser);
      });
      setParticipants(newParticipantsList); 
      addDebugLog(`Participants updated: ${newParticipantsList.map(p => `${p.name}(${p.id.substring(0,4)})`).join(', ')} (${newParticipantsList.length} total)`);

      newParticipantsList.forEach(p => {
        if (p.id !== sessionUser.id && !peerConnectionsRef.current.has(p.id) && localStream) {
           addDebugLog(`New participant ${p.name} (${p.id}) detected. Initializing connection.`);
           initializeAndSendOffer(p.id, p.name);
        }
      });
      
      peerConnectionsRef.current.forEach((_, pcPeerId) => { // Renamed pc to _ and peerId to pcPeerId
        if (!newParticipantsList.find(p => p.id === pcPeerId)) {
          addDebugLog(`Participant ${pcPeerId} left. Cleaning up their connection.`);
          cleanupPeerConnection(pcPeerId);
        }
      });
    };
    addFirebaseDbListener(participantsDbRef, participantsCallback, 'value');

    return () => {
      addDebugLog(`Cleaning up Firebase listeners for room ${roomId}, user ${sessionUser.id} (main useEffect)`);
      removeFirebaseDbListener(mySignalsDbRef, 'value');
      removeFirebaseDbListener(participantsDbRef, 'value');
    };
  }, [isInRoom, roomId, sessionUser, localStream, initializeAndSendOffer, cleanupPeerConnection, addDebugLog, addFirebaseDbListener, removeFirebaseDbListener]);

  const handleJoinRoom = async () => {
    if (!sessionUser || !sessionUser.id || !roomId) {
      toast({ title: "Error", description: "Session, User ID, or Room ID missing.", variant: "destructive" });
      addDebugLog("JoinRoom: sessionUser, sessionUser.id, or roomId missing.");
      return;
    }
    addDebugLog(`Attempting to join room ${roomId} as ${sessionUser.name} (${sessionUser.id})`);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setIsMicOn(true);
      setIsVideoOn(true);
      addDebugLog("Local media stream acquired.");

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
    } catch (err: any) {
      addDebugLog(`Error joining room or getting media: ${err.message}`);
      toast({ title: "Join Error", description: `Could not join room: ${err.message}`, variant: "destructive" });
      if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        setLocalStream(null);
      }
    }
  };

  const toggleMic = () => {
    if (localStream) {
      const enabled = !isMicOn;
      localStream.getAudioTracks().forEach(track => track.enabled = enabled);
      setIsMicOn(enabled);
      addDebugLog(`Mic toggled: ${enabled ? 'ON' : 'OFF'}`);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      const enabled = !isVideoOn;
      localStream.getVideoTracks().forEach(track => track.enabled = enabled);
      setIsVideoOn(enabled);
      addDebugLog(`Video toggled: ${enabled ? 'ON' : 'OFF'}`);
    }
  };

  const copyRoomLinkToClipboard = () => {
    const link = window.location.href;
    navigator.clipboard.writeText(link)
      .then(() => toast({ title: "Link Copied!", description: "Room link copied to clipboard." }))
      .catch(err => toast({ title: "Copy Failed", description: "Could not copy link.", variant: "destructive" }));
  };
  
  const VideoFeed = ({ stream, user, isLocal, isVideoActuallyOn }: { 
    stream: MediaStream, 
    user?: OnlineUser | null,
    isLocal?: boolean,
    isVideoActuallyOn: boolean 
  }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    
    useEffect(() => {
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
      }
    }, [stream]);

    const FallbackAvatar = () => (
      <Avatar className="w-16 h-16 border-2 border-muted">
          <AvatarImage src={user?.photoUrl} alt={user?.name || 'User'} data-ai-hint={user?.dataAiHint || "avatar abstract"} />
          <AvatarFallback>{user?.name ? user.name.charAt(0).toUpperCase() : <Users />}</AvatarFallback>
      </Avatar>
    );
    
    return (
      <Card className="overflow-hidden shadow-lg relative aspect-video flex flex-col justify-between bg-muted">
        <video ref={videoRef} autoPlay playsInline muted={isLocal} className="w-full h-full object-cover absolute inset-0" style={{ display: isVideoActuallyOn ? 'block' : 'none' }} />
        
        {!isVideoActuallyOn && (
           <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/70 text-white p-2">
             <FallbackAvatar />
             <p className="mt-2 text-sm truncate">{user?.name || user?.id || 'User'}</p>
             <p className="text-xs">
                {isLocal ? "Your video is off" : "Video off"}
             </p>
           </div>
        )}
        <CardFooter className="p-2 bg-gradient-to-t from-black/50 to-transparent text-xs text-white z-10 mt-auto">
          <p className="truncate">{isLocal ? `${sessionUser?.name || 'You'} (You)` : user?.name || user?.id || 'Remote User'}</p>
        </CardFooter>
      </Card>
    );
  };


  if (isLoading || !roomId) {
    return (
      <MainLayout>
        <Card className="w-full max-w-md p-8 text-center">
          <Skeleton className="h-8 w-3/4 mx-auto mb-4" />
          <Skeleton className="h-10 w-1/2 mx-auto" />
          <p className="mt-4 text-muted-foreground">Loading room...</p>
        </Card>
      </MainLayout>
    );
  }
  
  if (!sessionUser) {
     return (
      <MainLayout>
        <Card className="w-full max-w-md p-8 text-center">
            <AlertTriangle className="w-12 h-12 text-destructive mx-auto mb-4" />
            <CardTitle className="text-xl mb-2">Session Error</CardTitle>
            <CardDescription>Could not establish a user session for the room. Please try again or return to the home page.</CardDescription>
            <Button onClick={() => router.push('/')} className="mt-6">Go to Home</Button>
        </Card>
      </MainLayout>
    );
  }

  return (
    <MainLayout>
      <div className="w-full max-w-6xl mx-auto">
        <Card className="mb-6 shadow-xl">
          <CardHeader className="flex flex-row justify-between items-center">
            <div>
              <CardTitle className="text-2xl">Conference Room: {roomId.substring(0,8)}...</CardTitle>
              <CardDescription>Currently {participants.length} participant(s) in the room.</CardDescription>
            </div>
            <div className="flex gap-2">
               <Button onClick={copyRoomLinkToClipboard} variant="outline" size="sm">
                <Copy className="mr-2 h-4 w-4" /> Copy Link
              </Button>
              {isInRoom ? (
                <Button onClick={handleLeaveRoom} variant="destructive" size="sm">
                  <PhoneOff className="mr-2 h-4 w-4" /> Leave Room
                </Button>
              ) : (
                <Button onClick={handleJoinRoom} size="sm">
                  <Users className="mr-2 h-4 w-4" /> Join Conference
                </Button>
              )}
            </div>
          </CardHeader>
           {isInRoom && (
            <CardFooter className="border-t pt-4 flex justify-center gap-3">
                <Button variant="outline" size="icon" onClick={toggleMic} disabled={!localStream} aria-label="Toggle Microphone">
                    {isMicOn ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
                </Button>
                <Button variant="outline" size="icon" onClick={toggleVideo} disabled={!localStream} aria-label="Toggle Camera">
                    {isVideoOn ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
                </Button>
                 <Button onClick={() => router.push('/')} variant="outline" size="sm">
                  <LogOut className="mr-2 h-4 w-4" /> Back to Home
                </Button>
            </CardFooter>
          )}
        </Card>

        {isInRoom ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {localStream && sessionUser && (
              <VideoFeed stream={localStream} user={sessionUser} isLocal isVideoActuallyOn={isVideoOn} />
            )}
            {Array.from(remoteStreams.entries()).map(([peerId, { stream, userInfo }]) => {
                const remoteVideoTracks = stream.getVideoTracks();
                const isRemoteVideoActuallyOn = remoteVideoTracks.length > 0 && remoteVideoTracks.some(track => track.enabled && !track.muted);
                return <VideoFeed key={peerId} stream={stream} user={userInfo} isLocal={false} isVideoActuallyOn={isRemoteVideoActuallyOn} />;
            })}
          </div>
        ) : (
          <Card className="p-8 text-center">
            <Users className="w-16 h-16 mx-auto text-primary mb-4" />
            <CardTitle className="text-xl">Ready to join?</CardTitle>
            <CardDescription>Click "Join Conference" above to start your video and connect with others.</CardDescription>
          </Card>
        )}
        
        <div className="w-full max-w-2xl mt-8 mx-auto">
            <Card>
                <CardHeader className="p-3">
                    <CardTitle className="text-sm">Room Debug Log</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="max-h-[200px] overflow-y-auto p-2 text-xs space-y-1 bg-muted/30 rounded-b-md">
                    {debugLogs.map((log, index) => (
                        <div key={index} className="font-mono whitespace-pre-wrap break-all">
                        {log}
                        </div>
                    ))}
                    {debugLogs.length === 0 && <p className="text-muted-foreground italic">No logs yet.</p>}
                    </div>
                </CardContent>
            </Card>
        </div>

      </div>
    </MainLayout>
  );
}

