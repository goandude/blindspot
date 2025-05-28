
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
  loading: boolean; // Overall auth process loading (includes redirect check)
  profileLoading: boolean; // Specific to fetching/creating profile after user is confirmed
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

// Internal logger for the hook
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
  const isPageVisibleRef = useRef<boolean>(true); // Track page visibility

  const fetchUserProfile = useCallback(async (userId: string): Promise<UserProfile | null> => {
    hookDebugLog(`fetchUserProfile: Attempting to fetch profile for user: ${userId}`);
    try {
      const userRef = ref(db, `users/${userId}`);
      const snapshot = await get(userRef);
      if (snapshot.exists()) {
        const profile = snapshot.val() as UserProfile;
        hookDebugLog(`fetchUserProfile: Profile found for ${userId}`); // Removed PII
        return profile;
      }
      hookDebugLog(`fetchUserProfile: No profile found for ${userId}.`);
      return null;
    } catch (error: any) {
      hookDebugLog(`fetchUserProfile: Error fetching profile for ${userId}: ${error.message}`);
      console.error("Error fetching user profile:", error);
      // Error state will be handled by the caller (onAuthStateChanged)
      throw error; // Re-throw to be caught by onAuthStateChanged
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
      createdAt: new Date().toISOString(), // Use ISO string for consistency
      lastLogin: new Date().toISOString(), // Use ISO string
      // birthdate, sex, sexualOrientation will be set during profile setup
    };
    try {
      await set(ref(db, `users/${firebaseUser.uid}`), newUserProfile);
      hookDebugLog(`createUserProfileInDb: DB Profile created for ${firebaseUser.uid}`);
      return newUserProfile;
    } catch (error: any) {
      hookDebugLog(`createUserProfileInDb: Error creating DB profile for ${firebaseUser.uid}: ${error.message}`);
      console.error("Error creating user profile in DB:", error);
      throw error; // Re-throw
    }
  }, []);

  // Handle redirect result on app load
  useEffect(() => {
    hookDebugLog("Effect: Checking for redirect result on app load");
    let isMounted = true;

    const handleRedirect = async () => {
        try {
            const result = await getRedirectResult(auth);
            if (result && isMounted) {
                hookDebugLog(`Redirect result processed: User ${result.user.uid}. onAuthStateChanged will now handle.`);
                // The onAuthStateChanged listener is the primary handler for user state.
                // This effect mainly ensures getRedirectResult is called.
            } else if (isMounted) {
                hookDebugLog("No redirect result found, or component unmounted.");
                // If no redirect result, onAuthStateChanged will still run and determine if a user is already logged in.
                // If it's truly the first load without a redirect, onAuthStateChanged might initially report null,
                // then loading will be set to false.
                 setAuthState(prev => ({ ...prev, loading: false })); // Ensure loading becomes false if no redirect
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


  // Effect for Firebase Auth state changes
  useEffect(() => {
    hookDebugLog("Effect: Setting up onAuthStateChanged listener.");
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      hookDebugLog(`onAuthStateChanged triggered. User UID: ${user ? user.uid : 'null'}`);

      if (user) {
        setAuthState(prev => ({
          ...prev,
          currentUser: user,
          profileLoading: true, // Start profile loading
          loading: true, // Overall auth process is still loading until profile is checked
          error: null
        }));

        try {
          let profile = await fetchUserProfile(user.uid);
          let needsSetup = false;

          if (profile) {
            hookDebugLog(`Profile exists for ${user.uid}. Updating lastLogin.`);
            await set(ref(db, `users/${user.uid}/lastLogin`), new Date().toISOString());
            needsSetup = !profile.birthdate || !profile.sex || !profile.sexualOrientation; // Check if essential fields are missing
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
            needsSetup = true; // New user always needs setup for birthdate etc.
            hookDebugLog(`New profile created for ${user.uid}. Needs setup: ${needsSetup}`);
          }
          
          setAuthState(prev => ({
            ...prev,
            userProfile: profile,
            isProfileSetupNeeded: needsSetup,
            profileLoading: false, // Profile check done
            loading: false, // Auth process complete
          }));

        } catch (profileError: any) {
          hookDebugLog(`Error during profile processing for ${user.uid}: ${profileError.message}`);
          setAuthState(prev => ({
            ...prev,
            userProfile: null,
            isProfileSetupNeeded: false, // Can't determine setup needs if profile fetch fails
            profileLoading: false,
            loading: false, // Auth process complete even with error
            error: profileError,
          }));
        }
      } else {
        // No user is signed in
        hookDebugLog("No user found by onAuthStateChanged. Resetting auth state.");
        setAuthState({
          currentUser: null,
          userProfile: null,
          loading: false, // Auth process complete, no user
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
  }, [fetchUserProfile, createUserProfileInDb, toast]); // addDebugLog removed

  // Presence for AUTHENTICATED users
  useEffect(() => {
    if (!authState.currentUser || !authState.userProfile) {
      hookDebugLog("Auth Presence: No currentUser or userProfile. Skipping presence setup.");
      return;
    }

    const userId = authState.currentUser.uid;
    // Ensure all necessary fields for OnlineUser are present in authState.userProfile
    const userForPresence: OnlineUser = {
      id: userId,
      name: authState.userProfile.name || `User-${userId.substring(0,4)}`,
      photoUrl: authState.userProfile.photoUrl,
      dataAiHint: authState.userProfile.dataAiHint,
      countryCode: authState.userProfile.countryCode || 'XX',
      isGoogleUser: true, // This is an authenticated user
    };

    hookDebugLog(`Auth Presence: Setting up for authenticated user ${userId}. Page visible: ${isPageVisibleRef.current}`);

    const userStatusRef: DatabaseReference = ref(db, `onlineUsers/${userId}`);
    const connectedRef = ref(db, '.info/connected');
    
    const presenceConnectionCallback = (snapshot: any) => {
      if (authState.currentUser?.uid !== userId) { // Stale closure check
          hookDebugLog(`Auth Presence for ${userId}: Skipping update due to stale closure or user change. Current auth user: ${authState.currentUser?.uid}`);
          return;
      }
      if (snapshot.val() === true) {
        hookDebugLog(`Auth Presence: Connected for user ${userId}. Page visible: ${isPageVisibleRef.current}`);
        if (isPageVisibleRef.current) { // Only set online if page is visible
            const presenceData: OnlineUser = {
              ...userForPresence,
              timestamp: serverTimestamp(),
            };
            set(userStatusRef, presenceData)
              .then(() => hookDebugLog(`Auth Presence: Set online for user ${userId}`))
              .catch(e => hookDebugLog(`Auth Presence: Error setting online for ${userId}: ${e.message}`));
        }
        // Set up onDisconnect immediately upon connection
        userStatusRef.onDisconnect().remove()
          .then(() => hookDebugLog(`Auth Presence: onDisconnect set for user ${userId}`))
          .catch(e => hookDebugLog(`Auth Presence: Error setting onDisconnect for ${userId}: ${e.message}`));
      } else {
        hookDebugLog(`Auth Presence: Firebase connection lost for ${userId}.`);
        // onDisconnect should handle removal, but if desired, could also remove explicitly here.
        // For now, rely on onDisconnect and visibility changes.
      }
    };
    
    onValue(connectedRef, presenceConnectionCallback);
    hookDebugLog(`Auth Presence: Attached listener to .info/connected for user ${userId}`);

    // Handle page visibility for authenticated users
    const handleVisibilityChange = () => {
      if (authState.currentUser?.uid !== userId) return; // Stale closure or user changed

      const userOnlinePath = `onlineUsers/${userId}`;
      if (document.hidden) {
        hookDebugLog(`Auth Presence: Page hidden. Removing ${userId} from online list.`);
        isPageVisibleRef.current = false;
        remove(ref(db, userOnlinePath)).catch(e => hookDebugLog(`Auth Presence: Error removing user ${userId} on page hide: ${e.message}`));
      } else {
        hookDebugLog(`Auth Presence: Page visible. Re-adding ${userId} to online list.`);
        isPageVisibleRef.current = true;
        const presenceData: OnlineUser = {
          ...userForPresence, // Use up-to-date userForPresence
          timestamp: serverTimestamp(),
        };
        set(ref(db, userOnlinePath), presenceData).catch(e => hookDebugLog(`Auth Presence: Error re-adding user ${userId} on page visible: ${e.message}`));
        // Re-establish onDisconnect
        ref(db, userOnlinePath).onDisconnect().remove()
            .then(() => hookDebugLog(`Auth Presence: onDisconnect re-set for ${userId} on page visible.`))
            .catch(e => hookDebugLog(`Auth Presence: ERROR re-setting onDisconnect for ${userId} on page visible: ${e.message}`));

      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handleVisibilityChange); // For mobile
    window.addEventListener('pageshow', handleVisibilityChange); // For mobile

    return () => {
      hookDebugLog(`Auth Presence: Cleaning up for user ${userId}. Detaching .info/connected listener.`);
      off(connectedRef, 'value', presenceConnectionCallback);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleVisibilityChange);
      window.removeEventListener('pageshow', handleVisibilityChange);
      // Deliberate: Do not remove user from onlineUsers here on component unmount if they are still authenticated.
      // onDisconnect or explicit sign-out should handle it.
      // If the hook unmounts but user is still auth'd (e.g. navigating to another part of a larger app),
      // they might still want to appear online.
    };
  }, [authState.currentUser, authState.userProfile, toast]); // Re-run if currentUser or userProfile changes

  const signInWithGoogle = async () => {
    hookDebugLog("signInWithGoogle: Starting Google Sign-In process.");
    // Set loading state immediately before redirect
    setAuthState(prev => ({ 
      ...prev, 
      loading: true, 
      profileLoading: false, // Reset profile loading
      error: null 
    }));
    
    try {
      await signInWithRedirect(auth, googleProvider);
      hookDebugLog("signInWithGoogle: Redirect initiated. Waiting for page reload and onAuthStateChanged.");
      // After redirect, onAuthStateChanged will handle user detection and profile logic.
    } catch (error: any) {
      hookDebugLog(`signInWithGoogle: Error during redirect initiation: ${error.message}`);
      console.error("Google Sign-In error:", error);
      setAuthState(prev => ({ ...prev, loading: false, error })); // Reset loading on error
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
        // Explicitly remove user from online list before signing out
        // This is quicker than waiting for onDisconnect
        await remove(userStatusRef);
        hookDebugLog(`signOutUser: Removed user ${currentUserId} from onlineUsers.`);
      } catch (error: any) {
        hookDebugLog(`signOutUser: Error removing presence for ${currentUserId}: ${error.message}`);
        // Continue with sign out even if presence removal fails
      }
    }

    try {
      await signOut(auth);
      hookDebugLog("signOutUser: Firebase signOut successful. onAuthStateChanged will reset state.");
      toast({ title: "Signed Out", description: "You have been signed out." });
      // onAuthStateChanged will handle setting currentUser to null and resetting userProfile etc.
    } catch (error: any) {
      hookDebugLog(`signOutUser: Error during Firebase signOut: ${error.message}`);
      console.error("Sign Out error:", error);
      // State should be reset by onAuthStateChanged, but ensure loading is false if error occurs here
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
      // Ensure all required fields are present and merge with existing profile safely
      const currentProfile = authState.userProfile || {} as UserProfile;
      const dataToSave: UserProfile = {
        ...currentProfile, // spread existing to preserve fields not in form (e.g. createdAt)
        ...profileData,   // spread new data from form
        id: userId,       // ensure ID is correct
        email: authState.currentUser.email || currentProfile.email, // ensure email from auth is prioritized
        photoUrl: authState.currentUser.photoURL || currentProfile.photoUrl || `https://placehold.co/96x96.png?text=${(profileData.name || 'U').charAt(0).toUpperCase()}`,
        lastLogin: new Date().toISOString(), // Update lastLogin timestamp
      };

      if (!dataToSave.name) throw new Error("Name is required.");
      if (!dataToSave.birthdate) throw new Error("Birthdate is required.");
      if (!dataToSave.sex) throw new Error("Sex is required.");
      if (!dataToSave.sexualOrientation) throw new Error("Sexual orientation is required.");
      
      await set(ref(db, `users/${userId}`), dataToSave);
      
      // After successful save, update local state
      setAuthState(prev => ({ 
        ...prev, 
        userProfile: dataToSave, 
        isProfileSetupNeeded: !dataToSave.birthdate || !dataToSave.sex || !dataToSave.sexualOrientation, // Re-evaluate if setup is needed
        profileLoading: false 
      }));
      
      hookDebugLog(`updateUserProfile: Profile updated successfully for ${userId}`);
      toast({ title: "Profile Updated", description: "Your profile has been saved." });
    } catch (error: any) {
      hookDebugLog(`updateUserProfile: Error updating profile for ${userId}: ${error.message}`);
      console.error("Error updating user profile:", error);
      setAuthState(prev => ({ ...prev, profileLoading: false })); // Reset loading on error
      toast({ 
        title: "Profile Update Error", 
        description: error.message, 
        variant: "destructive" 
      });
      throw error; // Re-throw for the form to handle
    }
  }, [authState.currentUser, authState.userProfile, toast]);

  return { 
    ...authState, 
    signInWithGoogle, 
    signOutUser, 
    updateUserProfile 
  };
}

