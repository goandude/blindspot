
"use client";
import { useState, useEffect, useCallback } from 'react';
import { auth, db, googleProvider } from '@/lib/firebase';
import { onAuthStateChanged, signInWithRedirect, signOut, type User as FirebaseUser } from 'firebase/auth';
import { ref, set, onValue, off, remove, serverTimestamp, get } from 'firebase/database';
import type { UserProfile } from '@/types';
import { useToast } from '@/hooks/use-toast';

interface AuthState {
  currentUser: FirebaseUser | null;
  userProfile: UserProfile | null; // Profile from RTDB for authenticated user
  loading: boolean; // Overall auth process loading
  error: Error | null;
}

const initialAuthState: AuthState = {
  currentUser: null,
  userProfile: null,
  loading: true,
  error: null,
};

// Internal logger for this hook
const hookDebugLog = (message: string) => {
  const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 });
  console.log(`[useAuth DEBUG] ${timestamp} - ${message}`);
};

export function useAuth() {
  const [authState, setAuthState] = useState<AuthState>(initialAuthState);
  const { toast } = useToast();

  const fetchUserProfile = useCallback(async (userId: string): Promise<UserProfile | null> => {
    hookDebugLog(`Fetching profile for user: ${userId}`);
    try {
      const userRef = ref(db, `users/${userId}`);
      const snapshot = await get(userRef);
      if (snapshot.exists()) {
        hookDebugLog(`Profile found for ${userId}`);
        return snapshot.val() as UserProfile;
      }
      hookDebugLog(`No profile found for ${userId}, will attempt creation.`);
      return null;
    } catch (error: any) {
      hookDebugLog(`Error fetching profile for ${userId}: ${error.message}`);
      console.error("Error fetching user profile:", error);
      // Do not set authState error here directly, let onAuthStateChanged handle final state
      return null;
    }
  }, []);

  const createUserProfileInDb = useCallback(async (firebaseUser: FirebaseUser, countryCode: string): Promise<UserProfile> => {
    hookDebugLog(`Creating DB profile for new Google user: ${firebaseUser.uid}`);
    const newUserProfile: UserProfile = {
      id: firebaseUser.uid,
      name: firebaseUser.displayName || `Google User ${firebaseUser.uid.substring(0, 4)}`,
      email: firebaseUser.email || undefined,
      photoUrl: firebaseUser.photoURL || `https://placehold.co/96x96.png?text=${(firebaseUser.displayName || 'G').charAt(0).toUpperCase()}`,
      countryCode: countryCode,
      createdAt: serverTimestamp(),
      lastLogin: serverTimestamp(),
    };
    try {
      await set(ref(db, `users/${firebaseUser.uid}`), newUserProfile);
      hookDebugLog(`DB Profile created for ${firebaseUser.uid}`);
      return newUserProfile;
    } catch (error: any) {
      hookDebugLog(`Error creating DB profile for ${firebaseUser.uid}: ${error.message}`);
      console.error("Error creating user profile in DB:", error);
      throw error;
    }
  }, []);

  // Effect for Firebase Auth state changes
  useEffect(() => {
    hookDebugLog("Setting up onAuthStateChanged listener.");
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      hookDebugLog(`onAuthStateChanged triggered. User UID: ${user ? user.uid : 'null'}`);
      if (user) {
        // User is signed in (or redirect result has come back)
        setAuthState(prev => ({ ...prev, currentUser: user, loading: true, error: null })); // Set loading true while fetching/creating profile
        
        let profile = await fetchUserProfile(user.uid);

        if (!profile) {
          hookDebugLog(`No profile exists for Google user ${user.uid}. Attempting to create one.`);
          try {
            let countryCode = 'XX';
            try {
                const response = await fetch('https://ipapi.co/country_code/');
                if (response.ok) countryCode = (await response.text()).trim();
                else hookDebugLog(`Failed to fetch country code for Google user: ${response.status}`);
            } catch (e: any) { hookDebugLog(`Error fetching country for Google user: ${e.message || e}`);}

            profile = await createUserProfileInDb(user, countryCode);
            toast({ title: "Profile Created", description: "Your basic profile has been set up."});
          } catch (creationError: any) {
            hookDebugLog(`Failed to create profile for Google user ${user.uid}: ${creationError.message}. User will remain logged in but without a DB profile.`);
            setAuthState(prev => ({ ...prev, currentUser: user, userProfile: null, loading: false, error: creationError }));
            return; 
          }
        } else {
           try {
             await set(ref(db, `users/${user.uid}/lastLogin`), serverTimestamp());
             hookDebugLog(`Updated lastLogin for ${user.uid}`);
           } catch (updateError: any) {
             hookDebugLog(`Failed to update lastLogin for ${user.uid}: ${updateError.message}`);
           }
        }
        setAuthState(prev => ({ ...prev, currentUser: user, userProfile: profile, loading: false }));
      } else {
        // User is signed out
        hookDebugLog("No user found by onAuthStateChanged (signed out or initial check). Resetting auth state.");
        setAuthState({ currentUser: null, userProfile: null, loading: false, error: null });
      }
    }, (error) => {
      hookDebugLog(`Auth listener error: ${error.message}`);
      console.error("Auth listener error:", error);
      setAuthState({ currentUser: null, userProfile: null, loading: false, error });
    });

    return () => {
      hookDebugLog("Cleaning up onAuthStateChanged listener.");
      unsubscribe();
    };
  }, [fetchUserProfile, createUserProfileInDb, toast]);


  // Effect for managing presence of AUTHENTICATED users
  useEffect(() => {
    if (!authState.currentUser || !authState.userProfile) {
      hookDebugLog("Presence: No currentUser or userProfile for authenticated presence. Skipping.");
      return;
    }
    const userId = authState.currentUser.uid;
    const userProfileData = authState.userProfile; // Use profile from authState
    hookDebugLog(`Presence: Setting up for authenticated user ${userId} (${userProfileData.name})`);

    const userStatusRef = ref(db, `onlineUsers/${userId}`);
    const connectedRef = ref(db, '.info/connected');
    let connectedListener: any = null; // To store the callback for removal

    const presenceConnectionCallback = (snapshot: any) => {
      if (snapshot.val() === true) {
        hookDebugLog(`Presence: Firebase connection established for auth user ${userId}.`);
        const presenceData = {
          id: userId,
          name: userProfileData.name || `Google User ${userId.substring(0,4)}`,
          photoUrl: userProfileData.photoUrl || `https://placehold.co/96x96.png?text=${(userProfileData.name || 'G').charAt(0).toUpperCase()}`,
          countryCode: userProfileData.countryCode || 'XX',
          isGoogleUser: true,
          timestamp: serverTimestamp(),
        };
        set(userStatusRef, presenceData)
          .then(() => {
            hookDebugLog(`Presence: Set online for auth user ${userId}.`);
            onDisconnect(userStatusRef).remove().catch(e => hookDebugLog(`Presence: ERROR setting onDisconnect for auth user ${userId}: ${e.message || e}`));
          })
          .catch(e => hookDebugLog(`Presence: ERROR setting presence for auth user ${userId}: ${e.message || e}`));
      } else {
        hookDebugLog(`Presence: Firebase connection lost for auth user ${userId}.`);
        // Note: onDisconnect should handle removal if connection is truly lost.
        // If this 'else' block is hit due to brief blips, explicit removal here might be too aggressive.
      }
    };
    
    connectedListener = onValue(connectedRef, presenceConnectionCallback);
    hookDebugLog(`Presence: Attached listener to .info/connected for auth user ${userId}`);

    return () => {
      hookDebugLog(`Presence: Cleaning up for auth user ${userId}.`);
      if (connectedListener && connectedRef) {
        off(connectedRef, 'value', presenceConnectionCallback); // Use the specific callback instance
        hookDebugLog(`Presence: Detached .info/connected listener for auth user ${userId}`);
      }
      if (userStatusRef) { // Ensure ref exists before trying to remove
        // Let onDisconnect handle it mostly, but can do a final explicit remove if needed
        // This might be redundant if onDisconnect is reliable.
        remove(userStatusRef).catch(e => hookDebugLog(`Presence: WARN: Error removing auth user ${userId} from onlineUsers on auth presence cleanup: ${e.message || e}`));
      }
    };
  }, [authState.currentUser, authState.userProfile]);


  const signInWithGoogle = async () => {
    hookDebugLog("Attempting Google Sign-In with redirect.");
    setAuthState(prev => ({ ...prev, loading: true, error: null }));
    try {
      await signInWithRedirect(auth, googleProvider);
      // onAuthStateChanged will handle the user state after redirect.
    } catch (error: any) {
      hookDebugLog(`Google Sign-In error: ${error.message}`);
      console.error("Google Sign-In error:", error);
      setAuthState(prev => ({ ...prev, loading: false, error }));
      toast({ title: "Sign-In Error", description: error.message, variant: "destructive" });
    }
  };

  const signOutUser = async () => {
    hookDebugLog("Attempting Sign Out.");
    const currentUserId = authState.currentUser?.uid;
    
    if (currentUserId) {
      // Remove user from onlineUsers before signing out
      const userStatusRef = ref(db, `onlineUsers/${currentUserId}`);
      try {
        await remove(userStatusRef);
        hookDebugLog(`Presence: Removed auth user ${currentUserId} from onlineUsers before sign out.`);
      } catch (error: any) {
        hookDebugLog(`Presence: WARN: Failed to remove auth user ${currentUserId} from onlineUsers during sign out: ${error.message}`);
      }
    }

    try {
      await signOut(auth);
      hookDebugLog("Sign Out successful. Auth state will be updated by onAuthStateChanged.");
      toast({ title: "Signed Out", description: "You have been signed out." });
    } catch (error: any) {
      hookDebugLog(`Sign Out error: ${error.message}`);
      console.error("Sign Out error:", error);
      // Keep current user data until onAuthStateChanged confirms sign-out to avoid UI flicker
      setAuthState(prev => ({ ...prev, error, loading: false })); 
      toast({ title: "Sign Out Error", description: error.message, variant: "destructive" });
    }
  };

  return { ...authState, signInWithGoogle, signOutUser };
}
