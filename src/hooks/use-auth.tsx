
"use client";
import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  auth, 
  db, 
  googleProvider 
} from '@/lib/firebase';
import { 
  onAuthStateChanged, 
  signInWithRedirect, 
  getRedirectResult,
  signOut, 
  type User as FirebaseUser 
} from 'firebase/auth';
import { 
  ref, 
  set, 
  onValue, 
  off, 
  remove, 
  serverTimestamp, 
  get, 
  type DatabaseReference 
} from 'firebase/database';
import type { UserProfile, OnlineUser } from '@/types';
import { useToast } from '@/hooks/use-toast';

interface AuthState {
  currentUser: FirebaseUser | null;
  userProfile: UserProfile | null;
  loading: boolean; 
  profileLoading: boolean; 
  isProfileSetupNeeded: boolean;
  error: Error | null;
}

const initialAuthState: AuthState = {
  currentUser: null,
  userProfile: null,
  loading: true,
  profileLoading: false,
  isProfileSetupNeeded: false,
  error: null,
};

const hookDebugLog = (message: string) => {
  const timestamp = new Date().toLocaleTimeString([], { 
    hour: '2-digit', 
    minute: '2-digit', 
    second: '2-digit', 
    fractionalSecondDigits: 3 
  });
  console.log(`[useAuth DEBUG] ${timestamp} - ${message}`);
};

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>(initialAuthState);
  const { toast } = useToast();
  
  const fetchUserProfile = useCallback(async (userId: string): Promise<UserProfile | null> => {
    hookDebugLog(`fetchUserProfile: Attempting to fetch profile for user: ${userId}`);
    try {
      const userRef = ref(db, `users/${userId}`);
      const snapshot = await get(userRef);
      if (snapshot.exists()) {
        const profile = snapshot.val() as UserProfile;
        hookDebugLog(`fetchUserProfile: Profile found for ${userId}`);
        return profile;
      }
      hookDebugLog(`fetchUserProfile: No profile found for ${userId}.`);
      return null;
    } catch (error: any) {
      hookDebugLog(`fetchUserProfile: Error fetching profile for ${userId}: ${error.message}`);
      console.error("Error fetching user profile:", error);
      throw error; 
    }
  }, []);

  const createUserProfileInDb = useCallback(async (firebaseUser: FirebaseUser, countryCode: string): Promise<UserProfile> => {
    hookDebugLog(`createUserProfileInDb: Creating DB profile for new Google user: ${firebaseUser.uid}`);
    const newUserProfile: UserProfile = {
      id: firebaseUser.uid,
      name: firebaseUser.displayName || `User ${firebaseUser.uid.substring(0, 4)}`,
      email: firebaseUser.email || undefined,
      photoUrl: firebaseUser.photoURL || `https://placehold.co/96x96.png?text=${(firebaseUser.displayName || 'U').charAt(0).toUpperCase()}`,
      dataAiHint: 'abstract character',
      countryCode: countryCode,
      createdAt: new Date().toISOString(), 
      lastLogin: new Date().toISOString(), 
    };
    try {
      await set(ref(db, `users/${firebaseUser.uid}`), newUserProfile);
      hookDebugLog(`createUserProfileInDb: DB Profile created for ${firebaseUser.uid}`);
      return newUserProfile;
    } catch (error: any) {
      hookDebugLog(`createUserProfileInDb: Error creating DB profile for ${firebaseUser.uid}: ${error.message}`);
      console.error("Error creating user profile in DB:", error);
      throw error; 
    }
  }, []);

  useEffect(() => {
    hookDebugLog("Effect: Checking for redirect result on app load");
    let isMounted = true;

    const handleRedirect = async () => {
        try {
            const result = await getRedirectResult(auth);
            if (result && isMounted) {
                hookDebugLog(`Redirect result processed: User ${result.user.uid}. onAuthStateChanged will now handle.`);
            } else if (isMounted) {
                hookDebugLog("No redirect result found, or component unmounted.");
                 setAuthState(prev => ({ ...prev, loading: false })); 
            }
        } catch (error: any) {
            hookDebugLog(`Error handling redirect result: ${error.message}`);
            if (isMounted) {
                setAuthState(prev => ({ ...prev, error, loading: false }));
            }
            toast({ title: "Sign-In Error", description: error.message, variant: "destructive" });
        }
    };
    
    handleRedirect();

    return () => {
        isMounted = false;
    }
  }, [toast]);


  useEffect(() => {
    hookDebugLog("Effect: Setting up onAuthStateChanged listener.");
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      hookDebugLog(`onAuthStateChanged triggered. User UID: ${user ? user.uid : 'null'}`);

      if (user) {
        setAuthState(prev => ({
          ...prev,
          currentUser: user,
          profileLoading: true, 
          loading: true, 
          error: null
        }));

        try {
          let profile = await fetchUserProfile(user.uid);
          let needsSetup = false;

          if (profile) {
            hookDebugLog(`Profile exists for ${user.uid}. Updating lastLogin.`);
            await set(ref(db, `users/${user.uid}/lastLogin`), new Date().toISOString());
            needsSetup = !profile.birthdate || !profile.sex || !profile.sexualOrientation; 
            hookDebugLog(`Profile for ${user.uid}: Needs setup? ${needsSetup}`);
          } else {
            hookDebugLog(`No profile for ${user.uid}. Will attempt to create a basic one.`);
            let countryCode = 'XX';
            try {
              const res = await fetch('https://ipapi.co/country_code/');
              if (res.ok) countryCode = (await res.text()).trim();
              else hookDebugLog(`Could not fetch country code: ${res.status}`);
            } catch (e: any) {
              hookDebugLog(`Error fetching country code: ${e.message}, using default 'XX'`);
            }
            
            profile = await createUserProfileInDb(user, countryCode);
            needsSetup = true; 
            hookDebugLog(`New profile created for ${user.uid}. Needs setup: ${needsSetup}`);
          }
          
          setAuthState(prev => ({
            ...prev,
            userProfile: profile,
            isProfileSetupNeeded: needsSetup,
            profileLoading: false, 
            loading: false, 
          }));

        } catch (profileError: any) {
          hookDebugLog(`Error during profile processing for ${user.uid}: ${profileError.message}`);
          setAuthState(prev => ({
            ...prev,
            userProfile: null,
            isProfileSetupNeeded: false, 
            profileLoading: false,
            loading: false, 
            error: profileError,
          }));
        }
      } else {
        hookDebugLog("No user found by onAuthStateChanged. Resetting auth state.");
        setAuthState({
          currentUser: null,
          userProfile: null,
          loading: false, 
          profileLoading: false,
          isProfileSetupNeeded: false,
          error: null,
        });
      }
    });

    return () => {
      hookDebugLog("Effect: Cleaning up onAuthStateChanged listener.");
      unsubscribe();
    };
  }, [fetchUserProfile, createUserProfileInDb, toast]);

  // Presence (onDisconnect only) for AUTHENTICATED users
  useEffect(() => {
    if (!authState.currentUser) {
      hookDebugLog("Auth Presence (onDisconnect): No currentUser. Skipping onDisconnect setup.");
      return;
    }
    const userId = authState.currentUser.uid;
    hookDebugLog(`Auth Presence (onDisconnect): Setting up for authenticated user ${userId}.`);
    const userStatusRef: DatabaseReference = ref(db, `onlineUsers/${userId}`);
    
    // Set up onDisconnect immediately when an authenticated user is present
    userStatusRef.onDisconnect().remove()
      .then(() => hookDebugLog(`Auth Presence (onDisconnect): onDisconnect set for user ${userId}`))
      .catch(e => hookDebugLog(`Auth Presence (onDisconnect): Error setting onDisconnect for ${userId}: ${e.message}`));

    return () => {
      // Firebase automatically cleans up onDisconnect listeners when the client disconnects
      // or when they are explicitly removed. No explicit cleanup needed here unless
      // we want to cancel it *before* disconnect (which we don't for this hook's purpose).
      hookDebugLog(`Auth Presence (onDisconnect): Cleanup for user ${userId} (onDisconnect handler remains with Firebase until actual disconnect).`);
    };
  }, [authState.currentUser]); 

  const signInWithGoogle = async () => {
    hookDebugLog("signInWithGoogle: Starting Google Sign-In process.");
    setAuthState(prev => ({ 
      ...prev, 
      loading: true, 
      profileLoading: false, 
      error: null 
    }));
    
    try {
      await signInWithRedirect(auth, googleProvider);
      hookDebugLog("signInWithGoogle: Redirect initiated. Waiting for page reload and onAuthStateChanged.");
    } catch (error: any) {
      hookDebugLog(`signInWithGoogle: Error during redirect initiation: ${error.message}`);
      console.error("Google Sign-In error:", error);
      setAuthState(prev => ({ ...prev, loading: false, error })); 
      toast({ 
        title: "Sign-In Error", 
        description: error.message, 
        variant: "destructive" 
      });
    }
  };

  const signOutUser = async () => {
    const currentUserId = authState.currentUser?.uid;
    hookDebugLog(`signOutUser: Signing out user: ${currentUserId || 'N/A'}`);
    
    if (currentUserId) {
      const userStatusRef = ref(db, `onlineUsers/${currentUserId}`);
      try {
        await remove(userStatusRef);
        hookDebugLog(`signOutUser: Removed user ${currentUserId} from onlineUsers.`);
      } catch (error: any) {
        hookDebugLog(`signOutUser: Error removing presence for ${currentUserId}: ${error.message}`);
      }
    }

    try {
      await signOut(auth);
      hookDebugLog("signOutUser: Firebase signOut successful. onAuthStateChanged will reset state.");
      toast({ title: "Signed Out", description: "You have been signed out." });
    } catch (error: any) {
      hookDebugLog(`signOutUser: Error during Firebase signOut: ${error.message}`);
      console.error("Sign Out error:", error);
      setAuthState(prev => ({ ...prev, error, loading: false, profileLoading: false })); 
      toast({ 
        title: "Sign Out Error", 
        description: error.message, 
        variant: "destructive" 
      });
    }
  };

  const updateUserProfile = useCallback(async (profileData: UserProfile): Promise<void> => {
    if (!authState.currentUser) {
      hookDebugLog("updateUserProfile: No current user to update profile for.");
      toast({ 
        title: "Error", 
        description: "You must be signed in to update your profile.", 
        variant: "destructive" 
      });
      throw new Error("User not authenticated");
    }
    
    const userId = authState.currentUser.uid;
    hookDebugLog(`updateUserProfile: Updating profile for ${userId}`);
    setAuthState(prev => ({ ...prev, profileLoading: true }));
    
    try {
      const currentProfile = authState.userProfile || {} as UserProfile;
      const dataToSave: UserProfile = {
        ...currentProfile, 
        ...profileData,   
        id: userId,       
        email: authState.currentUser.email || currentProfile.email, 
        photoUrl: authState.currentUser.photoURL || currentProfile.photoUrl || `https://placehold.co/96x96.png?text=${(profileData.name || 'U').charAt(0).toUpperCase()}`,
        lastLogin: new Date().toISOString(), 
      };

      if (!dataToSave.name) throw new Error("Name is required.");
      if (!dataToSave.birthdate) throw new Error("Birthdate is required.");
      if (!dataToSave.sex) throw new Error("Sex is required.");
      if (!dataToSave.sexualOrientation) throw new Error("Sexual orientation is required.");
      
      await set(ref(db, `users/${userId}`), dataToSave);
      
      setAuthState(prev => ({ 
        ...prev, 
        userProfile: dataToSave, 
        isProfileSetupNeeded: !dataToSave.birthdate || !dataToSave.sex || !dataToSave.sexualOrientation, 
        profileLoading: false 
      }));
      
      hookDebugLog(`updateUserProfile: Profile updated successfully for ${userId}`);
      toast({ title: "Profile Updated", description: "Your profile has been saved." });
    } catch (error: any) {
      hookDebugLog(`updateUserProfile: Error updating profile for ${userId}: ${error.message}`);
      console.error("Error updating user profile:", error);
      setAuthState(prev => ({ ...prev, profileLoading: false })); 
      toast({ 
        title: "Profile Update Error", 
        description: error.message, 
        variant: "destructive" 
      });
      throw error; 
    }
  }, [authState.currentUser, authState.userProfile, toast]);

  return { 
    ...authState, 
    signInWithGoogle, 
    signOutUser, 
    updateUserProfile 
  };
}

