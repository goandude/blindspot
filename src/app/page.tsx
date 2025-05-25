
"use client";

import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { UserProfileCard } from '@/components/features/profile/user-profile-card';
import { VideoChatPlaceholder } from '@/components/features/chat/video-chat-placeholder';
import { ReportDialog } from '@/components/features/reporting/report-dialog';
import { MainLayout } from '@/components/layout/main-layout';
import type { UserProfile, OnlineUser, IncomingCallOffer, CallAnswer } from '@/types';
import { Edit3, LogOut, PhoneIncoming, PhoneOff, Video as VideoIcon, UserCircle } from 'lucide-react';
import { db } from '@/lib/firebase';
import { ref, set, onValue, off, remove, serverTimestamp, push, child, get, Unsubscribe } from 'firebase/database';
import { useToast } from '@/hooks/use-toast';
import { useAuth } from '@/hooks/use-auth';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { OnlineUsersPanel } from '@/components/features/online-users/online-users-panel';

type ChatState = 'idle' | 'dialing' | 'connecting' | 'connected' | 'revealed' | 'receiving_call';

const servers = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

export default function HomePage() {
  const { user: firebaseUser, profile: currentUserProfile, loading: authLoading, signOut, updateUserProfile } = useAuth();
  const [chatState, setChatState] = useState<ChatState>('idle');
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [isMicOn, setIsMicOn] = useState(true);
  const [isVideoOn, setIsVideoOn] = useState(true);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [editableProfile, setEditableProfile] = useState<Partial<UserProfile>>({});
  const [onlineUsers, setOnlineUsers] = useState<OnlineUser[]>([]);
  const [incomingCall, setIncomingCall] = useState<IncomingCallOffer | null>(null);
  const [peerProfile, setPeerProfile] = useState<UserProfile | null>(null);

  const { toast } = useToast();

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const roomIdRef = useRef<string | null>(null);
  const peerIdRef = useRef<string | null>(null); // ID of the user we are calling or being called by
  const isCallerRef = useRef<boolean>(false);
  const firebaseListenersRef = useRef<Array<{ path: string; unsubscribe: Unsubscribe }>>([]);
  const chatStateRef = useRef<ChatState>(chatState); // To access current chat state in callbacks

  useEffect(() => {
    chatStateRef.current = chatState;
  }, [chatState]);
  
  // Update editable profile when currentUserProfile changes
  useEffect(() => {
    if (currentUserProfile) {
      setEditableProfile({
        name: currentUserProfile.name,
        bio: currentUserProfile.bio,
        photoUrl: currentUserProfile.photoUrl,
      });
    }
  }, [currentUserProfile]);

  const handleOpenProfileModal = () => {
    if (currentUserProfile) {
      setEditableProfile({
        name: currentUserProfile.name,
        bio: currentUserProfile.bio,
        photoUrl: currentUserProfile.photoUrl,
      });
      setIsProfileModalOpen(true);
    }
  };

  const handleSaveProfile = async () => {
    if (!currentUserProfile || !firebaseUser) return;
    const updates: Partial<UserProfile> = {};
    if (editableProfile.name && editableProfile.name !== currentUserProfile.name) updates.name = editableProfile.name;
    if (editableProfile.bio && editableProfile.bio !== currentUserProfile.bio) updates.bio = editableProfile.bio;
    if (editableProfile.photoUrl && editableProfile.photoUrl !== currentUserProfile.photoUrl) updates.photoUrl = editableProfile.photoUrl;


    if (Object.keys(updates).length > 0) {
      await updateUserProfile(firebaseUser.uid, updates);
      // If name or photoUrl changed, update online presence
      if (updates.name || updates.photoUrl) {
        const onlineUserRef = ref(db, `onlineUsers/${firebaseUser.uid}`);
        const currentPresenceData = (await get(onlineUserRef)).val();
        if (currentPresenceData) {
          await set(onlineUserRef, {
            ...currentPresenceData,
            name: updates.name || currentPresenceData.name,
            photoUrl: updates.photoUrl || currentPresenceData.photoUrl,
          });
        }
      }
    }
    setIsProfileModalOpen(false);
  };
  
  // Presence system and online users listener
  useEffect(() => {
    if (!firebaseUser || !currentUserProfile) return;

    const currentUserId = firebaseUser.uid;
    const userStatusRef = ref(db, `onlineUsers/${currentUserId}`);
    const presenceData: OnlineUser = {
      id: currentUserId,
      name: currentUserProfile.name,
      photoUrl: currentUserProfile.photoUrl,
    };
    set(userStatusRef, presenceData);
    const onDisconnectRef = ref(db, `onlineUsers/${currentUserId}`);
    remove(onDisconnectRef).catch(() => {}); // Clear previous onDisconnect
    onValue(ref(db, '.info/connected'), (snapshot) => {
      if (snapshot.val() === true) {
        set(userStatusRef, presenceData);
        // Set onDisconnect to remove user
        remove(onDisconnectRef).catch(() => {}); // ensure this is a new onDisconnect
        set(onDisconnectRef, null, {onDisconnect: {remove: () => {}}}); // More robust onDisconnect
        
        // For older Firebase SDKs or specific configurations, `set(ref, null).onDisconnect().remove()` might be needed.
        // The current way using onDisconnect.remove() is cleaner if supported.
        // Let's try the Firebase docs recommended way if the above doesn't work robustly:
        const onDisconnectRemove = ref(db, `onlineUsers/${currentUserId}`);
        onValue(ref(db, '.info/connected'), (snapshot) => {
            if (snapshot.val() === false) { return; } // not connected
            set(onDisconnectRemove, null).catch(()=>{}); // Clear previous onDisconnect
            set(onDisconnectRemove, presenceData).then(() => {
                return onDisconnectRemove.onDisconnect().remove();
            }).catch(err => console.error("Error setting onDisconnect:", err));
        });

      }
    });
    

    const onlineUsersRefPath = 'onlineUsers';
    const onlineUsersListener = onValue(ref(db, onlineUsersRefPath), (snapshot) => {
      const users = snapshot.val();
      const userList: OnlineUser[] = users ? Object.values(users) : [];
      setOnlineUsers(userList);
    });
    addFirebaseListener(onlineUsersRefPath, onlineUsersListener);

    return () => {
      remove(userStatusRef); // Clean up user presence on component unmount (e.g., logout)
      removeFirebaseListener(onlineUsersRefPath);
    };
  }, [firebaseUser, currentUserProfile]);

  // Listener for incoming calls
  useEffect(() => {
    if (!currentUserProfile) return;
    const incomingCallPath = `callSignals/${currentUserProfile.id}/pendingOffer`;
    const incomingCallListener = onValue(ref(db, incomingCallPath), (snapshot) => {
      const offerData = snapshot.val() as IncomingCallOffer | null;
      if (offerData && chatStateRef.current === 'idle') {
        setIncomingCall(offerData);
        setChatState('receiving_call');
      } else if (!offerData && chatStateRef.current === 'receiving_call') {
        // Offer was revoked or declined by caller
        setIncomingCall(null);
        setChatState('idle');
      }
    });
    addFirebaseListener(incomingCallPath, incomingCallListener);
    return () => removeFirebaseListener(incomingCallPath);
  }, [currentUserProfile]);

  const addFirebaseListener = (path: string, unsubscribe: Unsubscribe) => {
    removeFirebaseListener(path); // Remove existing if any
    firebaseListenersRef.current.push({ path, unsubscribe });
  };

  const removeFirebaseListener = (path: string) => {
    const listenerIndex = firebaseListenersRef.current.findIndex(l => l.path === path);
    if (listenerIndex > -1) {
      try {
        firebaseListenersRef.current[listenerIndex].unsubscribe();
      } catch (error) {
        console.warn("Error unsubscribing Firebase listener for path:", path, error);
      }
      firebaseListenersRef.current.splice(listenerIndex, 1);
    }
  };
  
  const cleanupAllFirebaseListeners = useCallback(() => {
    firebaseListenersRef.current.forEach(({ unsubscribe, path }) => {
      try {
        unsubscribe();
      } catch (error) {
        console.warn("Error unsubscribing Firebase listener during general cleanup:", path, error);
      }
    });
    firebaseListenersRef.current = [];
  }, []);


  const cleanupWebRTC = useCallback(() => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.oniceconnectionstatechange = null;
      peerConnectionRef.current.onsignalingstatechange = null;
      localStream?.getTracks().forEach(track => { // Stop local tracks before closing PC
        if (peerConnectionRef.current?.getSenders) {
          peerConnectionRef.current.getSenders().forEach(sender => {
            if (sender.track === track) {
              try {
                peerConnectionRef.current?.removeTrack(sender);
              } catch (e) { console.warn("Error removing track:", e); }
            }
          });
        }
      });
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      setLocalStream(null);
    }
    setRemoteStream(null);
  }, [localStream]);

  const cleanupCallData = useCallback(async () => {
    const currentRoomId = roomIdRef.current;
    const currentPeerId = peerIdRef.current;
    const currentUserId = currentUserProfile?.id;

    if (currentRoomId) {
      remove(ref(db, `callSignals/${currentRoomId}`)).catch(e => console.warn("Error removing room signals:", e));
      remove(ref(db, `iceCandidates/${currentRoomId}`)).catch(e => console.warn("Error removing ICE candidates for room:", e));
    }
    if (isCallerRef.current && currentPeerId) { // Caller clears the offer they sent
      remove(ref(db, `callSignals/${currentPeerId}/pendingOffer`)).catch(e => console.warn("Error removing pending offer by caller:", e));
    }
    if (!isCallerRef.current && currentUserId && peerIdRef.current) { // Callee clears their accepted offer path
         remove(ref(db, `callSignals/${currentUserId}/pendingOffer`)).catch(e => console.warn("Error removing pending offer by callee:", e));
    }
  }, [currentUserProfile?.id]);

  useEffect(() => {
    return () => {
      cleanupWebRTC();
      cleanupAllFirebaseListeners();
      if (currentUserProfile?.id) {
        remove(ref(db, `onlineUsers/${currentUserProfile.id}`));
      }
      cleanupCallData(); // Ensure call data is cleaned on unmount/logout
    };
  }, [cleanupWebRTC, cleanupAllFirebaseListeners, cleanupCallData, currentUserProfile?.id]);

  const handleEndCall = useCallback(async (showReveal = true) => {
    const wasConnected = chatStateRef.current === 'connected' || chatStateRef.current === 'connecting' || chatStateRef.current === 'dialing';
    
    cleanupWebRTC();
    
    // Remove specific listeners related to this call (ICE, answer)
    if (roomIdRef.current) {
        removeFirebaseListener(`callSignals/${roomIdRef.current}/answer`);
        removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${peerIdRef.current}`);
        removeFirebaseListener(`iceCandidates/${roomIdRef.current}/${currentUserProfile?.id}`);
    }
    
    await cleanupCallData();

    if (showReveal && peerIdRef.current && wasConnected) {
        if (!peerProfile) { // Fetch peer profile if not already fetched
            const profileSnap = await get(child(ref(db, 'users'), peerIdRef.current));
            if (profileSnap.exists()) setPeerProfile(profileSnap.val() as UserProfile);
        }
        setChatState('revealed');
    } else {
        setChatState('idle');
        setPeerProfile(null);
    }
    
    roomIdRef.current = null;
    peerIdRef.current = null;
    isCallerRef.current = false;
    setIncomingCall(null); // Clear any pending incoming call UI

  }, [cleanupWebRTC, cleanupCallData, currentUserProfile?.id, peerProfile]);


  const initializePeerConnection = useCallback((currentLocalStream: MediaStream) => {
    if (!currentUserProfile?.id || !currentLocalStream) return null;

    const pc = new RTCPeerConnection(servers);
    currentLocalStream.getTracks().forEach(track => pc.addTrack(track, currentLocalStream));

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      } else {
        const newStream = new MediaStream();
        newStream.addTrack(event.track);
        setRemoteStream(newStream);
      }
    };
    
    pc.onicecandidate = (event) => {
        if (event.candidate && roomIdRef.current && currentUserProfile?.id && peerIdRef.current) {
            const candidatesRef = ref(db, `iceCandidates/${roomIdRef.current}/${currentUserProfile.id}`);
            push(candidatesRef, event.candidate.toJSON());
        }
    };

    pc.oniceconnectionstatechange = () => {
      if (!pc) return;
      if (pc.iceConnectionState === 'connected') {
        if (chatStateRef.current === 'connecting' || chatStateRef.current === 'dialing') setChatState('connected');
      } else if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
        if (chatStateRef.current !== 'idle' && chatStateRef.current !== 'revealed') {
          toast({ title: "Connection Issue", description: `Call state: ${pc.iceConnectionState}. Ending call.`, variant: "default" });
          handleEndCall(false);
        }
      }
    };
    return pc;
  }, [currentUserProfile?.id, handleEndCall, toast]);

  const startLocalStream = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      setLocalStream(stream);
      setIsVideoOn(true);
      setIsMicOn(true);
      return stream;
    } catch (err) {
      console.error("Error accessing media devices.", err);
      toast({ title: "Media Error", description: "Could not access camera/microphone.", variant: "destructive" });
      setChatState('idle');
      return null;
    }
  };

  const initiateDirectCall = async (targetUserId: string) => {
    if (!currentUserProfile || targetUserId === currentUserProfile.id) {
      toast({title: "Cannot call self", variant: "destructive"});
      return;
    }
    await handleEndCall(false); // Clean up any previous call state

    const stream = await startLocalStream();
    if (!stream) return;

    const pc = initializePeerConnection(stream);
    if (!pc) {
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      cleanupWebRTC();
      return;
    }
    peerConnectionRef.current = pc;
    
    isCallerRef.current = true;
    peerIdRef.current = targetUserId;
    const newRoomId = push(child(ref(db), 'rooms')).key; // Generate a unique room ID
    if (!newRoomId) {
        toast({title: "Error", description: "Could not create a call room.", variant: "destructive"});
        return;
    }
    roomIdRef.current = newRoomId;
    setChatState('dialing');

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const offerPayload: IncomingCallOffer = {
        roomId: newRoomId,
        offer,
        callerId: currentUserProfile.id,
        callerName: currentUserProfile.name,
        callerPhotoUrl: currentUserProfile.photoUrl,
      };
      await set(ref(db, `callSignals/${targetUserId}/pendingOffer`), offerPayload);
      toast({ title: "Calling...", description: `Calling ${targetUserId.substring(0,6)}...` });

      // Listen for answer
      const answerPath = `callSignals/${newRoomId}/answer`;
      const answerListener = onValue(ref(db, answerPath), async (snapshot) => {
        if (snapshot.exists()) {
          const { answer: answerSdp, calleeId } = snapshot.val() as CallAnswer;
          if (pc.signalingState === 'have-local-offer' || pc.signalingState === 'stable') { // Or check if remoteDescription is null
            await pc.setRemoteDescription(new RTCSessionDescription(answerSdp));
            console.log("Remote description (answer) set by caller.");
            remove(ref(db, answerPath)); // Clean up answer once processed
            removeFirebaseListener(answerPath);
          }
        }
      });
      addFirebaseListener(answerPath, answerListener);

      // Listen for ICE candidates from callee
      const calleeIcePath = `iceCandidates/${newRoomId}/${targetUserId}`;
      const calleeIceListener = onValue(ref(db, calleeIcePath), (snapshot) => {
        snapshot.forEach((childSnapshot) => {
          const candidate = childSnapshot.val();
          if (candidate && pc.remoteDescription) { // Ensure remoteDescription is set before adding candidates
            pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding callee ICE candidate:", e));
          }
        });
      });
      addFirebaseListener(calleeIcePath, calleeIceListener);

    } catch (error) {
      console.error("Error initiating call:", error);
      toast({ title: "Call Error", description: "Could not initiate the call.", variant: "destructive" });
      handleEndCall(false);
    }
  };

  const handleAcceptCall = async () => {
    if (!incomingCall || !currentUserProfile) return;
    
    await handleEndCall(false); // Clean up any previous call before accepting new one

    const stream = await startLocalStream();
    if (!stream) {
      setIncomingCall(null);
      setChatState('idle');
      return;
    }

    const pc = initializePeerConnection(stream);
    if (!pc) {
      toast({ title: "WebRTC Error", description: "Failed to initialize video call components.", variant: "destructive" });
      setIncomingCall(null);
      setChatState('idle');
      cleanupWebRTC();
      return;
    }
    peerConnectionRef.current = pc;

    isCallerRef.current = false;
    peerIdRef.current = incomingCall.callerId;
    roomIdRef.current = incomingCall.roomId;
    setChatState('connecting');

    try {
      await pc.setRemoteDescription(new RTCSessionDescription(incomingCall.offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      const answerPayload: CallAnswer = {
        answer,
        calleeId: currentUserProfile.id,
      };
      await set(ref(db, `callSignals/${incomingCall.roomId}/answer`), answerPayload);
      
      // Remove the pending offer for this user
      await remove(ref(db, `callSignals/${currentUserProfile.id}/pendingOffer`));
      setIncomingCall(null); // Clear incoming call UI

      // Listen for ICE candidates from caller
      const callerIcePath = `iceCandidates/${incomingCall.roomId}/${incomingCall.callerId}`;
      const callerIceListener = onValue(ref(db, callerIcePath), (snapshot) => {
        snapshot.forEach((childSnapshot) => {
          const candidate = childSnapshot.val();
          if (candidate && pc.remoteDescription) { // Ensure remoteDescription is set (it is, from offer)
             pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.error("Error adding caller ICE candidate:", e));
          }
        });
      });
      addFirebaseListener(callerIcePath, callerIceListener);

    } catch (error) {
      console.error("Error accepting call:", error);
      toast({ title: "Call Error", description: "Could not accept the call.", variant: "destructive" });
      handleEndCall(false);
    }
  };

  const handleDeclineCall = async () => {
    if (!incomingCall || !currentUserProfile) return;
    // Optionally notify caller about decline (e.g. set a 'declined' flag on the room signal)
    await remove(ref(db, `callSignals/${currentUserProfile.id}/pendingOffer`));
    setIncomingCall(null);
    setChatState('idle');
    toast({title: "Call Declined"});
  };

  const handleFindNew = async () => {
    await handleEndCall(false); // This will reset state to 'idle'
    setPeerProfile(null);
  };

  const toggleMic = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => track.enabled = !isMicOn);
      setIsMicOn(!isMicOn);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => track.enabled = !isVideoOn);
      setIsVideoOn(!isVideoOn);
    }
  };

  if (authLoading) {
    return (
      <MainLayout>
        <div className="flex flex-col items-center gap-4">
          <Skeleton className="h-12 w-12 rounded-full" />
          <Skeleton className="h-4 w-[250px]" />
          <Skeleton className="h-4 w-[200px]" />
        </div>
      </MainLayout>
    );
  }

  if (!currentUserProfile) { // User not logged in
    return (
       <MainLayout>
        <div className="text-center mb-4">
            <h1 className="text-4xl font-bold text-primary mb-2">BlindSpot Social</h1>
            <p className="text-lg text-foreground/80">Connect Directly. Chat Visually.</p>
        </div>
        <div className="flex flex-col items-center gap-6 p-8 bg-card rounded-xl shadow-lg w-full max-w-md">
            <UserCircle className="w-24 h-24 text-primary" />
            <h2 className="text-2xl font-semibold text-foreground">Welcome!</h2>
            <p className="text-center text-muted-foreground max-w-sm">
                Sign in to see who's online and start a video call.
            </p>
            {/* The useAuth hook provides a signInWithGoogle method, but it's not directly used here.
                Firebase typically manages the redirect or popup for Google Sign-In.
                If a dedicated button for signInWithGoogle from useAuth is needed, it should be added.
                For now, assuming FirebaseUI or similar handles the sign-in flow if not already signed in.
                The <AuthButtons /> component from previous iterations would typically handle this.
                Let's assume the useAuth hook handles the initial auth check and provides `firebaseUser`.
                If firebaseUser is null, the sign-in prompt (implicitly handled by Firebase or an Auth page) shows.
            */}
            <p className="text-sm text-muted-foreground">Please sign in to continue.</p>
             {/* Placeholder for a sign-in button if useAuth doesn't redirect */}
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

      {chatState === 'idle' && currentUserProfile && (
        <div className="flex flex-col items-center gap-6 p-8 bg-card rounded-xl shadow-lg w-full max-w-lg">
          <div className='flex flex-row justify-between w-full items-center'>
            <Button onClick={handleOpenProfileModal} variant="ghost" size="sm" className="text-sm">
                <Edit3 className="mr-2 h-4 w-4" /> Edit Your Profile
            </Button>
            <Button onClick={signOut} variant="outline" size="sm">
                <LogOut className="mr-2 h-4 w-4" /> Sign Out
            </Button>
          </div>
          <UserProfileCard user={currentUserProfile} />
          <div className="w-full mt-6">
            <OnlineUsersPanel 
                onlineUsers={onlineUsers} 
                onInitiateCall={initiateDirectCall}
                currentUserId={currentUserProfile.id}
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
          />
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md">
            <Button onClick={() => handleEndCall(true)} size="lg" className="flex-1" variant="destructive">
              <PhoneOff className="mr-2 h-5 w-5" />
              End Call
            </Button>
             {chatState === 'connected' && ( // Only allow reporting once connected and peer is known
                <ReportDialog
                reportedUser={peerProfile} // Will be null until reveal, or fetched earlier
                triggerButtonText="Report User"
                triggerButtonVariant="outline"
                triggerButtonFullWidth={true}
                />
            )}
          </div>
        </div>
      )}

      {chatState === 'revealed' && currentUserProfile && (
        <div className="w-full flex flex-col items-center gap-8">
          <h2 className="text-3xl font-semibold text-primary">Call Ended</h2>
          {peerProfile ? (
            <>
              <p className="text-muted-foreground">You chatted with {peerProfile.name}.</p>
              <div className="grid md:grid-cols-2 gap-8 w-full">
                <UserProfileCard user={currentUserProfile} />
                <UserProfileCard user={peerProfile} />
              </div>
            </>
          ) : (
            <p className="text-muted-foreground">The other user's profile could not be loaded.</p>
          )}
          <div className="flex flex-col sm:flex-row gap-4 w-full max-w-md mt-4">
            <Button onClick={handleFindNew} size="lg" variant="secondary" className="flex-1">
              <VideoIcon className="mr-2 h-5 w-5" />
              Back to Online Users
            </Button>
            {peerProfile && (
                 <ReportDialog
                 reportedUser={peerProfile}
                 triggerButtonText={`Report ${peerProfile.name}`}
                 triggerButtonVariant="destructive"
                 triggerButtonFullWidth={true}
               />
            )}
          </div>
           <Button onClick={signOut} variant="outline" size="lg" className="mt-4">
                <LogOut className="mr-2 h-5 w-5" /> Sign Out
            </Button>
        </div>
      )}
      
      {/* Profile Edit Modal */}
      <Dialog open={isProfileModalOpen} onOpenChange={setIsProfileModalOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Your Profile</DialogTitle>
            <DialogDescription>
              Make changes to your public profile information.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="profile-name">Name</Label>
              <Input
                id="profile-name"
                value={editableProfile.name || ''}
                onChange={(e) => setEditableProfile(p => ({ ...p, name: e.target.value }))}
              />
            </div>
             <div className="grid gap-2">
              <Label htmlFor="profile-photo-url">Photo URL</Label>
              <Input
                id="profile-photo-url"
                value={editableProfile.photoUrl || ''}
                onChange={(e) => setEditableProfile(p => ({ ...p, photoUrl: e.target.value }))}
                placeholder="https://example.com/your-photo.png"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="profile-bio">Bio</Label>
              <Textarea
                id="profile-bio"
                value={editableProfile.bio || ''}
                onChange={(e) => setEditableProfile(p => ({ ...p, bio: e.target.value }))}
                placeholder="Tell us a bit about yourself..."
                className="min-h-[100px]"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={handleSaveProfile}>Save Changes</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Incoming Call Dialog */}
      <AlertDialog open={chatState === 'receiving_call' && !!incomingCall}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
                <PhoneIncoming className="text-primary h-6 w-6" />
                Incoming Call
            </AlertDialogTitle>
            <AlertDialogDescription>
              You have an incoming call from:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-3 my-4 p-3 bg-muted/50 rounded-md">
            <Avatar className="h-12 w-12">
                <AvatarImage src={incomingCall?.callerPhotoUrl} alt={incomingCall?.callerName} />
                <AvatarFallback>{incomingCall?.callerName?.charAt(0) || 'U'}</AvatarFallback>
            </Avatar>
            <span className="font-semibold text-lg">{incomingCall?.callerName || 'Unknown Caller'}</span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDeclineCall}>Decline</AlertDialogCancel>
            <AlertDialogAction onClick={handleAcceptCall}>Accept</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </MainLayout>
  );
}
